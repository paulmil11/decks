#!/usr/bin/env python3
"""Decks server.

Serves every deck at one fixed local address, keeps each reviewer's edits and
comments on disk (next to the deck, in .slidebuilder/), and gives the agent
(Claude Code, Codex, or anything that can run `sb`) a small JSON API for reading
comments and posting replies.

    python3 server.py                 port and decks folder from sbconfig.py
    python3 server.py --port 8799

Decks are listed in decks.json in the decks folder (re-read on every request, so
edits apply without a restart). The first start creates it with one demo deck.
Nothing in a deck file is changed: the server adds a boot script when it serves a
deck page, and that script removes itself before the builder runs, so "Save a
copy" still produces a clean file to send.
"""
import argparse
import json
import mimetypes
import os
import re
import secrets
import shutil
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

import newdeck
import sbconfig

APP = Path(__file__).resolve().parent
STATIC = APP / 'static'
LOCK = threading.Lock()
STARTED = time.time()
VERSION = '0.10.3'   # see CHANGELOG.md
UPDATE_REPO = 'paulmil11/decks'   # where new versions are released (a fork points this at its own)
LATEST = {}   # the newest release, from GitHub every few hours (sbconfig.CHECK_UPDATES)
CHECK_EVERY = 6 * 3600   # seconds between checks that worked
RETRY_AFTER = 10 * 60    # after one that didn't: offline, or the network wasn't up yet at login


# ---------- decks and files ----------

def load_registry():
    reg = read_json(sbconfig.REGISTRY, {'decks': []})
    for d in reg['decks']:
        d['path'] = Path(os.path.expanduser(d['folder'])).resolve()
    return reg


def find_deck(slug):
    for d in load_registry()['decks']:
        if d['slug'] == slug:
            return d
    return None


def visible_deck(slug):
    """A deck the page may see: with Client work hidden, client decks don't exist (live on camera)."""
    d = find_deck(slug)
    return None if d and d.get('client') and settings().get('hideClients') else d


def sb_dir(deck):
    p = deck['path'] / '.slidebuilder'
    p.mkdir(exist_ok=True)
    return p


def read_json(path, default):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def write_json(path, data):
    tmp = path.with_suffix(path.suffix + '.tmp')
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def mtime(path):
    try:
        return path.stat().st_mtime
    except FileNotFoundError:
        return 0


# ---------- small caches: the dashboard asks every 5 seconds, the files rarely change ----------

_memo = {}
_memo_lock = threading.Lock()


def memo(name, deck, sig, fn):
    """fn() again only when sig (file times) changes, per deck."""
    key = (name, deck['slug'])
    with _memo_lock:
        hit = _memo.get(key)
    if hit and hit[0] == sig:
        return hit[1]
    val = fn()
    with _memo_lock:
        _memo[key] = (sig, val)
    return val


def entry_time(deck):
    return mtime(deck['path'] / deck['entry'])


def settings():
    return read_json(sbconfig.SETTINGS, {'hideClients': False})


def empty_review():
    return {'comments': {}, 'replies': {}, 'history': [], 'changed': {}, 'rounds': [], 'claude': None, 'proposals': {}}


# ---------- what the dashboard and Claude need to know ----------

SAVES = {}   # slug -> the last save: when, and which tab made it (so other tabs know to catch up)
WATCH = {}   # slug -> the last moment an agent was waiting on the deck (sb watch)
ASKED = {}   # slug -> a "Process now" click no agent has picked up yet


WATCH_ALL = [0]   # the last moment an agent was waiting on every deck at once (sb watch, no deck named)


def watching(slug):
    # sb watch asks again every 25 s; a round in between doesn't count as leaving
    return time.time() - max(WATCH.get(slug, 0), WATCH_ALL[0]) < 75


def wait_for_click(slug=None, secs=25):
    """sb watch: wait for a Process now click on one deck (slug) or on any deck, then answer either way."""
    end = time.time() + secs
    while True:
        if slug:
            WATCH[slug] = time.time()
            req = ASKED.pop(slug, None)
            if req:
                return dict(req, deck=slug)
        else:
            WATCH_ALL[0] = time.time()
            if ASKED:
                first = min(ASKED, key=lambda k: ASKED[k]['at'])
                return dict(ASKED.pop(first), deck=first)
        if time.time() >= end:
            return None
        time.sleep(0.4)






def merge3(base, mine, theirs):
    """Keep what another tab saved and apply only what this tab changed since it loaded (base)."""
    if not (isinstance(base, dict) and isinstance(mine, dict) and isinstance(theirs, dict)):
        return mine
    out = dict(theirs)
    for k in set(base) | set(mine):
        if k in mine and mine.get(k) == base.get(k) and k in base:
            continue                                   # this tab left it alone
        if k not in mine:
            out.pop(k, None)                           # this tab deleted it
        elif k in theirs and k in base:
            out[k] = merge3(base[k], mine[k], theirs[k])
        else:
            out[k] = mine[k]
    return out


def merge_saved(base, mine, theirs):
    """Three-way merge of one saved key (JSON text); anything that is not a JSON object: this tab wins."""
    try:
        b, m, t = (json.loads(x) if x is not None else {} for x in (base, mine, theirs))
    except (TypeError, json.JSONDecodeError):
        return mine
    if not (isinstance(b, dict) and isinstance(m, dict) and isinstance(t, dict)):
        return mine
    return json.dumps(merge3(b, m, t), ensure_ascii=False, separators=(',', ':'))


def pulse_of(deck):
    sb = sb_dir(deck)
    return {'file': mtime(deck['path'] / deck['entry']), 'review': mtime(sb / 'review.json'),
            'state': mtime(sb / 'state.json'), 'shell': static_version(), 'saved': SAVES.get(deck['slug']),
            'watching': watching(deck['slug']), 'asked': deck['slug'] in ASKED, 'update': update_info()}


def comments_from_state(state):
    """Every non-empty comment in a deck's saved state: {slide: [{key, text}]}.

    Decks keep comments in <prefix>ws_<version>.__fb (older builders used other
    key names). Any saved JSON object with __fb counts.
    """
    out = {}
    for key, raw in (state.get('keys') or {}).items():
        if 'backup' in key:   # saved snapshots, not live comments
            continue
        try:
            val = json.loads(raw)
        except (TypeError, json.JSONDecodeError):
            continue
        fb = val.get('__fb') if isinstance(val, dict) else None
        if not isinstance(fb, dict):
            continue
        for slide, text in fb.items():
            if isinstance(text, str) and text.strip():
                out.setdefault(slide, []).append({'key': key, 'text': text.strip()})
    return out


def open_comments(deck):
    """Comments Claude still has to act on, merged with their review status."""
    d = sb_dir(deck)
    return memo('open', deck, (entry_time(deck), mtime(d / 'state.json'), mtime(d / 'review.json')), lambda: _open_comments(deck))


def _open_comments(deck):
    state = read_json(sb_dir(deck) / 'state.json', {'keys': {}})
    review = read_json(sb_dir(deck) / 'review.json', empty_review())
    done = set(deck_done_list(deck))
    rows = []
    for slide, items in comments_from_state(state).items():
        for it in items:
            text = it['text']
            if text in done or f'{slide}::{text}' in done:
                continue
            meta = review['comments'].get(slide, {})
            reply = review['replies'].get(slide)
            if reply and reply.get('forText') != text:
                reply = None  # the comment changed after Claude replied
            rows.append({
                'slide': slide, 'key': it['key'], 'text': text,
                'state': meta.get('state', 'ready') if meta.get('text') == text or meta.get('follow') else 'ready',   # a held comment stays held while you keep typing
                'reply': reply,
            })
    return rows


def deck_done_list(deck):
    """DONE_FB entries baked into the deck file (comments already handled)."""
    return memo('done', deck, entry_time(deck), lambda: _deck_done_list(deck))


def _deck_done_list(deck):
    try:
        src = (deck['path'] / deck['entry']).read_text(encoding='utf-8')
    except FileNotFoundError:
        return []
    m = re.search(r'^const DONE_FB = (\[.*\]);\s*$', src, re.M)
    if not m:
        return []
    try:
        return json.loads(m.group(1))
    except json.JSONDecodeError:
        return []


def latest_export(deck):
    pdfs = sorted(deck['path'].glob('*.pdf'), key=lambda p: p.stat().st_mtime, reverse=True)
    if not pdfs:
        return None
    p = pdfs[0]
    return {'name': p.name, 'url': f"/d/{deck['slug']}/{p.name}", 'at': p.stat().st_mtime}


def git_info(deck):
    """Last commit and whether the folder has changes. git is slow enough (about 40 ms a deck) to stall
    the dashboard, so it's asked again only when the deck file, the repo's commits, or its index move,
    and every two minutes regardless."""
    g = _git_dir(deck['path'])
    sig = (entry_time(deck), mtime(g / 'HEAD'), mtime(g / 'logs' / 'HEAD'), mtime(g / 'index'), int(time.time() // 120)) if g else int(time.time() // 120)
    return memo('git', deck, sig, lambda: _git_info(deck))


_git_dirs = {}


def _git_dir(path):
    """The .git folder that holds a deck's folder: its own, or a parent's (pitch decks live in the website repo)."""
    if path not in _git_dirs:
        p = path
        while p != p.parent and not (p / '.git').is_dir():
            p = p.parent
        _git_dirs[path] = (p / '.git') if (p / '.git').is_dir() else None
    return _git_dirs[path]


def _git_info(deck):
    try:
        out = subprocess.run(['git', '-C', str(deck['path']), 'log', '-1', '--format=%ct%x09%s'],
                             capture_output=True, text=True, timeout=5)
        if out.returncode == 0 and out.stdout.strip():
            ts, msg = out.stdout.strip().split('\t', 1)
            dirty = subprocess.run(['git', '-C', str(deck['path']), 'status', '--porcelain'],
                                   capture_output=True, text=True, timeout=5).stdout.strip()
            return {'at': float(ts), 'message': msg, 'uncommitted': bool(dirty)}
    except (OSError, subprocess.SubprocessError, ValueError):
        pass
    return None


def slide_count(deck):
    """Slides in the default version, read from the file without running it."""
    return memo('count', deck, entry_time(deck), lambda: _slide_count(deck))


def _slide_count(deck):
    try:
        src = (deck['path'] / deck['entry']).read_text(encoding='utf-8')
    except FileNotFoundError:
        return None
    i = src.find('const LIBRARY = {')
    if i < 0:
        return None
    lib = src[i:src.find('\n};', i)]
    starts = [m.start() for m in re.finditer(r"^  '[a-z0-9-]+'\s*:", lib, re.M)] + [len(lib)]
    n = 0
    for a, b in zip(starts, starts[1:]):
        entry = re.sub(r"notes\s*:\s*'(?:[^'\\]|\\.)*'", '', lib[a:b])   # notes can mention anything
        if not re.search(r'\b(?:alt|fac)\s*:\s*true', entry):
            n += 1
    return n or None


def versions(deck):
    """The deck's versions (workshop cuts or pitches), from its PITCHES table."""
    return [dict(v) for v in memo('versions', deck, entry_time(deck), lambda: _versions(deck))]   # copies: callers add counts


def _versions(deck):
    try:
        src = (deck['path'] / deck['entry']).read_text(encoding='utf-8')
    except FileNotFoundError:
        return []
    i = src.find('const PITCHES = {')
    if i < 0:
        return []
    block = src[i:src.find('\n};', i)]
    out = []
    for m in re.finditer(r"^\s{2}([a-z0-9_]+)\s*:\s*\{\s*name\s*:\s*'([^']+)'\s*,\s*blocks\s*:\s*(\[[^\]]*\]|[^,}\n]+)", block, re.M | re.S):
        blocks = m.group(3)
        n = len(re.findall(r"'[a-z0-9-]+'", blocks)) if blocks.startswith('[') else None
        out.append({'key': m.group(1), 'name': m.group(2).replace(' — ', ': '), 'slides': n,
                    'client': m.group(1) in deck.get('clientVersions', []),
                    'url': f"/d/{deck['slug']}/{deck['entry']}#v={m.group(1)}"})
    return out


def deck_summary(deck):
    review = read_json(sb_dir(deck) / 'review.json', empty_review())
    rows = open_comments(deck)
    vers = versions(deck)
    if settings().get('hideClients'):   # recording or streaming: client work never leaves the server
        vers = [v for v in vers if not v['client']]
    for v in vers:   # comments live in one saved key per version: <prefix>..._<version>
        v['open'] = sum(1 for r in rows if r['key'].endswith('_' + v['key']) and (not r['reply'] or r['reply'].get('status') not in ('done', 'skipped')))
    return {
        'slug': deck['slug'], 'name': deck['name'], 'group': deck.get('group', 'active'), 'client': bool(deck.get('client')),
        'kind': deck.get('kind'), 'delivered': deck.get('delivered'), 'hidden': bool(deck.get('hidden')),
        'trashes': (lambda r: str(r).replace(str(Path.home()), '~', 1) if r else None)(newdeck.made_root(deck)),   # what Delete would move to the Trash
        'pieces': deck.get('pieces') or [], 'prompt': deck.get('prompt'),
        'folder': deck['folder'], 'url': f"/d/{deck['slug']}/{deck['entry']}",
        'slides': slide_count(deck),
        'open': sum(1 for r in rows if not r['reply'] or r['reply'].get('status') not in ('done', 'skipped')),
        'questions': sum(1 for r in rows if r['reply'] and r['reply'].get('status') == 'question'),
        'changed': len(review.get('changed') or {}),
        'rounds': (review.get('rounds') or [])[-3:],
        'claude': review.get('claude'),
        'export': latest_export(deck),
        'git': git_info(deck),
        'fileAt': mtime(deck['path'] / deck['entry']),
        'versions': vers,
        'thumb': (lambda t: f"/api/decks/{deck['slug']}/thumb?t={int(t)}" if t else None)(mtime(sb_dir(deck) / 'thumb.png')),   # the picture's own time: a new one is a new address
    }


# ---------- review operations (page and Claude) ----------

def keep_note(r, slide, ch):
    """A slide's changed note, kept in the record of the round that made it (the badge itself goes when it's seen)."""
    for rd in r['rounds']:
        if ch and rd.get('number') == ch.get('round') and ch.get('note'):
            rd.setdefault('notes', {}).setdefault(slide, ch['note'])


def apply_review_op(deck, op):
    path = sb_dir(deck) / 'review.json'
    with LOCK:
        r = read_json(path, empty_review())
        for k, v in empty_review().items():
            r.setdefault(k, v)
        kind, slide, now = op.get('op'), op.get('slide'), time.time()
        if kind == 'comment-state':            # page: draft or ready
            r['comments'][slide] = {'state': op['state'], 'text': op.get('text', ''), 'at': now, 'follow': bool(op.get('follow'))}
        elif kind == 'reply':                  # Claude: done / question / skipped / working
            old = r['replies'].get(slide)
            if old and old.get('status') != 'working' and (old.get('forText') != op.get('forText', '') or old.get('text') != op.get('text', '')):
                r['history'].append({'slide': slide, 'reply': old, 'replaced': now})   # the slide's thread keeps it
            r['replies'][slide] = {'status': op['status'], 'text': op.get('text', ''),
                                   'forText': op.get('forText', ''), 'round': op.get('round'), 'at': now}
        elif kind == 'resolve':                # page: looks good
            rep = r['replies'].pop(slide, None)
            r['comments'].pop(slide, None)
            r['history'].append({'slide': slide, 'reply': rep, 'resolved': now})
        elif kind == 'reopen':                 # page: not done yet
            rep = r['replies'].pop(slide, None)
            r['history'].append({'slide': slide, 'reply': rep, 'reopened': now})
            r['comments'][slide] = {'state': 'ready', 'text': op.get('text', ''), 'at': now}
        elif kind == 'decide':                 # page: accept a proposed slide, keep its original, or undo (decision None)
            if op.get('decision') in ('accept', 'keep'):
                r['proposals'][slide] = {'decision': op['decision'], 'replaces': op.get('replaces', ''), 'version': op.get('version', ''),
                                         'title': op.get('title', ''), 'applied': bool(op.get('applied')), 'at': now}
            elif op.get('decision') is None:
                r['proposals'].pop(slide, None)
            else:
                raise ValueError(f"unknown decision {op.get('decision')!r}")
        elif kind == 'baked':                  # sb proposals --bake: these decisions are in the deck file now
            for s, d in (op.get('decisions') or {}).items():
                r['proposals'][s] = dict(d, baked=now)
        elif kind == 'claude':                 # Claude: live progress line, or null when idle
            r['claude'] = None if op.get('idle') else {'text': op.get('text', ''), 'done': op.get('done'),
                                                       'total': op.get('total'), 'at': now}
        elif kind == 'round':                  # Claude: end of a round
            number = (r['rounds'][-1]['number'] + 1) if r['rounds'] else 1
            baked = {k: v for k, v in r['proposals'].items() if v.get('baked')}   # proposal decisions baked into the deck file since the last round
            rnd = {'number': op.get('number') or number, 'summary': op.get('summary', ''),
                   'export': op.get('export'), 'changed': list((op.get('changed') or {}).keys()), 'at': now}
            if op.get('changed'):
                rnd['notes'] = dict(op['changed'])   # what changed on each slide, kept with the round
            if baked:
                rnd['proposals'] = [{'slide': k, 'decision': v['decision'], 'replaces': v.get('replaces', ''), 'title': v.get('title', ''),
                                     'how': v.get('how', ''), 'at': v.get('at')} for k, v in baked.items()]
                for k in baked:
                    r['proposals'].pop(k)
            for s in op.get('changed') or {}:   # a slide changed again: its earlier note stays with its own round
                keep_note(r, s, r['changed'].get(s))
            r['rounds'].append(rnd)
            r['changed'].update({s: {'note': n, 'round': op.get('number') or number} for s, n in (op.get('changed') or {}).items()})   # earlier unseen changes stay until marked seen
            r['claude'] = None
        elif kind == 'committed':              # sb commit: the round it saves to the deck's git history
            if r['rounds'] and not r['rounds'][-1].get('commit'):
                r['rounds'][-1]['commit'] = op.get('commit', '')
        elif kind == 'seen':                   # page: clear a changed badge (its note stays in its round's record)
            for s in op.get('slides') or ([slide] if slide else []):
                keep_note(r, s, r['changed'].pop(s, None))
        else:
            raise ValueError(f'unknown op {kind!r}')
        write_json(path, r)
        return r


# ---------- "Save a copy": one file that works on its own ----------

IMG_EXT = r'(?:png|jpe?g|gif|svg|webp)'
MIME = {'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'gif': 'image/gif', 'svg': 'image/svg+xml', 'webp': 'image/webp'}
# Runs first in the copy: any picture path the deck uses (in its markup, its styles, or set from code) is
# answered from the pictures embedded below, so the file needs nothing next to it.
ASSET_JS = r"""(function(){var A=window.__SB_ASSETS||{};
function key(u){if(typeof u!=='string'||!u||u.slice(0,5)==='data:')return null;var s=u.split('#')[0].split('?')[0].replace(/^\.\//,'');try{s=decodeURI(s)}catch(e){}return A[s]?s:null}
function fix(u){var k=key(u);return k?A[k]:u}
function css(t){return t&&t.indexOf('url(')>=0?t.replace(/url\((['"]?)([^'")]+)\1\)/g,function(m,q,u){var k=key(u);return k?'url("'+A[k]+'")':m}):t}
var d=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src');
Object.defineProperty(HTMLImageElement.prototype,'src',{configurable:true,enumerable:true,get:function(){return d.get.call(this)},set:function(v){d.set.call(this,fix(String(v)))}});
var sa=Element.prototype.setAttribute;
Element.prototype.setAttribute=function(n,v){var l=String(n).toLowerCase();if(l==='src'||l==='href'||l==='xlink:href'||l==='poster')v=fix(String(v));else if(l==='style')v=css(String(v));return sa.call(this,n,v)};
function scan(el){if(!el||el.nodeType!==1)return;[el].concat([].slice.call(el.querySelectorAll('[src],[href],[style]'))).forEach(function(n){['src','href','xlink:href'].forEach(function(a){var v=n.getAttribute(a);if(v){var f=fix(v);if(f!==v)sa.call(n,a,f)}});var st=n.getAttribute('style');if(st){var c=css(st);if(c!==st)sa.call(n,'style',c)}})}
new MutationObserver(function(ms){ms.forEach(function(m){if(m.type==='attributes')scan(m.target);else m.addedNodes.forEach(scan)})}).observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['src','href','style']});
document.addEventListener('DOMContentLoaded',function(){scan(document.documentElement)});})();"""


def bundle_copy(deck, html, code_paths=True):
    """The deck's own "Save a copy" output, made self-contained: its local scripts inlined and
    every picture it refers to embedded (paths built in code, like img/ct-${n}.jpg, included).
    A review copy names each of its pictures in full, so code_paths=False leaves out the pictures a
    pattern like that would match: they belong to slides the copy doesn't carry."""
    import base64
    root = deck['path'].resolve()

    def inside(rel):
        rel = rel.split('?')[0].split('#')[0]
        if not rel or rel.startswith(('/', 'http:', 'https:', 'data:')) or '..' in rel.split('/'):
            return None
        f = (root / (rel[2:] if rel.startswith('./') else rel)).resolve()
        return f if root in f.parents and f.is_file() else None

    def script(m):
        f = inside(m.group(2))
        if not f or f.suffix.lower() != '.js':
            return m.group(0)
        code = f.read_text(encoding='utf-8').replace('</script', '<\\/script')
        return f'<script{m.group(1)}{m.group(3)}>{code}</script>'
    html = re.sub(r'<script\b([^>]*?)\s+src="([^"]+)"([^>]*)>\s*</script>', script, html)

    found = set()
    # any character a path can't hold ends its name: 'img/a.jpg|img/b.jpg', or href=\"img/a.jpg\" in a figure a review copy writes out
    for rel in re.findall(r'(?<![\w%./-])(?:\./)?([\w%-][\w%./-]*\.' + IMG_EXT + r')(?![\w%./-])', html):
        if inside(rel):
            found.add(rel)
    for pre, post in re.findall(r'`((?:[\w-]+/)*[\w.-]*)\$\{[^}`]*\}([\w.-]*\.' + IMG_EXT + r')`', html) if code_paths else ():
        folder = root / os.path.dirname(pre)
        if pre and folder.is_dir() and (folder.resolve() == root or root in folder.resolve().parents):
            for f in folder.glob(os.path.basename(pre) + '*' + post):
                found.add(str(f.relative_to(root)))
    assets = {}
    for rel in sorted(found):
        f = inside(rel)
        ext = f.suffix.lower().lstrip('.')
        assets[rel] = f'data:{MIME.get(ext, "application/octet-stream")};base64,' + base64.b64encode(f.read_bytes()).decode()
    head = '<script>window.__SB_ASSETS=' + json.dumps(assets).replace('</', '<\\/') + ';' + ASSET_JS + '</script>'
    m = re.search(r'<head[^>]*>', html, re.I)
    html = html[:m.end()] + head + html[m.end():] if m else head + html
    return for_reviewers(html), len(assets)


SAVED_EDITS = re.compile(r'<script id="saved-edits" type="application/json">([\s\S]*?)</script>')
SENT_EDITS = re.compile(r'\n?<script id="saved-edits-base" type="application/json">[\s\S]*?</script>')
OWN_NAME = "(decodeURIComponent(location.pathname.split('/').pop() || '') || 'workshop.html')"
OLD_SAVE_NAME = (("a.download = 'workshop.html';", f'a.download = {OWN_NAME};'),   # decks made before the engine kept the file's name
                 ("'✓ Saved a copy — replace workshop.html with the download'", f"'✓ Saved a copy — replace ' + {OWN_NAME} + ' with the download'"))


def for_reviewers(html):
    """An editable copy, ready to be sent back:
    1. a second copy of its edits block, as it was sent. A reviewer's "Save a copy" rewrites only the
       first, so when the file comes back, sb import can tell their changes from what was already in it.
    2. its own "Save a copy" keeps the file's name, even in decks made before the engine did."""
    m = SAVED_EDITS.search(html)
    if not m:
        return html   # a client copy: no edits, nothing to send back
    html = SENT_EDITS.sub('', html)
    m = SAVED_EDITS.search(html)
    html = html[:m.end()] + '\n<script id="saved-edits-base" type="application/json">' + m.group(1) + '</script>' + html[m.end():]
    for old, new in OLD_SAVE_NAME:
        html = html.replace(old, new, 1)
    return html


# ---------- HTTP ----------

BOOT_TAG = '<script id="sb-boot-data">window.__SB_BOOT={boot};</script><script id="sb-boot" src="/_sb/boot.js?v={v}"></script>'
SHELL_TAG = ('<script id="sb-shell" src="/_sb/shell.js?v={v}" defer></script>'   # styles come from boot.js, before first paint
             '<script id="sb-guides" src="/_sb/guides.js?v={v}" defer></script>'
             '<script id="sb-addslide" src="/_sb/addslide.js?v={v}" defer></script>'
             '<script id="sb-pictures" src="/_sb/pictures.js?v={v}" defer></script>'
             '<script id="sb-clientcopy" src="/_sb/clientcopy.js?v={v}" defer></script>'
             '<script id="sb-reviewcopy" src="/_sb/reviewcopy.js?v={v}" defer></script>')


def static_version():
    return int(max((mtime(p) for p in STATIC.glob('*')), default=0))


def inject(html, deck, page, snap=None):
    state = read_json(sb_dir(deck) / 'state.json', {'keys': {}, 'savedAt': 0})
    st = settings()
    boot = {'slug': deck['slug'], 'name': deck['name'], 'page': page, 'prefixes': deck.get('prefixes', []),
            'state': state, 'entry': deck['entry'], 'folder': deck['folder'], 'app': sbconfig.tilde(APP),
            'hideVersions': deck.get('clientVersions', []) if st.get('hideClients') else [], 'v': static_version(),
            'pulse': snap or pulse_of(deck)}
    boot_json = json.dumps(boot, ensure_ascii=False).replace('</', '<\\/')
    v = static_version()
    head = BOOT_TAG.format(boot=boot_json, v=v)
    m = re.search(r'<head[^>]*>', html, re.I)
    html = html[:m.end()] + head + html[m.end():] if m else head + html
    shell = SHELL_TAG.format(v=v)
    i = html.lower().rfind('</body>')
    return html[:i] + shell + html[i:] if i >= 0 else html + shell


class Handler(BaseHTTPRequestHandler):
    server_version = 'Decks/1.0'

    def log_message(self, fmt, *args):
        p = getattr(self, 'path', '') or ''   # unset when the request line itself was malformed
        if not p.startswith('/api/decks/') or '/pulse' not in p:
            super().log_message(fmt, *args)

    # -- helpers
    def send(self, code, body=b'', ctype='text/plain; charset=utf-8', cache=False, extra=None):
        if isinstance(body, str):
            body = body.encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'max-age=300' if cache else 'no-store, max-age=0')
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def json(self, code, data, extra=None):
        self.send(code, json.dumps(data, ensure_ascii=False), 'application/json; charset=utf-8', extra=extra)

    def pdf(self, slug):
        """Download PDF: the deck as it looks now (saved edits and slide order), one landscape slide per
        page, made by headless Chrome the way sb export makes it. A browser's print window can't promise
        that: its paper size and orientation win over the deck's own page size."""
        deck = visible_deck(slug)
        if not deck:
            return self.json(404, {'error': 'no such deck'})
        version = str((self.body() or {}).get('version') or '')
        if not re.fullmatch(r'[A-Za-z0-9_-]{0,80}', version):
            version = ''
        import tempfile
        with tempfile.TemporaryDirectory() as td:
            out = Path(td) / 'deck.pdf'
            env = dict(os.environ, SB_URL=f'http://localhost:{self.server.server_address[1]}')
            cmd = ['node', str(APP / 'tools' / 'browser.mjs'), 'export', slug, str(out), '--with-edits'] + (['--version', version] if version else [])
            try:
                r = subprocess.run(cmd, capture_output=True, text=True, timeout=300, env=env, cwd=str(APP))
            except (OSError, subprocess.TimeoutExpired) as e:
                return self.json(500, {'error': f'the PDF maker didn’t run ({e.__class__.__name__})'})
            if r.returncode or not out.exists():
                return self.json(500, {'error': 'the PDF maker stopped', 'detail': (r.stderr or r.stdout or '')[-600:]})
            data = out.read_bytes()
        self.send(200, data, 'application/pdf')

    def body(self):
        n = int(self.headers.get('Content-Length') or 0)
        return json.loads(self.rfile.read(n) or b'{}') if n else {}

    def serve_file(self, path, cache=False):
        if not path.is_file():
            return self.send(404, 'Not found')
        ctype = mimetypes.guess_type(path.name)[0] or 'application/octet-stream'
        if ctype.startswith('text/') or ctype in ('application/javascript', 'application/json', 'image/svg+xml'):
            ctype += '; charset=utf-8'
        self.send(200, path.read_bytes(), ctype, cache=cache)

    def upload_source(self):
        """The file for Import a deck, streamed to a folder of its own in <decks>/.incoming: New deck then names it by
        its token, and the deck gets it. Big decks (tens of MB) never pass through JSON."""
        n = int(self.headers.get('Content-Length') or 0)
        name = unquote(self.headers.get('X-File-Name') or '').replace('/', '-').replace('\\', '-').strip(' .')
        if not n or not name:
            return self.json(400, {'error': 'No file came through. Choose it again.'})
        if n > MAX_SOURCE:
            return self.json(413, {'error': f'That file is over {MAX_SOURCE // 1_000_000} MB. Paste its path instead, and the deck copies it from there.'})
        INCOMING.mkdir(parents=True, exist_ok=True)
        for old in INCOMING.iterdir():   # uploads nobody made a deck from
            if time.time() - mtime(old) > 24 * 3600:
                shutil.rmtree(old, ignore_errors=True)
        token = secrets.token_hex(8)
        (INCOMING / token).mkdir()
        left = n
        with open(INCOMING / token / name, 'wb') as f:
            while left:
                chunk = self.rfile.read(min(left, 1 << 20))
                if not chunk:
                    break
                f.write(chunk)
                left -= len(chunk)
        if left:
            shutil.rmtree(INCOMING / token, ignore_errors=True)
            return self.json(400, {'error': 'The upload stopped partway. Try again.'})
        return self.json(200, {'token': token, 'name': name, 'size': n})

    # -- routes
    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        url = urlparse(self.path)
        path, q = unquote(url.path), parse_qs(url.query)
        if path in ('/', '/index.html'):
            return self.serve_file(STATIC / 'dashboard.html')
        if path.startswith('/_sb/'):
            return self.serve_file(STATIC / Path(path[5:]).name)
        if path == '/favicon.ico':
            return self.serve_file(STATIC / 'favicon.svg', cache=True)
        if path == '/api/decks':
            reg, st = load_registry(), settings()
            decks = [d for d in reg['decks'] if not (st.get('hideClients') and d.get('client'))]
            with ThreadPoolExecutor(max_workers=8) as pool:   # git for every deck at once, not one after another
                summaries = list(pool.map(deck_summary, decks))
            return self.json(200, {'decks': summaries, 'started': STARTED, 'port': sbconfig.PORT,
                                   'decksDir': sbconfig.tilde(sbconfig.DECKS), 'settings': st, 'version': VERSION, 'update': update_info()})
        if path == '/api/settings':
            return self.json(200, settings())
        if path == '/api/templates':
            return self.json(200, {'templates': [{k: t.get(k) for k in ('id', 'name', 'description', 'kind', 'folderPrefix')} for t in newdeck.list_templates()],
                                   'themes': newdeck.theme_previews()})
        m = re.match(r'^/api/decks/([a-z0-9-]+)(?:/([a-z-]+))?$', path)
        if m:
            deck = visible_deck(m.group(1))
            if not deck:
                return self.json(404, {'error': 'no such deck'})
            what = m.group(2)
            if what is None:
                return self.json(200, deck_summary(deck))
            if what == 'state':
                return self.json(200, read_json(sb_dir(deck) / 'state.json', {'keys': {}, 'savedAt': 0}))
            if what == 'review':
                return self.json(200, read_json(sb_dir(deck) / 'review.json', empty_review()))
            if what == 'comments':
                return self.json(200, {'comments': open_comments(deck)})
            if what == 'thumb':   # the address carries the picture's time, so the browser can keep it
                return self.serve_file(sb_dir(deck) / 'thumb.png', cache=True)
            if what == 'pulse':
                return self.json(200, pulse_of(deck))
            return self.json(404, {'error': 'unknown'})
        m = re.match(r'^/d/([a-z0-9-]+)/(.*)$', path)
        if m:
            deck = visible_deck(m.group(1))
            if not deck:
                return self.send(404, 'No such deck')
            rel = m.group(2) or deck['entry']
            if any(part.startswith('.') for part in rel.split('/')) or '\x00' in rel or len(rel) > 400:
                return self.send(404, 'Not found')   # no dotfiles (.git, .slidebuilder), no odd paths
            try:
                target = (deck['path'] / rel).resolve()
                if deck['path'] not in target.parents and target != deck['path']:
                    return self.send(403, 'Outside the deck folder')
                if target.suffix.lower() == '.html' and target.is_file() and 'raw' not in q:
                    snap = pulse_of(deck)   # before reading, so a change made while serving still counts as new
                    html = target.read_text(encoding='utf-8')
                    return self.send(200, inject(html, deck, rel, snap), 'text/html; charset=utf-8')
            except (OSError, ValueError):
                return self.send(404, 'Not found')
            return self.serve_file(target, cache=target.suffix.lower() in ('.png', '.jpg', '.jpeg', '.svg', '.woff2'))
        if re.match(r'^/d/([a-z0-9-]+)$', path):
            return self.send(302, extra={'Location': path + '/'})
        self.send(404, 'Not found')

    def foreign(self):
        """A write sent by another website, or another app on this machine, rather than this server's own
        pages. Browsers say where a request came from; sb and the headless tools send neither header."""
        site = (self.headers.get('Sec-Fetch-Site') or '').lower()
        origin = self.headers.get('Origin')
        if site and site not in ('same-origin', 'none'):
            return True
        return bool(origin) and urlparse(origin).netloc != (self.headers.get('Host') or '')

    def do_PUT(self):
        if self.foreign():
            return self.json(403, {'error': 'Changes are accepted only from Decks’ own pages.'})
        m = re.match(r'^/api/decks/([a-z0-9-]+)/state$', urlparse(self.path).path)
        deck = visible_deck(m.group(1)) if m else None
        if not deck:
            return self.json(404, {'error': 'no such deck'})
        body = self.body()
        path = sb_dir(deck) / 'state.json'
        bases = body.get('base') if isinstance(body.get('base'), dict) else {}
        merged = {}
        with LOCK:
            st = read_json(path, {'keys': {}, 'savedAt': 0})
            keys = st.setdefault('keys', {})
            for k, v in (body.get('set') or {}).items():
                if any(k.startswith(p) for p in deck.get('prefixes', [])):
                    if k in bases and k in keys and keys[k] != bases[k]:
                        keys[k] = merged[k] = merge_saved(bases[k], v, keys[k])   # another tab saved this key since
                    else:
                        keys[k] = v
            for k in body.get('remove') or []:   # like set: only this deck's own keys
                if isinstance(k, str) and any(k.startswith(p) for p in deck.get('prefixes', [])):
                    keys.pop(k, None)
            st['savedAt'] = time.time()
            write_json(path, st)
            SAVES[deck['slug']] = {'at': st['savedAt'], 'by': str(body.get('tab') or '')[:40]}
        self.json(200, {'savedAt': st['savedAt'], 'merged': merged})

    def do_POST(self):
        if self.foreign():
            return self.json(403, {'error': 'Changes are accepted only from Decks’ own pages.'})
        if urlparse(self.path).path == '/api/watch':   # sb watch, no deck named: a Process now click on any deck
            return self.json(200, {'request': wait_for_click()})
        m = re.match(r'^/api/decks/([a-z0-9-]+)/pdf$', urlparse(self.path).path)
        if m:   # Download PDF
            return self.pdf(m.group(1))
        if urlparse(self.path).path == '/api/check-updates':   # the Check for updates button: ask GitHub now
            ok = check_latest()
            return self.json(200, {'ok': ok, 'version': VERSION, 'update': update_info()})
        if urlparse(self.path).path == '/api/settings':
            with LOCK:
                st = settings()
                body = self.body()
                if 'hideClients' in body:
                    st['hideClients'] = bool(body['hideClients'])
                sbconfig.DECKS.mkdir(parents=True, exist_ok=True)
                write_json(sbconfig.SETTINGS, st)
            return self.json(200, st)
        if urlparse(self.path).path == '/api/upload-source':   # Import a deck: the file, as it is, before the deck is made
            return self.upload_source()
        if urlparse(self.path).path == '/api/new-deck':
            try:
                body = self.body()
                if not isinstance(body, dict) or not isinstance(body.get('name', ''), str) or not isinstance(body.get('brief') or {}, dict) \
                        or not isinstance(body.get('pieces') or [], list) or not isinstance(body.get('logo') or {}, dict) or not isinstance(body.get('source') or {}, dict):
                    return self.json(400, {'error': 'That request didn’t look right.'})
                source, staged = import_source(body.get('source'))
                deck = newdeck.create_deck(body.get('name'), str(body.get('template') or 'blank'), body.get('brief') or {}, body.get('pieces') or [], body.get('logo'),
                                           source=source)   # newdeck locks decks.json itself, briefly
            except (ValueError, json.JSONDecodeError) as e:
                return self.json(400, {'error': str(e)})
            if staged:
                shutil.rmtree(staged, ignore_errors=True)
            deck['path'] = f'/d/{deck["slug"]}/{deck["entry"]}'
            make_thumb(deck)
            return self.json(200, deck)
        m = re.match(r'^/api/decks/([a-z0-9-]+)/([a-z-]+)$', urlparse(self.path).path)
        deck = visible_deck(m.group(1)) if m else None
        if not deck:
            return self.json(404, {'error': 'no such deck'})
        what = m.group(2)
        try:
            body = self.body()
        except json.JSONDecodeError:
            return self.json(400, {'error': 'bad json'})
        if what == 'watch':   # sb watch <deck>: wait up to 25 s for a Process now click on this deck
            return self.json(200, {'request': wait_for_click(deck['slug'])})
        if what == 'process':   # the page: Process now
            ASKED[deck['slug']] = {'at': time.time(), 'open': len([r for r in open_comments(deck) if r['state'] != 'draft' and not (r['reply'] and r['reply'].get('status') in ('done', 'skipped', 'question'))])}
            return self.json(200, {'watching': watching(deck['slug'])})
        if what == 'review':
            try:
                return self.json(200, apply_review_op(deck, body))
            except (KeyError, ValueError) as e:
                return self.json(400, {'error': str(e)})
        if what == 'manage':   # dashboard: hide, show, or delete a deck
            try:
                return self.json(200, newdeck.manage_deck(deck['slug'], str(body.get('op'))))
            except (KeyError, ValueError) as e:
                return self.json(400, {'error': str(e)})
            except OSError as e:
                return self.json(500, {'error': f'Could not move the folder to the Trash: {e}'})
        if what == 'bundle':
            html = body.get('html')
            if not isinstance(html, str) or not html.strip():
                return self.json(400, {'error': 'no html'})
            out, n = bundle_copy(deck, html, code_paths=not body.get('review'))
            return self.send(200, out, 'text/html; charset=utf-8', extra={'X-SB-Pictures': str(n)})
        if what == 'upload':
            # a picture dropped onto a slide: saved in the deck's folder, so the deck and its PDF keep it
            import base64, hashlib
            m = re.match(r'data:image/(png|jpeg|jpg|gif|webp|svg\+xml);base64,(.*)$', str(body.get('data', '')), re.S)
            if not m:
                return self.json(400, {'error': 'Pictures have to be PNG, JPG, GIF, WebP, or SVG.'})
            raw = base64.b64decode(m.group(2))
            if len(raw) > 15_000_000:
                return self.json(400, {'error': 'That picture is over 15 MB. Try a smaller one.'})
            ext = {'jpeg': 'jpg', 'svg+xml': 'svg'}.get(m.group(1), m.group(1))
            name = hashlib.sha1(raw).hexdigest()[:12] + '.' + ext
            folder = deck['path'] / 'img' / 'uploads'
            folder.mkdir(parents=True, exist_ok=True)
            (folder / name).write_bytes(raw)
            return self.json(200, {'path': f'img/uploads/{name}'})
        self.json(404, {'error': 'unknown'})


MAX_SOURCE = 1_000_000_000   # an uploaded deck; a pasted path has no limit
INCOMING = sbconfig.DECKS / '.incoming'


def import_source(src):
    """New deck's source (Import a deck) -> (what create_deck takes, the upload folder to clear after), or (None, None).
    Either a token from /api/upload-source, or a path to a file on this machine, which is copied."""
    if not src:
        return None, None
    mode = 'rebuild' if src.get('mode') == 'rebuild' else 'keep'
    token = str(src.get('token') or '')
    if token:
        if not re.fullmatch(r'[0-9a-f]{16}', token) or not (INCOMING / token).is_dir():
            raise ValueError('The uploaded file is gone. Choose it again.')
        files = [f for f in (INCOMING / token).iterdir() if f.is_file()]
        if not files:
            raise ValueError('The uploaded file is gone. Choose it again.')
        return {'path': str(files[0]), 'name': files[0].name, 'mode': mode, 'move': True}, INCOMING / token
    if str(src.get('path') or '').strip():
        return {'path': str(src['path']).strip(), 'mode': mode}, None
    raise ValueError('Choose the deck to import: a PowerPoint file (.pptx) or a PDF.')


def make_thumb(deck):
    """A thumbnail for the dashboard, in the background (headless Chrome takes a few seconds; no Chrome, no thumbnail)."""
    thumb = Path(os.path.expanduser(deck['folder'])) / '.slidebuilder' / 'thumb.png'
    env = dict(os.environ, SB_URL=f'http://localhost:{sbconfig.PORT}')
    def run():
        try:
            subprocess.run(['node', str(APP / 'tools' / 'browser.mjs'), 'thumb', deck['slug'], str(thumb)], capture_output=True, timeout=120, env=env)
        except (OSError, subprocess.SubprocessError):
            pass
    threading.Thread(target=run, daemon=True).start()


def first_run():
    """No decks.json yet: make the decks folder, an empty registry, and one demo deck to try things on."""
    if sbconfig.REGISTRY.exists():
        return None
    sbconfig.DECKS.mkdir(parents=True, exist_ok=True)
    write_json(sbconfig.REGISTRY, {'decks': []})
    try:
        return newdeck.create_demo()
    except (OSError, ValueError) as e:
        print(f'Could not make the demo deck: {e}', flush=True)
        return None


def vtuple(v):
    return tuple(int(x) for x in re.findall(r'\d+', str(v))[:3])


def check_latest():
    """Which release is newest: one HEAD request to GitHub, read from where it redirects
    (/releases/latest -> /releases/tag/v0.3.0). Nothing about your decks is sent.
    True when GitHub answered, False when it couldn't be reached."""
    import http.client
    try:
        c = http.client.HTTPSConnection('github.com', timeout=6)
        c.request('HEAD', f'/{UPDATE_REPO}/releases/latest', headers={'User-Agent': f'Decks/{VERSION}'})
        loc = c.getresponse().getheader('Location') or ''
        c.close()
        m = re.search(r'/releases/tag/v?(\d+\.\d+\.\d+)', loc)
        if m:
            LATEST.update({'version': m.group(1), 'url': f'https://github.com/{UPDATE_REPO}/releases/tag/v{m.group(1)}', 'at': time.time()})
            return True
    except (OSError, http.client.HTTPException):
        pass   # offline, or GitHub didn't answer: update_loop tries again soon
    return False


def update_loop():
    """Asks GitHub every few hours. It goes by the clock and naps a minute at a time, so a laptop
    that was asleep checks soon after it wakes, and a check that failed is tried again in minutes."""
    time.sleep(5)   # after startup, so the first page never waits on it
    due = 0
    while True:
        if time.time() >= due:
            due = time.time() + (CHECK_EVERY if check_latest() else RETRY_AFTER)
        time.sleep(60)


def update_info():
    v = LATEST.get('version')
    return {'version': v, 'url': LATEST['url'], 'prompt': update_prompt(v, LATEST['url'])} if v and vtuple(v) > vtuple(VERSION) else None


def update_prompt(v, url):
    """What Copy update prompt puts on the clipboard, for Claude Code or Codex to do the update."""
    app = sbconfig.tilde(APP)
    return (f'Update Decks to {v}. In {app}, run `git pull`. If it stops because of local changes, show me what changed and stop there. '
            f'Then restart the Decks server. If it runs at login (~/Library/LaunchAgents/local.decks.plist), run `launchctl kickstart -k gui/$(id -u)/local.decks`. '
            f'Otherwise, stop the running `python3 server.py` and start it again from {app}, in the background. '
            f'Then open http://localhost:{sbconfig.PORT}/ and check that the footer says Decks {v}. What changed: {url}')


def main():
    ap = argparse.ArgumentParser(description='Decks server. Defaults come from config.json and SB_* environment variables (see sbconfig.py).')
    ap.add_argument('--host', default=sbconfig.HOST)
    ap.add_argument('--port', type=int, default=sbconfig.PORT)
    a = ap.parse_args()
    sbconfig.PORT = a.port   # deck addresses, prompts, and the thumbnail job use the port actually served
    mimetypes.add_type('application/javascript', '.mjs')
    srv = ThreadingHTTPServer((a.host, a.port), Handler)
    demo = first_run()
    if a.host == '127.0.0.1':
        # browsers often resolve "localhost" to ::1 first; answer there too (loopback only)
        try:
            import socket

            class V6(ThreadingHTTPServer):
                address_family = socket.AF_INET6
            threading.Thread(target=V6(('::1', a.port), Handler).serve_forever, daemon=True).start()
        except OSError:
            pass
    if sbconfig.CHECK_UPDATES:
        threading.Thread(target=update_loop, daemon=True).start()
    if demo:
        make_thumb(demo)
        print(f'Made a demo deck in {demo["folder"]}', flush=True)
    print(f'Decks {VERSION} on http://localhost:{a.port}/  (decks in {sbconfig.tilde(sbconfig.DECKS)})', flush=True)
    srv.serve_forever()


if __name__ == '__main__':
    main()
