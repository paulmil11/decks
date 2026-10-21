"""Proposed slides: the reviewer's decisions, and baking them into a deck file.

A proposal is a LIBRARY entry with prop:true, replaces:'<original id>'. In the deck, the reviewer accepts it
(the proposal takes the original's place) or keeps the original (the proposal goes). The page saves each
decision in review.json and applies it to the version on screen at once; `sb proposals <deck> --bake`
then writes it into the deck file:

  accept  the original gets alt:true (it moves to the extras), the proposal loses prop and replaces,
          and in every version that lists its slides by hand the original's id becomes the proposal's
  keep    the proposal's LIBRARY entry is deleted (git keeps it), and it leaves every hand-made version

Only the deck file's text changes. The edits work on the JavaScript as written: strings, template
literals, comments, and regular expressions are skipped, so a slide's words are never touched.
"""
import re


# ---------- reading the deck's JavaScript ----------

REGEX_BEFORE = set('(,=:[!&|?{};+-*%<>~^')
REGEX_WORDS = ('return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'new', 'else', 'do')


def code_mask(src):
    """One byte per character: 0 where it is code, 1 inside a string, template text, comment, or regex.
    In an HTML file only the scripts are code; everything outside them is 1."""
    if re.search(r'<script\b', src, re.I):
        m = bytearray(b'\x01' * len(src))
        for mm in re.finditer(r'<script\b([^>]*)>([\s\S]*?)</script>', src, re.I):
            if re.search(r'type\s*=\s*["\']?application/(?:ld\+)?json', mm.group(1), re.I) or 'src=' in mm.group(1):
                continue
            m[mm.start(2):mm.end(2)] = js_mask(mm.group(2))
        return m
    return js_mask(src)


def js_mask(src):
    n, m = len(src), bytearray(len(src))
    stack = []        # brace depth at each open ${ in a template literal
    depth = 0         # braces open in code
    prev = ''         # the last code character that wasn't whitespace
    i = 0

    def template(j):   # from just inside a template's text: to its closing ` (end) or the next ${ (expr)
        while j < n:
            c = src[j]
            if c == '\\':
                j += 2; continue
            if c == '`':
                return j, 'end'
            if c == '$' and j + 1 < n and src[j + 1] == '{':
                return j, 'expr'
            j += 1
        return n - 1, 'end'

    def mark(a, b):
        m[a:b] = b'\x01' * (b - a)

    while i < n:
        c = src[i]
        if c in ' \t\r\n':
            i += 1; continue
        if c in '"\'':
            j = i + 1
            while j < n and src[j] != c and src[j] != '\n':
                j += 2 if src[j] == '\\' else 1
            mark(i, min(j + 1, n)); i = j + 1; prev = '"'; continue
        if c == '`':
            j, how = template(i + 1)
            if how == 'end':
                mark(i, j + 1); i = j + 1; prev = '"'; continue
            mark(i, j + 2); stack.append(depth); depth += 1; i = j + 2; prev = '{'; continue
        if c == '/' and i + 1 < n and src[i + 1] == '/':
            j = src.find('\n', i); j = n if j < 0 else j
            mark(i, j); i = j; continue
        if c == '/' and i + 1 < n and src[i + 1] == '*':
            j = src.find('*/', i + 2); j = n if j < 0 else j + 2
            mark(i, j); i = j; continue
        if c == '/':
            word = re.search(r'([A-Za-z_$][\w$]*)\s*$', src[max(0, i - 12):i])
            if prev in REGEX_BEFORE or prev == '' or (word and word.group(1) in REGEX_WORDS and prev not in ')]'):
                j, cls = i + 1, False
                while j < n and src[j] != '\n':
                    if src[j] == '\\':
                        j += 2; continue
                    if src[j] == '[':
                        cls = True
                    elif src[j] == ']':
                        cls = False
                    elif src[j] == '/' and not cls:
                        break
                    j += 1
                j += 1
                while j < n and (src[j].isalpha()):
                    j += 1
                mark(i, j); i = j; prev = '"'; continue
        if c == '{':
            depth += 1
        elif c == '}':
            depth -= 1
            if stack and depth == stack[-1]:   # the } that closes a ${ … }: back into the template's text
                stack.pop()
                j, how = template(i + 1)
                if how == 'end':
                    mark(i, j + 1); i = j + 1; prev = '"'; continue
                mark(i, j + 2); stack.append(depth); depth += 1; i = j + 2; prev = '{'; continue
        prev = c
        i += 1
    return m


def value_end(src, mask, i):
    """Where the expression starting at i ends: the first , } ] or ) outside any brackets it opens."""
    depth, n = 0, len(src)
    while i < n:
        if not mask[i]:
            c = src[i]
            if c in '([{':
                depth += 1
            elif c in ')]}':
                if depth == 0:
                    return i
                depth -= 1
            elif c == ',' and depth == 0:
                return i
        i += 1
    return n


def library_extents(src, mask):
    """The object literals that hold the slides: const LIBRARY = { … }, and any Object.assign(LIBRARY, { … })."""
    out = []
    for mm in re.finditer(r'\bLIBRARY\s*=\s*\{|Object\.assign\(\s*LIBRARY\s*,\s*\{', src):
        if mask[mm.start()]:
            continue
        a = mm.end() - 1
        out.append((a, match_close(src, mask, a)))
    return out


def match_close(src, mask, a):
    """The index just past the bracket that closes the one at a."""
    depth = 0
    for i in range(a, len(src)):
        if mask[i]:
            continue
        if src[i] in '([{':
            depth += 1
        elif src[i] in ')]}':
            depth -= 1
            if depth == 0:
                return i + 1
    return len(src)


def find_entry(src, mask, sid):
    """A slide's entry in LIBRARY: (key start, value start, value end), or None unless there is exactly one."""
    hits = [(k, v, e) for a, b in library_extents(src, mask) for name, k, v, e in props(src, mask, a, b) if name == sid]
    return hits[0] if len(hits) == 1 else None


def _string_starts(src, mask, k):
    """k is the opening quote of a string token in code."""
    return mask[k] and (k == 0 or not mask[k - 1])


def _trim(src, a, b):
    while b > a and src[b - 1] in ' \t\r\n':
        b -= 1
    return b


def props(src, mask, a, b):
    """The properties of the object literal src[a:b] ({ … }), one level deep: [(name, key start, value start, value end)]."""
    out, i = [], a + 1
    while i < b - 1:
        while i < b - 1 and (src[i] in ' \t\r\n,' or (mask[i] and src[i] not in '\'"')):
            i += 1
        if i >= b - 1:
            break
        mm = re.compile(r'([\'"]?)([\w$-]+)\1\s*:\s*').match(src, i)
        if not mm:   # a spread, a method, or something else: skip to the next comma
            i = value_end(src, mask, i) + 1
            continue
        v = mm.end()
        e = _trim(src, v, value_end(src, mask, v))
        out.append((mm.group(2), i, v, e))
        i = e
    return out


# ---------- editing ----------

class Edit:
    """Text edits on the deck file, applied at once (last first), so positions stay valid while planning."""

    def __init__(self, src):
        self.src, self.ops = src, []

    def replace(self, a, b, text):
        self.ops.append((a, b, text))

    def apply(self):
        out, ops = self.src, sorted(self.ops, key=lambda o: (o[0], o[1]), reverse=True)
        for k in range(1, len(ops)):
            if ops[k][1] > ops[k - 1][0]:
                raise ValueError('two edits overlap')
        for a, b, text in ops:
            out = out[:a] + text + out[b:]
        return out


def drop_prop(ed, src, mask, a, b, name, value_re):
    """Remove a  name: value  property inside src[a:b] (any depth; code only). True if it was there."""
    found = False
    for mm in re.finditer(r'\b' + name + r'\s*:\s*' + value_re, src[a:b]):
        s, e = a + mm.start(), a + mm.end()
        if mask[s]:
            continue
        after = re.compile(r'\s*,[ \t]*').match(src, e)
        if after:
            ed.replace(s, after.end(), '')
        else:   # the last property: take the comma before it instead
            before = re.search(r',\s*$', src[a:s])
            ed.replace(a + before.start() if before else s, e, '')
        found = True
    return found


def set_alt(ed, src, mask, k, v, e):
    """Give the entry whose value is src[v:e] alt:true: a property in an object literal, or Object.assign(…) around a helper call."""
    if src[v] != '{':
        ed.replace(v, v, 'Object.assign(')
        ed.replace(e, e, ', { alt: true })')
        return 'wrapped'
    ps = props(src, mask, v, e)
    for name, ks, vs, ve in ps:
        if name == 'alt':
            if src[vs:ve].strip() != 'true':
                ed.replace(vs, ve, 'true')
            return 'set'
    cat = next((p for p in ps if p[0] == 'cat'), None)
    if cat:
        comma = re.compile(r'\s*,[ \t]*').match(src, cat[3])
        at = comma.end() if comma else cat[3]
        ed.replace(at, at, 'alt: true, ' if comma else ', alt: true')
    else:
        first = ps[0][1] if ps else v + 1
        ed.replace(first, first, 'alt: true, ' if ps else ' alt: true ')
    return 'added'


def delete_entry(ed, src, k, e):
    """Delete a whole LIBRARY entry: its key, value, and the comma after it, and its line when it stands alone."""
    comma = re.compile(r'[ \t]*,').match(src, e)
    end = comma.end() if comma else e
    line_start = src.rfind('\n', 0, k) + 1
    rest = re.compile(r'[ \t]*(//[^\n]*)?\n').match(src, end)
    if src[line_start:k].strip() == '' and rest:
        ed.replace(line_start, rest.end(), '')
    else:
        ed.replace(k, end, '')


def pitches_extent(src, mask):
    mm = next((x for x in re.finditer(r'\bPITCHES\s*=\s*\{', src) if not mask[x.start()]), None)
    if not mm:
        return None
    a = mm.end() - 1
    return a, match_close(src, mask, a)


def string_tokens(src, mask, a, b, sid):
    """Each 'sid' (or "sid") written as an element of an array literal inside src[a:b]: [(start, end, array start, array end)]."""
    out = []
    for mm in re.finditer(r'([\'"])' + re.escape(sid) + r'\1', src[a:b]):
        s, e = a + mm.start(), a + mm.end()
        if not _string_starts(src, mask, s):
            continue
        before = src[:s].rstrip()[-1:]
        after = src[e:].lstrip()[:1]
        if before not in '[,' or after not in ',]':
            continue
        # the array it sits in
        depth, j = 0, s
        while j > a:
            j -= 1
            if mask[j]:
                continue
            if src[j] in ')]}':
                depth += 1
            elif src[j] in '([{':
                if depth == 0:
                    break
                depth -= 1
        if src[j] != '[':
            continue
        out.append((s, e, j, match_close(src, mask, j)))
    return out


def drop_element(ed, src, s, e):
    after = re.compile(r'\s*,[ \t]*').match(src, e)
    if after:
        ed.replace(s, after.end(), '')
    else:
        before = re.search(r',\s*$', src[:s])
        ed.replace(before.start() if before else s, e, '')


def bake(src, decisions, used_figs=True):
    """Write decisions into a deck file's text. decisions: {proposal id: {'decision': 'accept'|'keep', 'replaces': id}}.
    Returns (new text, notes per proposal, problems per proposal). A proposal with a problem is left as it was."""
    mask = code_mask(src)
    ed, notes, problems = Edit(src), {}, {}
    pit = pitches_extent(src, mask)
    for p, d in decisions.items():
        o, how = d.get('replaces') or '', d['decision']
        ent = find_entry(src, mask, p)
        if not ent:
            problems[p] = f"couldn't find one LIBRARY entry written as '{p}': {{ … }}"
            continue
        k, v, e = ent
        trial = Edit(src)   # plan this proposal on its own first, so one that fails leaves nothing half done
        msgs = []
        try:
            if how == 'accept':
                if not drop_prop(trial, src, mask, v, e, 'prop', r'(?:true|1|!0)\b'):
                    raise ValueError('it no longer has prop:true')
                drop_prop(trial, src, mask, v, e, 'replaces', r'([\'"])' + re.escape(o) + r'\1')
                oe = find_entry(src, mask, o) if o else None
                if o and not oe:
                    msgs.append(f"its original '{o}' isn't in the file, so only the proposal changed")
                elif oe:
                    r = set_alt(trial, src, mask, *oe)
                    msgs.append({'wrapped': f"'{o}' is made by a helper, so it is now Object.assign(…, {{ alt: true }})",
                                 'set': f"'{o}' was already an extra", 'added': f"'{o}' gets alt: true"}[r])
                if pit and o:
                    hand = string_tokens(src, mask, pit[0], pit[1], o)
                    for s1, e1, aa, ab in hand:
                        if string_tokens(src, mask, aa, ab, p):
                            drop_element(trial, src, s1, e1)
                        else:
                            trial.replace(s1, e1, src[s1] + p + src[s1])
                    if hand:
                        msgs.append(f"{'a version' if len(hand) == 1 else f'{len(hand)} versions'} that list{'s' if len(hand) == 1 else ''} '{o}' by hand now list{'s' if len(hand) == 1 else ''} '{p}'")
            elif how == 'keep':
                delete_entry(trial, src, k, e)
                if pit:
                    hand = string_tokens(src, mask, pit[0], pit[1], p)
                    for s1, e1, aa, ab in hand:
                        drop_element(trial, src, s1, e1)
                    if hand:
                        msgs.append(f"left out of {'a version' if len(hand) == 1 else f'{len(hand)} versions'} that listed '{p}' by hand")
                fig = re.search(r'\bfig\s*:\s*([\'"])([\w$]+)\1', src[v:e])
                if fig and used_figs and len(re.findall(r'\bfig\s*:\s*([\'"])' + re.escape(fig.group(2)) + r'\1', src)) == 1:
                    msgs.append(f"FIGS.{fig.group(2)} drew only this slide; delete it from FIGS if you like")
            else:
                raise ValueError(f'unknown decision {how!r}')
        except (ValueError, AttributeError) as x:
            problems[p] = str(x)
            continue
        ed.ops.extend(trial.ops)
        notes[p] = msgs
    try:
        return ed.apply(), notes, problems
    except ValueError as x:
        return src, {}, {p: f'edits overlap ({x}); bake these one at a time' for p in decisions}


# ---------- where a proposal is filed ----------
# A proposal shows where its original shows only when it is filed like it: the same cat, the same flags that keep a
# slide out of the default versions (alt, fac, only), right after it in LIBRARY (its other options may sit between),
# and, in a version that lists its slides by hand, right after it in that list. placement() says, in plain words,
# which proposals aren't; fix_placement() files them next to their original, editing the deck file as text like bake().

FLAGS = ('alt', 'fac', 'only')


def hand_lists(src, mask):
    """The versions whose blocks are written out as an array literal: {version: (array start, array end)}."""
    pit, out = pitches_extent(src, mask), {}
    for name, k, v, e in (props(src, mask, *pit) if pit else []):
        if src[v] == '{':
            for n2, k2, v2, e2 in props(src, mask, v, e):
                if n2 == 'blocks' and src[v2] == '[':
                    out[name] = (v2, e2)
    return out


def _quoted(vs):
    return ' and '.join(f"'{v}'" for v in vs) if len(vs) < 3 else ', '.join(f"'{v}'" for v in vs[:-1]) + f", and '{vs[-1]}'"


def placement(info, src=None):
    """Every proposal that won't appear where its original appears: [{'p', 'o', 'why', 'fixable'}], in LIBRARY order.
    info: what `node browser.mjs proposals <deck>` reports (the deck as it builds); src: the deck file, which tells
    the versions listed by hand from the ones built from LIBRARY."""
    mask = code_mask(src) if src else None
    hand = hand_lists(src, mask) if src else {}
    blocks, names, main = info['blocks'], info.get('catNames') or {}, info.get('main')
    versions = sorted(blocks, key=lambda v: v != main)   # the main version first: it is the one named
    opts = {}
    for x in info['pairs']:
        opts.setdefault(x['o'], []).append(x['p'])
    where = lambda cat, flags: f"{names.get(cat) or cat} (cat '{cat}'{''.join(', ' + f for f in flags)})"
    out = []
    for x in info['pairs']:
        p, o = x['p'], x['o']
        if x.get('missing'):
            out.append({'p': p, 'o': o, 'fixable': False, 'why': f"{p} won't show as a proposal: it replaces '{o}', which isn't a slide in LIBRARY."})
            continue

        def run(v):   # the original and the options right after it, in version v
            B = blocks[v]; i = B.index(o) + 1
            while i < len(B) and B[i] in opts[o]:
                i += 1
            return B[B.index(o) + 1:i]
        n = lambda v, i: blocks[v].index(i) + 1
        missing = [v for v in versions if o in blocks[v] and p not in blocks[v]]
        alone = [v for v in versions if p in blocks[v] and o not in blocks[v]]
        apart = [v for v in versions if o in blocks[v] and p in blocks[v] and p not in run(v)]
        if 'pcat' not in x:   # an older browser job: nothing to check against
            continue
        filed = x['pcat'] != x['ocat'] or sorted(x['pflags']) != sorted(x['oflags'])
        far = x.get('gap', 0) > 0 or x.get('before')
        why, fixable = [], True
        pw, ow = where(x['pcat'], x['pflags']), where(x['ocat'], x['oflags'])
        if filed:
            if missing:
                v = missing[0]
                why.append(f"{p} won't show: its original is slide {n(v, o)} of '{v}', but the proposal is filed in {pw}.")
            elif alone:
                why.append(f"{p} would show in '{alone[0]}' without its original: the original is filed in {ow}, the proposal in {pw}.")
            elif apart:
                v = apart[0]
                why.append(f"{p} won't show next to its original: in '{v}' the original is slide {n(v, o)} and the proposal slide {n(v, p)}, "
                           f"as the proposal is filed in {pw} and the original in {ow}.")
            else:
                why.append(f"{p} is filed in {pw}, but its original is in {ow}.")
        elif far and [v for v in apart if v not in hand]:
            v = [v for v in apart if v not in hand][0]
            why.append(f"{p} won't show next to its original: in '{v}' the original is slide {n(v, o)} and the proposal slide {n(v, p)}, "
                       f"because it sits {x['gap']} entr{'y' if x['gap'] == 1 else 'ies'} {'above' if x.get('before') else 'below'} its original in LIBRARY."
                       if x['gap'] else f"because it sits above its original in LIBRARY.")
        lists = [v for v in missing if v in hand]
        if lists:
            one = len(lists) == 1
            why.append(f"{'It also' if why else p} won't show in {_quoted(lists)}: {'that version lists its' if one else 'those versions list their'} slides by hand "
                       f"and {'has' if one else 'have'} the original{f' (slide {n(lists[0], o)})' if one else ''} but not the proposal.")
        moved = [v for v in apart if v in hand]
        if moved:
            why.append(f"{'In' if why else p + ' is apart from its original in'} {_quoted(moved)}{', which list' if len(moved) > 1 else ', which lists'} "
                       f"slides by hand, {'it' if why else 'the proposal'} isn't right after its original.")
        other = [v for v in missing if v not in hand] if not filed else []
        if other:
            why.append(f"{'It also' if why else p} won't show in {_quoted(other)}, which {'has' if len(other) == 1 else 'have'} its original: fix that version by hand.")
            fixable = False
        lone = [v for v in alone if v in hand] if not filed else []
        if lone:
            why.append(f"{'It' if why else p} shows in {_quoted(lone)} without its original, which {'that version doesn’t' if len(lone) == 1 else 'those versions don’t'} list: fix by hand.")
            fixable = False
        if why:
            out.append({'p': p, 'o': o, 'why': ' '.join(why), 'fixable': fixable})
    return out


def _drop_named(ed, src, mask, v, e, name):
    """Remove the top-level property name from the object literal src[v:e]."""
    ps = props(src, mask, v, e)
    for i, (nm, ks, vs, ve) in enumerate(ps):
        if nm != name:
            continue
        after = re.compile(r'\s*,[ \t]*').match(src, ve)
        if after:
            ed.replace(ks, after.end(), '')
        else:
            before = re.search(r',\s*$', src[v:ks])
            ed.replace(v + before.start() if before else ks, ve, '')
        return True
    return False


def _retag(src, mask, v, e, cat, flags, flag_text, quote="'"):
    """src[v:e] (an object literal) with the given cat and exactly these flags (alt, fac, only), as new text."""
    ed, ps = Edit(src), props(src, mask, v, e)
    have = {nm: (ks, vs, ve) for nm, ks, vs, ve in ps}
    adds = []
    if 'cat' in have:
        ks, vs, ve = have['cat']
        if src[vs:ve].strip()[1:-1] != cat:
            q = src[vs] if src[vs] in '\'"' else quote
            ed.replace(vs, ve, q + cat + q)
    elif cat is not None:
        adds.append(f'cat: {quote}{cat}{quote}')
    for f in FLAGS:
        if f in have and f not in flags:
            _drop_named(ed, src, mask, v, e, f)
        elif f not in have and f in flags:
            adds.append(f'{f}: {flag_text.get(f, "true")}')
    if adds:
        if 'cat' in have:   # right after the cat, the way the decks write them
            comma = re.compile(r'\s*,[ \t]*').match(src, have['cat'][2])
            if comma:
                ed.replace(comma.end(), comma.end(), ', '.join(adds) + ', ')
            else:
                ed.replace(have['cat'][2], have['cat'][2], ', ' + ', '.join(adds))
        else:
            first = ps[0][1] if ps else v + 1
            ed.replace(first, first, ', '.join(adds) + (', ' if ps else ' '))
    whole = ed.apply()
    return whole[v:e + len(whole) - len(src)]


def _entries(src, mask):
    """Every LIBRARY entry written in the file, in file order: [(id, key start, value start, value end)]."""
    return [t for a, b in library_extents(src, mask) for t in props(src, mask, a, b)]


def _after_entry(src, e):
    """Where a new entry goes after the one that ends at e: on the next line, on the same line after its comma,
    or after it when it is the last one and has no comma."""
    m = re.compile(r'[ \t]*,[ \t]*(//[^\n]*)?\n').match(src, e)
    if m:
        return m.end(), 'line'
    m = re.compile(r'[ \t]*,').match(src, e)
    return (m.end(), 'same') if m else (e, 'last')


def fix_placement(src, info, only=None):
    """File each misplaced proposal (or those in only) next to its original: in LIBRARY right after the original and
    its other options, with the original's cat and flags; and in every version listed by hand that has the original,
    right after it. Returns (new text, notes per proposal, problems per proposal)."""
    pairs = {x['p']: x for x in info['pairs']}
    opts = {}
    for x in info['pairs']:
        opts.setdefault(x['o'], []).append(x['p'])
    notes, problems = {}, {}
    for item in placement(info, src):
        p, o = item['p'], item['o']
        if only is not None and p not in only:
            continue
        x, msgs = pairs[p], []
        if x.get('missing'):
            problems[p] = f"it replaces '{o}', which isn't a slide in LIBRARY: point replaces at the slide it is for"
            continue
        mask = code_mask(src)
        try:
            ents = _entries(src, mask)
            ids = [t[0] for t in ents]
            if ids.count(p) != 1 or ids.count(o) != 1:
                raise ValueError(f"couldn't find one LIBRARY entry each written as '{p}': {{ … }} and '{o}': {{ … }}")
            ed = Edit(src)
            _, pk, pv, pe = ents[ids.index(p)]
            _, ok_, ov, oe = ents[ids.index(o)]
            if src[pv] != '{':
                raise ValueError(f"'{p}' is made by a helper, not written out as {{ … }}")
            io, ip = ids.index(o), ids.index(p)
            in_run = ip > io and all(t in opts[o] for t in ids[io + 1:ip])   # only its other options between them
            i = io + 1   # past the original's run: the other options right after it in the file
            while i < len(ids) and ids[i] in opts[o] and ids[i] != p:
                i += 1
            flag_text = {}
            if src[ov] == '{':
                for nm, ks, vs, ve in props(src, mask, ov, oe):
                    if nm in FLAGS:
                        flag_text[nm] = src[vs:ve]
            want_flags = list(x['oflags'])
            body = _retag(src, mask, pv, pe, x['ocat'], want_flags, flag_text)
            if x['pcat'] != x['ocat']:
                msgs.append(f"cat '{x['pcat']}' → '{x['ocat']}'")
            gone, came = [f for f in x['pflags'] if f not in want_flags], [f for f in want_flags if f not in x['pflags']]
            if gone:
                msgs.append('no ' + ', '.join(gone))
            if came:
                msgs.append(', '.join(came) + ' like its original')
            if in_run:
                if body != src[pv:pe]:
                    ed.replace(pv, pe, body)
            else:
                last = ents[i - 1]   # the original, or its last option
                line_start = src.rfind('\n', 0, last[1]) + 1
                indent = src[line_start:last[1]] if not src[line_start:last[1]].strip() else '  '
                comma = re.compile(r'[ \t]*,').match(src, pe)
                rest = re.compile(r'[ \t]*(//[^\n]*)?\n').match(src, comma.end() if comma else pe)
                tail = (' ' + rest.group(1)) if rest and rest.group(1) else ''
                at, how = _after_entry(src, last[3])
                text = src[pk:pv] + body
                ed.replace(at, at, {'line': f'{indent}{text},{tail}\n', 'same': f' {text},', 'last': f',\n{indent}{text}'}[how])
                delete_entry(ed, src, pk, pe)
                msgs.insert(0, f"moved right after '{ents[i - 1][0]}' in LIBRARY")
            for v, (a, b) in hand_lists(src, mask).items():
                ot = string_tokens(src, mask, a, b, o)
                if len(ot) != 1:
                    continue
                s1, e1 = ot[0][0], ot[0][1]
                pt = string_tokens(src, mask, a, b, p)
                j, end = e1, e1   # past the original's options listed right after it
                while True:
                    m = re.compile(r'\s*,\s*([\'"])([\w$-]+)\1').match(src, j)
                    if not m or m.group(2) not in opts.get(o, []) or m.group(2) == p:
                        break
                    j = end = m.end()
                nxt = re.compile(r'\s*,\s*([\'"])([\w$-]+)\1').match(src, end)
                if pt and nxt and nxt.group(2) == p:
                    continue   # already right after it
                for s2, e2, _, _ in pt:
                    drop_element(ed, src, s2, e2)
                ed.replace(end, end, f', {src[s1]}{p}{src[s1]}')
                msgs.append(f"{'moved next to' if pt else 'added after'} '{o}' in '{v}'")
            src = ed.apply()
        except (ValueError, AttributeError) as e:
            problems[p] = str(e)
            continue
        notes[p] = msgs
    return src, notes, problems
