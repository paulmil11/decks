/* Decks: Review copy (Share menu).
   The file to send someone outside, a client say, who should comment and edit and then send it
   back for `sb import`. It is the deck itself, cut down to the version on screen as it looks now:
   - kept: the slides on screen (your edits and order included), editable text, a comment box under
     each slide, "Save a copy with my edits", and the deck's storage key, so sb import takes it back;
   - left out of its source, not just hidden: the facilitator notes, your comments (open or already
     handled), facilitator slides, the other versions and the slides only they use, and the Decks shell.
   The slides (LIBRARY), the version (PITCHES), and the figures (FIGS) are written out fresh from what
   the page holds, for the slides kept. Every slide's saved text ends with its facilitator note, so
   the copy carries a blank note in its place, and a "review-copy" block with what sb import needs to
   put yours back: the version, and per slide where the note sits and a fingerprint of its default
   text without the note.
   Before anything downloads, the file runs in a sandboxed frame twice (to learn its own text
   fingerprints, then to check the finished file shows these slides with this text) and is searched
   for what it must not carry. If a check fails, nothing downloads and it says why. */
(function () {
  const SB = window.__SB, deck = document.getElementById('deck');
  const API = window.SlideBuilder;
  if (!SB || !deck || !API || !API.shareItem || SB.readonly || !document.getElementById('save-copy')) return;
  /* eslint-disable no-undef */
  const get = (f) => { try { return f(); } catch (e) { return undefined; } };
  const LIB = () => get(() => LIBRARY), PIT = () => get(() => PITCHES), VER = () => get(() => current);
  /* eslint-enable no-undef */
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const api = (p) => '/api/decks/' + SB.slug + '/' + p;
  const say = (t) => { try { window.SlideBuilder.say(t); } catch (e) {} };
  const djb = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return String(h); };
  const fields = (w) => [...w.querySelectorAll('[contenteditable]')];
  const noteAt = (ns) => ns.findIndex((n) => n.classList.contains('fnote'));
  const plain = (n) => (n.textContent || '').replace(/\s+/g, ' ').trim();
  const SAVED = /<script id="saved-edits" type="application\/json">[\s\S]*?<\/script>/;
  const setSaved = (html, json) => html.replace(SAVED, () => '<script id="saved-edits" type="application/json">' + json.replace(/<\//g, '<\\/') + '</script>');

  // ---------- a value the page holds, written back as JavaScript (slides are plain data) ----------
  function lit(v, seen = new Set()) {
    if (v === null || v === undefined) return String(v);
    switch (typeof v) {
      case 'string': return JSON.stringify(v).replace(/<(\/|!--)/g, '<\\$1').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
      case 'number': return Number.isFinite(v) ? String(v) : (v !== v ? 'NaN' : v > 0 ? 'Infinity' : '-Infinity');
      case 'boolean': return String(v);
      case 'function': { const s = v.toString(); return '(' + (/^(async\s+)?(function\b|\(|[\w$]+\s*=>|class\b)/.test(s) ? s : 'function ' + s) + ')'; }
      case 'object': {
        if (seen.has(v)) throw new Error('a slide refers to itself');
        seen.add(v);
        let out;
        if (Array.isArray(v)) out = '[' + v.map((x) => lit(x, seen)).join(',') + ']';
        else if (v instanceof RegExp) out = v.toString();
        else if ([Object.prototype, null].includes(Object.getPrototypeOf(v))) out = '{' + Object.keys(v).filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ':' + lit(v[k], seen)).join(',') + '}';
        else throw new Error('a slide holds a ' + ((v.constructor && v.constructor.name) || 'value') + ', which a copy can’t write out');
        seen.delete(v);
        return out;
      }
    }
    throw new Error('a slide holds a ' + typeof v + ', which a copy can’t write out');
  }

  // ---------- where `const NAME = …;` sits in the deck's source ----------
  // Strings, template literals, comments, and regular expressions are skipped, so a brace or a
  // semicolon inside them doesn't count. The result must parse on its own, or it isn't used.
  const WORDS = /^(return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/;
  function quoted(src, i, q) { for (i++; i < src.length; i++) { const c = src[i]; if (c === '\\') i++; else if (c === q) return i + 1; else if (c === '\n') return -1; } return -1; }
  function template(src, i) {
    for (i++; i < src.length; i++) {
      const c = src[i];
      if (c === '\\') i++;
      else if (c === '`') return i + 1;
      else if (c === '$' && src[i + 1] === '{') { const j = scan(src, i + 2, '}'); if (j < 0) return -1; i = j; }
    }
    return -1;
  }
  function regex(src, i) {
    let cls = false;
    for (i++; i < src.length; i++) {
      const c = src[i];
      if (c === '\\') i++;
      else if (c === '\n') return -1;
      else if (cls) { if (c === ']') cls = false; }
      else if (c === '[') cls = true;
      else if (c === '/') { i++; while (/[a-z]/i.test(src[i] || '')) i++; return i; }
    }
    return -1;
  }
  function scan(src, i, stop, until = -1) {   // the index of `stop` at depth 0 from i, or -1; with until, until itself if the scan gets there at depth 0
    let depth = 0, prev = '(';
    while (i < src.length) {
      if (until >= 0 && i >= until) return i === until && !depth ? i : -1;   // past it: it was inside a string or a comment
      const c = src[i], d = src[i + 1];
      if (c === '/' && d === '/') { const j = src.indexOf('\n', i); if (j < 0) return -1; i = j; continue; }
      if (c === '/' && d === '*') { const j = src.indexOf('*/', i + 2); if (j < 0) return -1; i = j + 2; continue; }
      if (c === '"' || c === "'") { i = quoted(src, i, c); if (i < 0) return -1; prev = 'x'; continue; }
      if (c === '`') { i = template(src, i); if (i < 0) return -1; prev = 'x'; continue; }
      if (c === '/' && (/[(,=:[!&|?{};+\-*%<>~^]/.test(prev) || WORDS.test(prev))) { i = regex(src, i); if (i < 0) return -1; prev = 'x'; continue; }
      if (/[\w$]/.test(c)) { let j = i + 1; while (j < src.length && /[\w$]/.test(src[j])) j++; prev = src.slice(i, j); i = j; continue; }
      if (depth === 0 && c === stop) return i;
      if (c === '(' || c === '[' || c === '{') depth++;
      else if ((c === ')' || c === ']' || c === '}') && --depth < 0) return -1;
      if (!/\s/.test(c)) prev = c;
      i++;
    }
    return -1;
  }
  function outside(src, at) {   // whether `at` sits in a <script> outside every bracket, string, and comment
    const open = src.lastIndexOf('<script', at), body = open < 0 ? -1 : src.indexOf('>', open) + 1;
    if (body <= 0 || body > at || src.lastIndexOf('</script', at) > open) return false;
    return scan(src, body, null, at) === at;
  }
  function region(src, name) {   // [start, end) of the one top-level `const NAME = …;` at the start of a line, or null
    let hits = [...src.matchAll(new RegExp('(^|\\n)(?:const|let|var)\\s+' + name + '\\s*=', 'g'))];
    // a deck made with extra pieces (a CEO deck, say) also sets PITCHES inside TEMPLATE_PITCHES, the
    // template's own versions: of several, the one that counts is the one at the top of its script
    if (hits.length > 1) hits = hits.filter((h) => outside(src, h.index + h[1].length));
    if (hits.length !== 1) return null;
    const start = hits[0].index + hits[0][1].length, from = hits[0].index + hits[0][0].length, end = scan(src, from, ';');
    if (end < 0) return null;
    try { new Function('return (' + src.slice(from, end) + '\n)'); } catch (e) { return null; }   // parses only; nothing runs
    return [start, end + 1];
  }

  // ---------- run a copy in a sandboxed frame and read back what it shows ----------
  // No same-origin: the copy can't reach this page or its storage, so it starts from what it carries.
  const PROBE_HEAD = '<script>window.__rcErr=[];window.addEventListener("error",function(e){window.__rcErr.push(String(e.message||e.error||e))});<\/script>';
  const PROBE = `<script>(function(){function t(n){return (n.textContent||'').replace(/\\s+/g,' ').trim();}
function dj(s){var h=5381;for(var i=0;i<s.length;i++)h=((h<<5)+h+s.charCodeAt(i))|0;return String(h);}
function go(){var o={err:(window.__rcErr||[]).slice(),ids:[],text:{},defs:{},notes:{}};
try{[].slice.call(document.querySelectorAll('#deck > [data-id]')).forEach(function(w){var id=w.getAttribute('data-id');o.ids.push(id);
o.text[id]=[].slice.call(w.querySelectorAll('[contenteditable]')).filter(function(n){return !n.classList.contains('fnote');}).map(t);});
o.ids.forEach(function(id){var f=build(id),ns=[].slice.call(f.querySelectorAll('[contenteditable]')),at=-1;ns.forEach(function(n,i){if(n.classList.contains('fnote'))at=i;});
o.notes[id]=[at,at>=0?ns[at].innerHTML:null];o.defs[id]=typeof defHash==='function'?defHash(id):dj(ns.map(function(n){return n.innerHTML;}).join('\\u0001'));});}
catch(e){o.err.push(String(e&&e.message||e));}
parent.postMessage({rc:'TOKEN',o:o},'*');}
if(document.readyState==='complete')setTimeout(go,400);else window.addEventListener('load',function(){setTimeout(go,400);});})();<\/script>`;
  function run(html) {
    return new Promise((resolve) => {
      const token = Math.random().toString(36).slice(2);
      let doc = html.replace(/<head[^>]*>/i, (m) => m + PROBE_HEAD);
      const i = doc.toLowerCase().lastIndexOf('</body>'), probe = PROBE.replace('TOKEN', token);
      doc = i >= 0 ? doc.slice(0, i) + probe + doc.slice(i) : doc + probe;
      const f = document.createElement('iframe');
      f.setAttribute('sandbox', 'allow-scripts');
      f.setAttribute('aria-hidden', 'true');
      f.style.cssText = 'position:fixed;left:0;top:0;width:1400px;height:900px;border:0;opacity:0;pointer-events:none;z-index:-1';
      const done = (o) => { window.removeEventListener('message', on); clearTimeout(t); f.remove(); resolve(o); };
      const on = (e) => { if (e.source === f.contentWindow && e.data && e.data.rc === token) done(e.data.o); };
      window.addEventListener('message', on);
      const t = setTimeout(() => done(null), 45000);
      f.srcdoc = doc;
      document.body.appendChild(f);
    });
  }

  // ---------- what the copy must not carry ----------
  // Each item is searched for by its longest stretch without quotes, tags, or markup, so the escaping
  // of a JS string or of saved HTML doesn't hide it. A stretch the copy shows anyway doesn't count;
  // for slide text and version names, neither does one the deck's own code carries (layout defaults).
  function stretch(s) {
    return String(s).replace(/<[^>]+>/g, '\n').split(/['"\\&<>\n\r\t*`]|\s{2,}/).map((x) => x.trim()).reduce((a, b) => (b.length > a.length ? b : a), '');
  }
  function strings(v, out = []) {
    if (typeof v === 'string') out.push(v);
    else if (v && typeof v === 'object') Object.values(v).forEach((x) => strings(x, out));
    return out;
  }
  function leaks(file, items, shown, engine) {
    const text = file.replace(/data:[\w.+-]+\/[\w.+-]+;base64,[A-Za-z0-9+/=]+/g, '');
    const found = {}, seen = new Set();
    items.forEach(([kind, id, s, generic]) => {
      const x = stretch(s);
      if (x.length < 16 || seen.has(kind + x)) return;
      seen.add(kind + x);
      if (!text.includes(x) || shown.includes(x) || (generic && engine.includes(x))) return;
      (found[kind] = found[kind] || new Set()).add(id);
    });
    ['__SB_BOOT', '/_sb/', 'id="sb-boot', 'id="sb-shell'].forEach((m) => { if (text.includes(m)) (found.shell = found.shell || new Set()).add(m); });
    return found;
  }
  const KINDS = { notes: 'facilitator notes', comments: 'comments', fac: 'facilitator slides', other: 'slides from other versions', versions: 'other versions’ names', shell: 'the Decks shell' };

  // ---------- the copy ----------
  const HOWTO = '<strong>Comment under any slide, or click text to change it.</strong> Then click <strong>Save a copy with my edits</strong> and send that file back.';
  // a reviewer gets the deck's logo and name, a short instruction, and the two buttons they need: none of the editor's controls
  const REVIEW_CSS = '<style id="review-copy-css">#copy-edits, #presenter-btn, .opt-row:has(#notes-toggle), .fnote, .brand-sub, .sidebar .field-label, #pitch-select, #block-list, #reload-btn { display: none !important; }'
    + ' .rc-brand { display: flex; flex-direction: column; align-items: flex-start; gap: 10px; } .rc-brand img { max-height: 30px; max-width: 70%; display: block; } .rc-brand span { font-size: 1.05rem; line-height: 1.3; }'
    + ' .sidebar .toolbar { margin-top: 1.2rem; }'
    // the parts around the slides keep the editor's colors, whatever text color a deck's theme sets for the page (a dark deck's light text)
    + ' html body .stage-head h1 { color: #272322; } html body .stage-head p, html body .slide-no code, html body .slide-no .of { color: #635B58; }'
    + ' html body .view-toggle button { color: #635B58; } html body .view-toggle button.on { color: #fff; }'
    + ' html body .ctrls .cbtn { color: #635B58; background: rgba(255,255,255,.94); border-color: rgba(0,0,0,.14); }'
    + ' html body .btn-outline { color: #272322; border-color: #D9D4D0; } html body .fb { color: #272322; } html body .fb::placeholder { color: #948C88; }</style>';
  // the logo the slides carry (StrategyU's, or the deck's own), and the deck's name without the brand in front
  const brandOf = () => { const lg = deck.querySelector('.slide img.logo, .slide .logo img, .slide .logo'), src = lg && (lg.getAttribute('src') || (lg.querySelector('img') || {}).getAttribute?.('src'));
    const b = document.querySelector('.sidebar .brand'), t = b ? b.textContent.replace(/\s+/g, ' ').trim() : '', name = (t.split(' · ').pop() || SB.name || '').trim();
    return `<div class="brand rc-brand">${src && !/^data:|^https?:/.test(src) ? `<img src="${esc(src)}" alt="">` : ''}<span>${esc(name)}</span></div>`; };
  const versionLabel = () => { const s = document.getElementById('sb-version') || document.querySelector('.sidebar select');
    return s && s.options.length > 1 && s.selectedIndex >= 0 ? s.options[s.selectedIndex].text.trim() : ''; };
  const fileName = () => [SB.name, versionLabel()].filter(Boolean).join(' · ').replace(/[\\/:*?"<>|]+/g, '-').trim() + ' (review).html';

  class Stop extends Error {}
  async function make() {
    const L = LIB(), P = PIT(), v = VER(), html0 = get(() => ORIGINAL_HTML), build = window.build;   // eslint-disable-line no-undef
    if (!L || !P || !v || !P[v] || typeof html0 !== 'string' || !SAVED.test(html0) || typeof build !== 'function')
      throw new Stop('This deck runs on a builder without “Save a copy with my edits”, so it can’t make a review copy.');
    const order = [...deck.children].filter((w) => w.dataset && w.dataset.id && L[w.dataset.id]).map((w) => w.dataset.id);
    const kept = order.filter((id) => !L[id].fac), K = new Set(kept);
    if (!kept.length) throw new Stop('There are no slides on screen to put in a review copy.');
    const wrapOf = (id) => [...deck.children].find((w) => w.dataset && w.dataset.id === id);
    const live = get(() => currentData()) || {};   // eslint-disable-line no-undef
    const liveText = {};
    kept.forEach((id) => { const w = wrapOf(id), ns = fields(w), at = noteAt(ns);
      if (!Array.isArray(live[id])) live[id] = ns.map((n) => n.innerHTML);
      liveText[id] = ns.filter((n, i) => i !== at).map(plain); });

    // for sb import: where each slide's note sits, and its default text without the note, as the
    // deck builds it in this version (the original-image and added-slide toggles set aside)
    const marks = {}, O = get(() => ORIG), A = get(() => ADDED);   // eslint-disable-line no-undef
    const oldO = O instanceof Set ? [...O] : null, oldA = A instanceof Set ? [...A] : null;
    try {
      if (oldO) O.clear(); if (oldA) A.clear();
      kept.forEach((id) => { const ns = fields(build(id)), at = noteAt(ns); marks[id] = [at, djb(ns.filter((n, i) => i !== at).map((n) => n.innerHTML).join('\u0001'))]; });
    } finally { if (oldO) oldO.forEach((x) => O.add(x)); if (oldA) oldA.forEach((x) => A.add(x)); }

    // the slides, figures, version, and parts, written out for the slides kept
    const libIds = Object.keys(L).filter((id) => K.has(id));
    let libLit, figLit = null;
    try { libLit = '{\n' + libIds.map((id) => { const e = Object.assign({}, L[id]); delete e.notes; return JSON.stringify(id) + ': ' + lit(e); }).join(',\n') + '\n}'; }
    catch (e) { throw new Stop(`Couldn’t write the slides out: ${e.message}.`); }
    const F = get(() => FIGS);   // eslint-disable-line no-undef
    if (F && typeof F === 'object' && Object.keys(F).length) {
      const R = {};
      libIds.forEach((id) => { const b = L[id]; if (b.fig == null || typeof F[b.fig] !== 'function') return; const r = R[b.fig] = R[b.fig] || {};
        try { r.null = String(F[b.fig]()); } catch (e) {}
        if (b.arg !== undefined) { try { r[JSON.stringify(b.arg)] = String(F[b.fig](b.arg)); } catch (e) {} } });
      figLit = "((R) => { const F = {}; Object.keys(R).forEach((k) => { F[k] = (a) => { const r = R[k][JSON.stringify(a === undefined ? null : a)]; return r === undefined ? '' : r; }; }); return F; })(" + lit(R) + ')';
    }
    const pv = {};
    Object.keys(P[v]).forEach((k) => { if (!['blocks', 'default'].includes(k) && ['string', 'number', 'boolean'].includes(typeof P[v][k])) pv[k] = P[v][k]; });
    Object.assign(pv, { default: true, blocks: kept });
    const parts = new Set(libIds.map((id) => L[id].cat)), only = (o) => { const r = {}; Object.keys(o).forEach((k) => { if (parts.has(k)) r[k] = o[k]; }); return r; };
    const C = get(() => CATS), CL = get(() => CAT_LABELS), CS = get(() => CAT_SHORT);   // eslint-disable-line no-undef
    const swaps = { LIBRARY: libLit, PITCHES: lit({ [v]: pv }), TEMPLATE_PITCHES: '{}', FIGS: figLit, DONE_FB: '[]', PREV_DEFAULTS: '{}',
      CATS: Array.isArray(C) ? lit(C.filter((c) => parts.has(c))) : null, CAT_LABELS: CL && typeof CL === 'object' ? lit(only(CL)) : null, CAT_SHORT: CS && typeof CS === 'object' ? lit(only(CS)) : null };

    let html = setSaved(html0, 'null').replace(/<script id="review-copy" type="application\/json">[\s\S]*?<\/script>\n?/g, ''), engine = html;
    const at = {};
    Object.keys(swaps).forEach((name) => { if (swaps[name] !== null) at[name] = region(html, name); });
    const missing = ['LIBRARY', 'PITCHES'].concat(figLit ? ['FIGS'] : []).filter((n) => !at[n]);
    if (missing.length) throw new Stop(`Couldn’t find where the deck’s source sets ${missing.join(' and ')}, so a review copy can’t leave the rest out.`);
    Object.keys(at).filter((n) => at[n]).sort((a, b) => at[b][0] - at[a][0]).forEach((n) => {
      const [s, e] = at[n];
      engine = engine.slice(0, s) + engine.slice(e);
      html = html.slice(0, s) + `const ${n} = ${swaps[n]};` + html.slice(e);
    });
    // the basic layouts behind Add a slide: decks made from a template add them to LIBRARY in a block
    // of their own (templates/_engine/basics.js). Any of them on screen is in the LIBRARY written above.
    const basics = (s) => { const i = s.indexOf('/* Basic layouts every new deck carries'); if (i < 0) return s;
      const from = s.indexOf('(() => {', i), end = from < 0 ? -1 : scan(s, from, ';');
      if (end < 0) throw new Stop('Couldn’t find the end of the deck’s basic layouts block, so a review copy can’t leave it out.');
      return s.slice(0, i) + s.slice(end + 1); };
    // slides set one at a time after LIBRARY (a piece's placeholder slide, until Claude builds that
    // version): any of them on screen is in the LIBRARY written above too, so their lines go
    const added = (s) => { [...s.matchAll(/(^|\n)LIBRARY\[(?:"[^"\\\n]*"|'[^'\\\n]*')\]\s*=/g)].reverse().forEach((h) => {
      const start = h.index + h[1].length; if (!outside(s, start)) return;
      const end = scan(s, h.index + h[0].length, ';');
      if (end < 0) throw new Stop('Couldn’t find the end of a slide the deck’s source adds on its own line, so a review copy can’t leave it out.');
      s = s.slice(0, start) + s.slice(end + 1); }); return s; };
    html = added(basics(html)); engine = added(basics(engine));
    // a plain string constant nothing uses any more (the notes placeholder in new decks, say) goes blank
    html = html.replace(/^const ([A-Za-z_][\w]*) = ('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*");[ \t]*$/gm, (m, name) =>
      ((html.match(new RegExp('\\b' + name + '\\b', 'g')) || []).length > 1 ? m : `const ${name} = '';`));
    // what the reviewer sees around the slides: their instructions, a comment box that isn't "for Claude", no notes controls
    const brand = brandOf();
    html = html.replace(/(<div class="howto">)[\s\S]*?(<\/div>)/, (m, a, b) => a + HOWTO + b)
      .replace(/<div class="brand">[\s\S]*?<\/div>/, () => brand)
      .replace('<button class="btn btn-outline" id="save-copy">', '<button class="btn btn-primary" id="save-copy">')
      .replace('<button class="btn btn-primary" id="export-btn">Export PDF</button>', '<button class="btn btn-outline" id="export-btn" title="Prints the slides only; your comments stay in the file">Print slides as PDF (without comments)</button>')
      .replace("'Feedback for Claude on this slide…'", "'Your comment on this slide…'").split('with feedback for Claude').join('with your comments')
      .replace(/<\/head>/i, (m) => REVIEW_CSS + m)
      .replace(SAVED, (m) => '<script id="review-copy" type="application/json">' + JSON.stringify({ version: v, slides: marks }).replace(/<\//g, '<\\/') + '</script>\n' + m);

    // 1. run it as it stands, to learn the text fingerprints it gives its own slides. The deck's data
    //    scripts (pictures of master-deck slides, say) are left out when the copy runs without them.
    const toggles = { __order: kept, __defOrder: kept, __removed: [], __added: (live.__added || []).filter((x) => K.has(x)), __orig: (live.__orig || []).filter((x) => K.has(x)) };
    const local = /<script\b[^>]*\bsrc="(?!https?:|\/\/)[^"]+"[^>]*>\s*<\/script>\s*/g, hasLocal = /<script\b[^>]*\bsrc="(?!https?:|\/\/)/.test(html);
    const good = (p) => p && !p.err.length && p.ids.join('\n') === kept.join('\n');
    let p1 = null;
    for (const body of hasLocal ? [html.replace(local, ''), html] : [html]) {
      p1 = await run(setSaved(body, JSON.stringify({ [v]: toggles })));
      if (good(p1)) { html = body; break; }
    }
    if (!good(p1)) throw new Stop(!p1 ? 'The review copy didn’t finish loading in the test run.' : p1.err.length ? `The review copy stopped with an error in the test run: ${esc(p1.err[0])}.` : 'The review copy showed different slides in the test run.');

    // 2. your text as it is now, in the copy's own terms: the note swapped for the copy's blank one,
    //    fingerprints from the copy. No comments.
    const data = Object.assign({ __def: {} }, JSON.parse(JSON.stringify(toggles)));
    kept.forEach((id) => {
      const bits = live[id].slice(), i = noteAt(fields(wrapOf(id))), blank = p1.notes[id];
      if (i >= 0 && i < bits.length) bits[i] = blank && blank[1] != null ? blank[1] : '';
      data[id] = bits; data.__def[id] = p1.defs[id];
    });
    html = setSaved(html, JSON.stringify({ [v]: data }));

    // 3. the server puts the pictures in and adds the edits as sent (saved-edits-base)
    let file, pics = 0;
    try {
      const r = await fetch(api('bundle'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ html, review: true }) });
      if (!r.ok) throw new Error(r.status);
      file = await r.text(); pics = +r.headers.get('X-SB-Pictures') || 0;
    } catch (e) { throw new Stop('The Decks server didn’t answer, so the copy couldn’t get its pictures. Try again in a moment.'); }
    if (!/<script id="saved-edits-base" type="application\/json">/.test(file)) throw new Stop('The server is running an older version without review copies. Restart it and try again.');

    // 4. the finished file: these slides, this text, and none of what was left out
    const p2 = await run(file);
    if (!good(p2)) throw new Stop(!p2 ? 'The finished copy didn’t finish loading in the test run.' : p2.err.length ? `The finished copy stopped with an error: ${esc(p2.err[0])}.` : 'The finished copy showed different slides.');
    const differ = kept.filter((id) => (p2.text[id] || []).join('\u0001') !== liveText[id].join('\u0001'));
    const items = [];
    Object.keys(L).forEach((id) => {
      if (typeof L[id].notes === 'string') items.push(['notes', id, L[id].notes]);
      if (!K.has(id)) strings(Object.assign({}, L[id], { notes: null })).forEach((s) => items.push([L[id].fac ? 'fac' : 'other', id, s, true]));
    });
    Object.keys(P).filter((k) => k !== v).forEach((k) => items.push(['versions', k, String(P[k].name || ''), true]));
    const prefix = String(get(() => KEY()) || '').slice(0, -String(v).length);   // eslint-disable-line no-undef
    for (let i = 0; prefix && i < localStorage.length; i++) {
      const k = localStorage.key(i); if (!k || !k.startsWith(prefix)) continue;
      const d = get(() => JSON.parse(localStorage.getItem(k)));
      if (d && d.__fb && typeof d.__fb === 'object') Object.keys(d.__fb).forEach((id) => items.push(['comments', id, String(d.__fb[id])]));
    }
    deck.querySelectorAll('textarea.fb').forEach((t) => { const w = t.closest('[data-id]'); if (t.value.trim()) items.push(['comments', w ? w.dataset.id : '', t.value]); });   // typed, not saved yet
    (get(() => DONE_FB) || []).forEach((t) => items.push(['comments', '', String(t).replace(/^[\w-]+::/, '')]));   // eslint-disable-line no-undef
    // what the copy writes out fresh for the slides kept is meant to be there, their parts' names included
    // (a left-out divider's title is often its part's name)
    const shown = [...Object.values(swaps).filter(Boolean), ...kept.map((id) => liveText[id].join('\n'))].join('\n');
    const found = leaks(file, items, shown, engine);
    if (Object.keys(found).length) {
      const what = Object.keys(found).map((k) => KINDS[k] + ([...found[k]].filter(Boolean).length ? ` (${[...found[k]].filter(Boolean).slice(0, 4).map(esc).join(', ')}${found[k].size > 4 ? '…' : ''})` : ''));
      throw new Stop(`Not saved: the review copy would still carry ${what.join('; ')}. This deck keeps them somewhere the copy doesn’t rewrite. Ask Claude to look at static/reviewcopy.js.`);
    }
    return { file, pics, n: kept.length, fac: order.length - kept.length, differ };
  }

  let busy = false;
  async function save() {
    if (busy) return;
    busy = true;
    say('Making a review copy…');
    try {
      const r = await make();
      const u = URL.createObjectURL(new Blob([r.file], { type: 'text/html' })), a = document.createElement('a'); a.href = u; a.download = fileName();
      document.body.appendChild(a); HTMLAnchorElement.prototype.click.call(a); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 4000);
      say(`<b>Saved ${esc(fileName())}.</b> ${r.n} slides${r.fac ? ` (${r.fac} facilitator slide${r.fac === 1 ? '' : 's'} left out)` : ''}, editable, with a comment box under each`
        + `${r.pics ? ', pictures inside' : ''}. No notes, comments, or other versions. When it comes back, Claude brings it in with <code>sb import</code>.`
        + (r.differ.length ? ` <b>Check slide${r.differ.length === 1 ? '' : 's'} ${r.differ.slice(0, 5).map(esc).join(', ')} in the file:</b> the text there isn’t quite what this page shows.` : ''));
    } catch (e) {
      say(e instanceof Stop ? e.message : `The review copy failed: ${esc(e && e.message)}`);
      if (!(e instanceof Stop)) console.error(e);
    } finally { busy = false; }
  }

  API.shareItem({ t: 'Review copy', sub: 'For someone to comment and edit, then send back', id: 'sb-review-copy',
    title: 'The file to send someone who should comment and edit, then send it back (sb import). This version only, editable, a comment box under each slide. No notes, comments, facilitator slides, or other versions.', act: () => save() });
})();
