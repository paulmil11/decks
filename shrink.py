"""Shrink file size (Share › Shrink file size, and sb shrink): what makes a deck heavy, and smaller copies.

    scan(deck, decks)          what could be smaller, and by how much; changes nothing
    apply(deck, decks, ids)    does the chosen ones, and commits them in the deck's git repo
    undo(deck)                 puts the last shrink back

What it finds:
  - photos saved as PNG (a JPEG looks the same at a fraction of the size), and PNGs with a
    transparent background (WebP keeps the transparency, also far smaller);
  - pictures much larger than a slide ever shows them: past twice the slide (2000 x 1125, sharp on
    any screen at full bleed), and JPEGs saved at a higher quality than a screen can show;
  - pictures written into the deck file itself (data: URIs), moved into img/ as files;
  - files in img/ that no slide uses, and older PDF exports outside _archive/ (folder tidying: they
    are in neither the deck nor the copies you send).

Nothing is deleted. Each shrink keeps its originals in .slidebuilder/originals/<time>/ with a list of
what it did (manifest.json), so undo can put every file and every reference back. A picture that
changes format gets a new name (mentor.png -> mentor.webp) and the deck's references follow: in the
deck file, the local scripts and stylesheets it loads, and its saved edits. A picture the deck names
another way (a path built in code, like img/ct-${n}.jpg, or in a file the deck doesn't load) keeps
its name and format, and only gets smaller.

Pictures are re-encoded with Pillow (python3 -m pip install Pillow). Without it, scan still lists
what's heavy and apply still tidies the folder, and says the pictures need Pillow.
"""
import base64
import filecmp
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import quote, unquote

MAX_W, MAX_H = 2000, 1125   # twice the 1000 x 562.5 slide: what a picture needs to fill it on a sharp screen
JPEG_Q, WEBP_Q = 85, 85
MIN_SAVE, MIN_SHARE = 30_000, 0.2   # a picture is worth listing when it saves 30 KB and a fifth of its size
MIN_INLINE = 30_000     # data: URIs at least this big (decoded) come out of the deck file
IMG = ('.png', '.jpg', '.jpeg', '.webp', '.gif')
TEXT = ('.html', '.htm', '.js', '.mjs', '.css', '.svg')
SKIP_DIRS = {'.git', '.slidebuilder', '_archive', 'node_modules', 'source', '__pycache__'}
REF = re.compile(r'(?<![\w%./-])(?:\./)?([\w%-][\w%./-]*\.(?:png|jpe?g|gif|svg|webp))(?![\w%./-])', re.I)   # any character a path can't hold ends it ('a.jpg|b.jpg')
TEMPLATE = re.compile(r'`((?:[\w-]+/)*[\w.-]*)\$\{[^}`]*\}([\w.-]*\.(?:png|jpe?g|gif|svg|webp))`', re.I)
PREFIX = re.compile(r'["\'`]((?:\./)?(?:[\w-]+/)+[\w.-]*)["\'`]\s*\+')   # 'img/md-' + name: a path finished in code
DATA_URI = re.compile(r'data:image/(png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/=]{' + str(MIN_INLINE * 4 // 3) + r',})')
LOCAL_SRC = re.compile(r'<(?:script|link)\b[^>]*?\s(?:src|href)="([^"]+)"', re.I)
PDF = re.compile(r'^(?P<stem>.+) \(v(?P<n>\d+) export\)\.pdf$')
_cache, _cache_lock = {}, threading.Lock()
SB_TRAILER = ''   # what a shrink sb runs adds to its commit message (sb commit adds nothing either)


def has_pillow():
    try:
        import PIL.Image  # noqa: F401
        return True
    except ImportError:
        return False


def kb(n):
    return f'{n / 1_000_000:.1f} MB' if n >= 950_000 else f'{max(1 if n else 0, round(n / 1000))} KB'


# ---------- what the deck refers to ----------

def deck_files(deck):
    """The files the deck is made of: its entry file and the local scripts and stylesheets it loads.
    References in these (and in its saved edits) follow a picture that's renamed."""
    root, out = deck['path'], [deck['entry']]
    try:
        html = (root / deck['entry']).read_text(encoding='utf-8', errors='replace')
    except OSError:
        return out
    for src in LOCAL_SRC.findall(html):
        rel = unquote(src.split('?')[0].split('#')[0])
        if rel.startswith('./'):
            rel = rel[2:]
        if rel and not rel.startswith(('/', 'http:', 'https:', 'data:')) and '..' not in rel.split('/') \
                and Path(rel).suffix.lower() in ('.js', '.mjs', '.css') and (root / rel).is_file() and rel not in out:
            out.append(rel)
    return out


def _walk(root, exts):
    for dirpath, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.startswith('.')]
        for f in files:
            if f.lower().endswith(exts) and not f.startswith('.'):
                yield Path(dirpath) / f


def _state_texts(root):
    try:
        st = json.loads((root / '.slidebuilder' / 'state.json').read_text(encoding='utf-8'))
        return [v for v in (st.get('keys') or {}).values() if isinstance(v, str)]
    except (OSError, ValueError):
        return []


def references(deck, decks=()):
    """Which pictures the deck uses, and how it names each one.
    -> (literal: {rel: set of files naming it}, coded: [globs a path built in code could match])"""
    root = deck['path']
    entries = {deck['entry']} | {d['entry'] for d in decks if d.get('path') == root}   # decks that share a folder
    own = set(deck_files(deck))
    for d in decks:
        if d.get('path') == root and d['entry'] != deck['entry']:
            own |= set(deck_files(d))
    texts = {}
    for f in _walk(root, TEXT):
        rel = f.relative_to(root).as_posix()
        if rel.startswith('img/') and not rel.endswith('.svg'):
            continue
        try:
            texts[rel] = f.read_text(encoding='utf-8', errors='replace')
        except OSError:
            pass
    for e in entries:
        texts.setdefault(e, '')
    texts['.slidebuilder/state.json'] = '\n'.join(_state_texts(root))
    literal, coded, bare = {}, [], {}
    for name, t in texts.items():
        where = name if (name in own or name == '.slidebuilder/state.json') else '*' + name   # * : a file the deck doesn't load
        for m in REF.finditer(t):
            rel = unquote(m.group(1))
            rel = rel[2:] if rel.startswith('./') else rel
            if (root / rel).is_file():
                literal.setdefault(rel, set()).add(where)
            else:
                b = Path(rel).name   # a bare name ("pic": "x.png") that code puts a folder in front of
                if b not in bare:
                    bare[b] = [f.relative_to(root).as_posix() for f in root.glob('**/' + glob_escape(b))
                               if not any(p in SKIP_DIRS for p in f.relative_to(root).parts)]
                for r in bare[b]:
                    literal.setdefault(r, set()).add('*' + name)
        for pre, post in TEMPLATE.findall(t):
            coded.append(re.sub(r'^\./', '', pre) + '*' + post)
        for pre in PREFIX.findall(t):
            coded.append(re.sub(r'^\./', '', pre) + '*')
    return literal, sorted(g for g in set(coded) if not g.startswith('/') and '..' not in g.split('/'))


def glob_escape(name):
    return re.sub(r'([*?\[])', r'[\1]', name)


def _coded(rel, coded):
    from fnmatch import fnmatch
    return any(fnmatch(rel, g) for g in coded)


# ---------- one picture: what would make it smaller ----------

def _open(data):
    import warnings
    from PIL import Image, ImageOps
    im = Image.open(io.BytesIO(data))
    with warnings.catch_warnings():
        warnings.simplefilter('ignore')   # Pillow's note on palette pictures with transparency
        im.load()
        if im.mode == 'P' and 'transparency' in im.info:
            im = im.convert('RGBA')
    fmt, q = im.format, getattr(im, 'quantization', None)
    if fmt == 'JPEG':
        im = ImageOps.exif_transpose(im)   # a phone photo stands the way it's shown (the copy loses format and tables)
    im.format, im.quantization = fmt, q
    return im


def _alpha(im):
    """True when some pixel is see-through (an alpha channel that's all opaque doesn't count)."""
    if im.mode in ('RGBA', 'LA', 'PA') or 'transparency' in im.info:
        return im.convert('RGBA').getchannel('A').getextrema()[0] < 255
    return False


def _photo(im):
    """Tens of thousands of colors (a photo, or a painted illustration) rather than a few thousand (a chart,
    a screenshot, a drawing with lettering): lossy formats suit the first; the second keeps every pixel."""
    return im.convert('RGB').getcolors(maxcolors=20000) is None


def _jpeg_quality(im):
    """The quality a JPEG was saved at, from its luminance table (the IJG scale)."""
    q = getattr(im, 'quantization', None) or {}
    t = q.get(0)
    if not t:
        return None
    std = [16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
           18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99]
    scale = sum(t) * 100 / sum(std)
    return round(100 - scale / 2) if scale <= 100 else round(5000 / scale)


def _encode(im, fmt, size, lossless=False):
    from PIL import Image
    icc = im.info.get('icc_profile')
    if size != im.size:
        im = im.resize(size, Image.LANCZOS)
    buf = io.BytesIO()
    if fmt == 'JPEG':
        im = im.convert('L' if im.mode in ('L', 'LA') else 'RGB')
        im.save(buf, 'JPEG', quality=JPEG_Q, optimize=True, progressive=True, icc_profile=icc)
    elif fmt == 'WEBP':
        im = im.convert('RGBA' if _alpha(im) else 'RGB')
        im.save(buf, 'WEBP', lossless=lossless, quality=100 if lossless else WEBP_Q, method=4 if lossless else 5, icc_profile=icc)
    else:
        if im.mode not in ('RGB', 'RGBA', 'L', 'LA', 'P'):
            im = im.convert('RGBA')
        im.save(buf, 'PNG', optimize=True, icc_profile=icc)
    return buf.getvalue()


EXT = {'JPEG': '.jpg', 'WEBP': '.webp', 'PNG': '.png'}


def plan_picture(data, renamable=True):
    """The smaller picture, or None: {'fmt', 'w', 'h', 'nw', 'nh', 'bytes', 'why'}."""
    try:
        im = _open(data)
    except Exception:   # noqa: BLE001  not a picture Pillow reads (or a broken one): leave it
        return None
    fmt = im.format or ''
    if getattr(im, 'n_frames', 1) > 1 or fmt not in ('PNG', 'JPEG', 'WEBP') or im.mode not in ('1', 'L', 'LA', 'P', 'PA', 'RGB', 'RGBA'):
        return None   # animations, GIFs, CMYK, 16-bit: as they are
    w, h = im.size
    s = max(MAX_W / w, MAX_H / h)
    size = (w, h) if s >= 0.9 else (max(1, round(w * s)), max(1, round(h * s)))
    big = size != (w, h)
    alpha = _alpha(im)
    why, lossless = [], False
    if fmt == 'PNG':
        photo = _photo(im)
        if renamable and alpha:
            out, lossless = 'WEBP', not photo
            why.append('A cutout saved as PNG. WebP keeps its see-through background.' if photo else
                       'Saved as PNG. WebP keeps every pixel, and the see-through parts.')
        elif renamable and photo:
            out = 'JPEG'
            why.append('A photo saved as PNG. As a JPEG it looks the same.')
        elif renamable:
            out, lossless = 'WEBP', True
            why.append('Saved as PNG. WebP keeps every pixel.')
        else:
            out = 'PNG'
    elif fmt == 'JPEG':
        q = _jpeg_quality(im)
        if not big and not (q and q > 90):
            return None
        out = 'JPEG'
        if q and q > 90:
            why.append(f'Saved at quality {q}, more than a screen shows; {JPEG_Q} looks the same.')
    else:
        if not big:
            return None
        out = 'WEBP'
    if big:
        why.append(f'{w} × {h} px, more than a slide ever shows; {size[0]} × {size[1]} is sharp at full screen.')
    try:
        b = _encode(im, out, size, lossless)
    except Exception:   # noqa: BLE001
        return None
    saved = len(data) - len(b)
    if saved < MIN_SAVE or saved < len(data) * MIN_SHARE:
        return None
    if out == 'PNG' and not why:
        why.append('Saved again with better compression.')
    return {'fmt': out, 'w': w, 'h': h, 'nw': size[0], 'nh': size[1], 'bytes': b, 'why': ' '.join(why), 'from': fmt}


def _planned(f, renamable):
    """plan_picture for a file, remembered until the file changes (the panel asks again each time it opens)."""
    st = f.stat()
    key = (str(f), st.st_size, st.st_mtime_ns, renamable)
    with _cache_lock:
        if key in _cache:
            return _cache[key]
    p = plan_picture(f.read_bytes(), renamable)
    with _cache_lock:
        for k in [k for k in _cache if k[0] == key[0]]:
            del _cache[k]
        _cache[key] = p
    return p


def _free_name(root, rel, ext, taken=()):
    p = Path(rel)
    cand = p.with_suffix(ext).as_posix()
    n = 2
    while (cand != rel and (root / cand).exists()) or cand in taken:
        cand = p.with_name(f'{p.stem}-{n}{ext}').as_posix()
        n += 1
    return cand


# ---------- scan ----------

def scan(deck, decks=()):
    """Everything that could be smaller, biggest saving first. Changes nothing."""
    root = deck['path']
    literal, coded = references(deck, decks)
    pillow = has_pillow()
    used = sorted(rel for rel in literal if Path(rel).suffix.lower() in IMG)
    for g in coded:   # files a path built in code can reach count as used
        for f in root.glob(g):
            rel = f.relative_to(root).as_posix()
            if f.is_file() and f.suffix.lower() in IMG and rel not in used:
                used.append(rel)
    weight = sum((root / r).stat().st_size for r in used if (root / r).is_file())
    items, taken = [], set()

    def renamable(rel):
        return not _coded(rel, coded) and all(not w.startswith('*') for w in literal.get(rel, ()))

    pics = [r for r in used if (root / r).is_file() and (root / r).suffix.lower() != '.gif']
    with ThreadPoolExecutor(max_workers=4) as pool:   # Pillow lets go of the GIL while it encodes
        plans = list(pool.map(lambda r: _planned(root / r, renamable(r)) if pillow else None, pics))
    for rel, p in zip(pics, plans):   # one at a time, so two pictures never get the same new name
        if not p:
            continue
        ext = Path(rel).suffix.lower()
        to = rel if EXT[p['fmt']] == ext or (p['fmt'] == 'JPEG' and ext == '.jpeg') else _free_name(root, rel, EXT[p['fmt']], taken)
        taken.add(to)
        items.append({'id': rel, 'kind': 'picture', 'file': rel, 'to': to, 'size': (root / rel).stat().st_size, 'after': len(p['bytes']), 'renamable': renamable(rel),
                      'w': p['w'], 'h': p['h'], 'nw': p['nw'], 'nh': p['nh'], 'format': p['fmt'], 'why': p['why'], 'inDeck': True})

    # pictures written into the deck file itself
    inline = {}
    for rel in deck_files(deck):
        try:
            t = (root / rel).read_text(encoding='utf-8', errors='replace')
        except OSError:
            continue
        for m in DATA_URI.finditer(t):
            sha = hashlib.sha1(m.group(2).encode()).hexdigest()[:12]
            inline.setdefault(sha, {'b64': m.group(2), 'type': m.group(1), 'in': set(), 'n': 0})
            inline[sha]['in'].add(rel)
            inline[sha]['n'] += 1
    for sha, x in inline.items():
        data = base64.b64decode(x['b64'])
        p = plan_picture(data) if pillow else None
        ext = EXT[p['fmt']] if p else ('.' + {'jpeg': 'jpg'}.get(x['type'], x['type']))
        to = _free_name(root, f'img/inline-{sha}{ext}', ext, taken)
        taken.add(to)
        after = len(p['bytes']) if p else len(data)
        items.append({'id': 'inline:' + sha, 'kind': 'inline', 'file': ' and '.join(sorted(x['in'])), 'to': to, 'size': len(x['b64']) * x['n'],
                      'after': after, 'format': p['fmt'] if p else x['type'].upper(), 'inDeck': True,
                      'why': 'Written into the deck file itself' + ({1: '', 2: ', twice'}.get(x['n'], f', {x["n"]} times')) +
                             '. As a file in img/, it stops weighing down the deck file.' + (' ' + p['why'] if p else '')})
        weight += len(x['b64']) * x['n']

    # folder tidying: neither in the deck nor in the copies you send
    for f in sorted(_walk(root / 'img', IMG + ('.svg',))) if (root / 'img').is_dir() else []:
        rel = f.relative_to(root).as_posix()
        if rel not in literal and not _coded(rel, coded) and rel not in used:
            items.append({'id': rel, 'kind': 'unused', 'file': rel, 'to': '.slidebuilder/originals/…/' + rel, 'size': f.stat().st_size, 'after': 0,
                          'why': 'No slide uses it.', 'inDeck': False})
    newest = {}
    for f in root.glob('*.pdf'):
        m = PDF.match(f.name)
        if m:
            newest[m.group('stem')] = max(newest.get(m.group('stem'), 0), int(m.group('n')))
    for f in sorted(root.glob('*.pdf')):
        m = PDF.match(f.name)
        if m and int(m.group('n')) < newest[m.group('stem')]:
            why, to, there = f'An older export: v{newest[m.group("stem")]} is the newest.', '_archive/' + f.name, root / '_archive' / f.name
            if there.exists() and filecmp.cmp(f, there, shallow=False):
                why, to = why + ' _archive/ has the same file already, so this copy goes to .slidebuilder/originals/.', ''
            elif there.exists():   # another file by this name: this one gets a number
                n = 2
                while (root / '_archive' / f'{f.stem} {n}.pdf').exists():
                    n += 1
                to = f'_archive/{f.stem} {n}.pdf'
            items.append({'id': 'pdf:' + f.name, 'kind': 'pdf', 'file': f.name, 'to': to, 'size': f.stat().st_size, 'after': 0,
                          'why': why, 'inDeck': False})

    for it in items:
        it['saves'] = it['size'] - it['after']
    order = {'picture': 0, 'inline': 0, 'unused': 1, 'pdf': 2}
    items.sort(key=lambda it: (order[it['kind']], -it['saves']))
    return {'items': items, 'weight': weight, 'pictures': len(used) + len(inline), 'pillow': pillow,
            'last': last_batch(deck), 'coded': coded}


# ---------- apply ----------

def _ref_pattern(rel):
    forms = sorted({rel, quote(rel)}, key=len, reverse=True)
    return re.compile(r'(?<![\w%./-])(\./)?(' + '|'.join(re.escape(f) for f in forms) + r')(?![\w%./-])')


def _rewrite(text, pairs):
    """Every reference to each old path, now to its new one. -> (text, count)"""
    n = 0
    for old, new in pairs:
        text, k = _ref_pattern(old).subn(lambda m: (m.group(1) or '') + new, text)
        n += k
    return text, n


def _write(path, text):
    tmp = path.with_name(path.name + '.shrink-tmp')
    tmp.write_text(text, encoding='utf-8')
    os.replace(tmp, path)


def _rewrite_state(root, pairs, lock=None):
    """The deck's saved edits (.slidebuilder/state.json) name the new pictures too. Under the server's
    save lock, so a tab saving at the same moment waits. -> how many references changed"""
    sp = root / '.slidebuilder' / 'state.json'
    if not pairs or not sp.is_file():
        return 0
    pairs = pairs + [(o.replace('/', '\\/'), nw.replace('/', '\\/')) for o, nw in pairs]   # as JSON inside JSON may write them
    with (lock or threading.Lock()):
        try:
            st = json.loads(sp.read_text(encoding='utf-8'))
        except (OSError, ValueError):
            return 0
        n = 0
        for k, v in list((st.get('keys') or {}).items()):
            if isinstance(v, str):
                v2, c = _rewrite(v, pairs)
                if c:
                    st['keys'][k], n = v2, n + c
        if n:
            st['savedAt'] = time.time()
            tmp = sp.with_suffix('.json.tmp')
            tmp.write_text(json.dumps(st, ensure_ascii=False, indent=1), encoding='utf-8')
            os.replace(tmp, sp)
        return n


def _batches(root):
    d = root / '.slidebuilder' / 'originals'
    return sorted((p for p in d.iterdir() if (p / 'manifest.json').is_file()), key=lambda p: p.name) if d.is_dir() else []


def last_batch(deck):
    """The newest shrink that hasn't been undone, for the panel's Undo."""
    for b in reversed(_batches(deck['path'])):
        try:
            m = json.loads((b / 'manifest.json').read_text(encoding='utf-8'))
        except (OSError, ValueError):
            continue
        if not m.get('undone'):
            return {'batch': b.name, 'at': m.get('at'), 'done': len(m.get('items', [])), 'saved': m.get('saved', 0), 'commit': m.get('commit')}
        return None
    return None


def moved(root):
    """Old path -> new path for every picture a shrink renamed and no undo put back. The server answers
    an old path with the new picture, so a tab or a returned copy that still names it shows it."""
    out = {}
    for b in _batches(root):
        try:
            m = json.loads((b / 'manifest.json').read_text(encoding='utf-8'))
        except (OSError, ValueError):
            continue
        if not m.get('undone'):
            for it in m.get('items', []):
                if it.get('kind') == 'picture' and it.get('to') != it.get('file'):
                    out[it['file']] = it['to']
    return out


def _git(root, *args, **kw):
    return subprocess.run(['git', '-C', str(root), *args], capture_output=True, text=True, timeout=60, **kw)


def _commit(root, paths, message):
    """A commit of just these paths in the deck's git repo; its short hash, or None (no repo, nothing to commit)."""
    if _git(root, 'rev-parse', '--git-dir').returncode:
        return None
    paths = sorted(set(paths))
    ig = _git(root, 'check-ignore', '--stdin', input='\n'.join(paths)).stdout.split('\n')
    paths = [p for p in paths if p not in ig]
    tracked = set(_git(root, 'ls-files', '--', *paths).stdout.split('\n')) if paths else set()
    paths = [p for p in paths if p in tracked or (root / p).exists()]
    if not paths:
        return None
    _git(root, 'add', '-A', '--', *paths)
    r = _git(root, 'commit', '-q', '-m', message, '--', *paths)
    if r.returncode:
        return None
    return _git(root, 'rev-parse', '--short', 'HEAD').stdout.strip() or None


def apply(deck, decks=(), ids=None, lock=None, by=None):
    """Shrink the chosen items (all of them when ids is None). Originals go to .slidebuilder/originals/<time>/."""
    root = deck['path']
    report = scan(deck, decks)
    items = [it for it in report['items'] if ids is None or it['id'] in set(ids)]
    if not items:
        return {'done': [], 'saved': 0, 'commit': None, 'batch': None, 'skipped': []}
    stamp = base = time.strftime('%Y-%m-%d-%H%M%S')
    n = 2
    while (root / '.slidebuilder' / 'originals' / stamp).exists():   # two in one second
        stamp, n = f'{base}-{n}', n + 1
    batch = root / '.slidebuilder' / 'originals' / stamp
    batch.mkdir(parents=True)
    gi = batch.parent / '.gitignore'
    if not gi.exists():
        gi.write_text('*\n', encoding='utf-8')   # the originals stay out of git: its history has them already
    files = deck_files(deck)
    dirty = bool(_git(root, 'status', '--porcelain', '--', deck['entry']).stdout.strip())   # no repo: git says nothing
    done, skipped, pairs, touched, inline_done = [], [], [], set(), []

    for it in items:
        try:
            if it['kind'] == 'picture':
                src = root / it['file']
                p = _planned(src, it['renamable'])   # the same smaller copy the list measured
                if not p or p['fmt'] != it['format']:
                    skipped.append({'id': it['id'], 'why': 'It changed since the list was made.'})
                    continue
                keep = batch / it['file']
                keep.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, keep)
                (root / it['to']).write_bytes(p['bytes'])
                if it['to'] != it['file']:
                    src.unlink()   # its copy is in the batch folder
                    pairs.append((it['file'], it['to']))
                touched |= {it['file'], it['to']}
                done.append(dict(it, after=len(p['bytes'])))
            elif it['kind'] == 'inline':
                sha = it['id'].split(':', 1)[1]
                d = batch / 'inline'
                d.mkdir(exist_ok=True)
                b64 = None
                for rel in files:
                    t = (root / rel).read_text(encoding='utf-8', errors='replace')
                    for m in DATA_URI.finditer(t):
                        if hashlib.sha1(m.group(2).encode()).hexdigest()[:12] == sha:
                            b64, typ = m.group(2), m.group(1)
                            break
                    if b64:
                        break
                if not b64:
                    skipped.append({'id': it['id'], 'why': 'It isn’t in the deck file any more.'})
                    continue
                data = base64.b64decode(b64)
                p = plan_picture(data)
                (d / f'{sha}.txt').write_text(f'data:image/{typ};base64,{b64}', encoding='utf-8')
                out = root / it['to']
                out.parent.mkdir(parents=True, exist_ok=True)
                out.write_bytes(p['bytes'] if p else data)
                inline_done.append((f'data:image/{typ};base64,{b64}', it['to']))
                touched.add(it['to'])
                done.append(dict(it, after=out.stat().st_size, uri=f'inline/{sha}.txt'))
            elif it['kind'] == 'unused':
                keep = batch / it['file']
                keep.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(root / it['file']), keep)
                touched.add(it['file'])
                done.append(dict(it, to=f'.slidebuilder/originals/{stamp}/{it["file"]}'))
            elif it['kind'] == 'pdf':
                to = it['to'] or f'.slidebuilder/originals/{stamp}/{it["file"]}'   # '': _archive/ has it already
                if (root / to).exists():
                    skipped.append({'id': it['id'], 'why': f'{to} is already there.'})
                    continue
                (root / to).parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(root / it['file']), root / to)
                done.append(dict(it, to=to))
        except OSError as e:
            skipped.append({'id': it['id'], 'why': str(e)})

    # the deck's references follow the pictures that changed name
    refs = []
    if pairs or inline_done:
        for rel in files:
            f = root / rel
            t = f.read_text(encoding='utf-8')
            t2, n = _rewrite(t, pairs)
            for uri, to in inline_done:
                k = t2.count(uri)
                t2, n = t2.replace(uri, to), n + k
            if n:
                _write(f, t2)
                refs.append({'file': rel, 'n': n})
                touched.add(rel)
        n = _rewrite_state(root, pairs, lock)
        if n:
            refs.append({'file': '.slidebuilder/state.json', 'n': n})
            touched.add('.slidebuilder/state.json')

    pics = [it for it in done if it['inDeck']]
    saved = sum(it['size'] - it['after'] for it in pics)
    tidy = [it for it in done if not it['inDeck']]
    parts = []   # for the commit's first line
    said = []    # for the panel
    unused = [it for it in tidy if it['kind'] == 'unused']
    pdfs = [it for it in tidy if it['kind'] == 'pdf']
    if pics:
        n = f"{len(pics)} picture{'s' * (len(pics) != 1)} smaller"
        parts.append(f"{n} ({kb(report['weight'])} → {kb(report['weight'] - saved)})")
        said.append(f"{n}: {kb(report['weight'])} → {kb(report['weight'] - saved)}.")
    if unused:
        n = f"{len(unused)} unused picture{'s' * (len(unused) != 1)}"
        parts.append(f'{n} out of img/')
        said.append(f'{n} moved out of img/.')
    arch = [it for it in pdfs if it['to'].startswith('_archive/')]
    dups = [it for it in pdfs if not it['to'].startswith('_archive/')]
    if arch:
        n = f"{len(arch)} older PDF{'s' * (len(arch) != 1)}"
        parts.append(f'{n} to _archive/')
        said.append(f'{n} moved to _archive/.')
    if dups:
        n = f"{len(dups)} older PDF{'s' * (len(dups) != 1)}"
        parts.append(f'{n} out ({"its copy is" if len(dups) == 1 else "their copies are"} in _archive/)')
        said.append(f'{n} moved out of the folder: _archive/ has {"it" if len(dups) == 1 else "them"} already.')
    if skipped:
        said.append(f"{len(skipped)} left as {'it was' if len(skipped) == 1 else 'they were'}: " + '; '.join(f"{x['id']} ({x['why']})" for x in skipped))
    manifest = {'at': time.time(), 'by': by or 'page', 'items': done, 'refs': refs, 'saved': saved, 'weight': report['weight'], 'skipped': skipped}
    msg = 'Shrink file size: ' + (', '.join(parts) or 'nothing changed') + f'\n\nThe originals are in .slidebuilder/originals/{stamp}/ (Share › Shrink file size › Undo puts them back).'
    if dirty and refs:
        msg += f"\n{deck['entry']} also had changes that weren’t committed yet; they are in this commit."
    if by == 'sb':
        msg += SB_TRAILER
    manifest['commit'] = _commit(root, touched, msg) if done else None
    (batch / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding='utf-8')
    if not done:
        shutil.rmtree(batch, ignore_errors=True)
    return {'done': done, 'saved': saved, 'weight': report['weight'], 'refs': refs, 'skipped': skipped,
            'commit': manifest['commit'], 'batch': stamp if done else None, 'summary': ' '.join(said) or 'Nothing changed.'}


# ---------- undo ----------

def undo(deck, batch=None, lock=None, by=None):
    """Put a shrink back (the newest one by default): the originals, their names, and the deck's references."""
    root = deck['path']
    bs = _batches(root)
    b = next((x for x in bs if x.name == batch), None) if batch else next((x for x in reversed(bs) if not json.loads((x / 'manifest.json').read_text(encoding='utf-8')).get('undone')), None)
    if not b:
        raise ValueError('There is no shrink to undo.')
    m = json.loads((b / 'manifest.json').read_text(encoding='utf-8'))
    if m.get('undone'):
        raise ValueError('That shrink was undone already.')
    shrunk = b / 'shrunk'   # the smaller copies, kept too: nothing is deleted
    back, problems, pairs, inline, touched = [], [], [], [], set()
    for it in m['items']:
        try:
            if it['kind'] == 'picture':
                orig, cur = b / it['file'], root / it['to']
                if not orig.is_file():
                    problems.append(f"{it['file']}: its original is missing from {b.name}")
                    continue
                if it['to'] != it['file'] and (root / it['file']).exists():
                    problems.append(f"{it['file']}: a file by that name is back in the deck")
                    continue
                if cur.is_file():
                    (shrunk / it['to']).parent.mkdir(parents=True, exist_ok=True)
                    shutil.move(str(cur), shrunk / it['to'])
                shutil.move(str(orig), root / it['file'])
                if it['to'] != it['file']:
                    pairs.append((it['to'], it['file']))
                touched |= {it['file'], it['to']}
                back.append(it)
            elif it['kind'] == 'inline':
                uri = (b / it['uri']).read_text(encoding='utf-8')
                inline.append((it['to'], uri))
                cur = root / it['to']
                if cur.is_file():
                    (shrunk / it['to']).parent.mkdir(parents=True, exist_ok=True)
                    shutil.move(str(cur), shrunk / it['to'])
                touched.add(it['to'])
                back.append(it)
            elif it['kind'] == 'unused':
                if (root / it['file']).exists():
                    problems.append(f"{it['file']}: a file by that name is back in the deck")
                    continue
                (root / it['file']).parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(b / it['file']), root / it['file'])
                touched.add(it['file'])
                back.append(it)
            elif it['kind'] == 'pdf':
                if (root / it['to']).exists() and not (root / it['file']).exists():
                    shutil.move(str(root / it['to']), root / it['file'])
                    back.append(it)
        except OSError as e:
            problems.append(f"{it['file']}: {e}")
    refs = []
    for rel in deck_files(deck):
        f = root / rel
        t = f.read_text(encoding='utf-8')
        t2, n = _rewrite(t, pairs)
        for to, uri in inline:
            t3, k = _ref_pattern(to).subn(lambda mm: uri, t2)
            t2, n = t3, n + k
        if n:
            _write(f, t2)
            refs.append({'file': rel, 'n': n})
            touched.add(rel)
    n = _rewrite_state(root, pairs, lock)
    if n:
        refs.append({'file': '.slidebuilder/state.json', 'n': n})
        touched.add('.slidebuilder/state.json')
    m['undone'] = time.time()
    msg = f"Undo shrink file size ({b.name}): {len(back)} file{'s' * (len(back) != 1)} back as they were" + \
          ('\n\n' + '\n'.join(problems) if problems else '') + (SB_TRAILER if by == 'sb' else '')
    m['undoCommit'] = _commit(root, touched, msg)
    (b / 'manifest.json').write_text(json.dumps(m, ensure_ascii=False, indent=1), encoding='utf-8')
    return {'back': back, 'problems': problems, 'refs': refs, 'commit': m['undoCommit'], 'batch': b.name}
