/* Decks shell.
   Wraps a deck page served by the Decks server with:
   - a top bar (logo, version, filters, Claude's live status, view switch, present),
   - focus view: filmstrip | one slide | comment thread, both side bars collapsible,
   - scroll view: the deck as before, with Claude's replies under each slide,
   - live updates: replies appear as Claude posts them, and the page reloads itself
     when Claude finishes a round (or shows a banner if you are typing).
   It only talks to the deck through its existing DOM: comments still live in each
   slide's .fb box and are saved by the deck itself. */
(function () {
  const SB = window.__SB;
  const MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const SEND = MAC ? '⌘⇧↵' : 'Ctrl+Shift+↵', PKEY = MAC ? '⌘↵' : 'Ctrl+↵';   // Ask Claude's key, and the deck's own Present
  // Ask Claude (Process now while Claude watches), even mid-comment. Caught before the deck's own keys see it,
  // because the deck presents on ⌘↵ and would take ⌘⇧↵ for the same.
  window.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.key !== 'Enter') return;
    let showing = false; try { showing = presenting(); } catch (x) {}
    e.preventDefault(); e.stopImmediatePropagation(); const b = document.getElementById('sb-ask'); if (b && !showing) b.click();
  }, true);
  const deck = document.getElementById('deck');
  if (!SB || !deck) return;

  // ---------- small helpers ----------
  const $ = (s, r = document) => r.querySelector(s);
  const h = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const api = (p) => '/api/decks/' + SB.slug + (p ? '/' + p : '');
  const post = (op) => fetch(api('review'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(op) }).then((r) => r.json());
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const UIKEY = '__sb_ui';
  const ui = (() => { try { return Object.assign({ view: 'focus', noleft: false, noright: false }, JSON.parse(localStorage.getItem(UIKEY) || '{}')); } catch (e) { return { view: 'focus', noleft: false, noright: false }; } })();
  const saveUi = () => { try { localStorage.setItem(UIKEY, JSON.stringify(ui)); } catch (e) {} };

  // ---------- the deck, as the builders expose it ----------
  const wraps = () => [...deck.children].filter((n) => n.dataset && n.dataset.id);
  let wmap = null;   // id -> slide wrapper, rebuilt when the deck re-renders
  const wrapOf = (id) => { if (!id) return null; const w = wmap && wmap.get(id); if (w && w.parentNode === deck) return w; wmap = new Map(wraps().map((x) => [x.dataset.id, x])); return wmap.get(id) || null; };
  const lib = () => { try { return LIBRARY; } catch (e) { return {}; } };            // eslint-disable-line no-undef
  const title = (id) => { let t = ''; try { if (typeof titleOf === 'function') t = titleOf(id); } catch (e) {} if (!t) { const b = lib()[id] || {}; t = String(b.title || b.q || id); } return t.replace(/<[^>]+>/g, '').replace(/\*\*/g, ''); }; // eslint-disable-line no-undef
  const notesOf = (id) => String((lib()[id] || {}).notes || '').replace(/<[^>]+>/g, '');
  const fbOf = (id) => { const w = wrapOf(id); return w && w.querySelector('textarea.fb'); };
  const commentOf = (id) => { const f = fbOf(id); return f ? f.value.trim() : ''; };
  const setComment = (id, v) => { const f = fbOf(id); if (!f) return; f.value = v; f.dispatchEvent(new Event('input', { bubbles: true })); };
  // the box a slide is scaled into: .slide-frame in the workshop engine, .slide-box in the pitch builder
  const frameOf = (w) => { const sl = w.querySelector('.slide'); return (sl && sl.parentElement !== w && sl.parentElement) || w; };
  // scale slides to their frames: every width first, then every transform, so the browser lays out once
  // (the deck's own fitSlides alternates the two, one layout per slide). One slide in focus and checks.
  const fitIn = (list) => { const fs = list.map((w) => w.querySelector('.slide') && frameOf(w)).filter((f) => f && f.matches('.slide-frame, .slide-box')), k = fs.map((f) => f.clientWidth / 1000);
    fs.forEach((f, i) => { const s = f.querySelector('.slide'); if (s) s.style.transform = k[i] && isFinite(k[i]) ? `scale(${k[i]})` : 'none'; }); return fs.length; };
  const refit = () => {
    const one = (ui.view === 'focus' || ui.view === 'checks') && cur && wrapOf(cur);
    try { if (fitIn(one ? [one] : wraps())) return; } catch (e) {}
    try { if (typeof fitSlides === 'function') fitSlides(); else window.dispatchEvent(new Event('resize')); } catch (e) { window.dispatchEvent(new Event('resize')); } }; // eslint-disable-line no-undef
  const presenting = () => { try { return !!showing; } catch (e) { return false; } };   // eslint-disable-line no-undef
  const sideSelect = $('.sidebar select');
  // with Client work hidden: the slides only hidden (client) versions use, so no list, shelf, or picker shows them
  const clientOnly = (() => { try { const hv = new Set(SB.hideVersions || []); if (!hv.size || typeof PITCHES === 'undefined') return new Set();   // eslint-disable-line no-undef
    const vis = new Set(), hid = new Set(); Object.entries(PITCHES).forEach(([k, pv]) => (pv.blocks || []).forEach((x) => (hv.has(k) ? hid : vis).add(x)));   // eslint-disable-line no-undef
    return new Set([...hid].filter((x) => !vis.has(x))); } catch (e) { return new Set(); } })();

  // ---------- review state from the server ----------
  let review = { comments: {}, replies: {}, changed: {}, rounds: [], claude: null };
  let filter = 'all', cur = null;
  const info = (id) => {
    const text = commentOf(id), rep = review.replies[id], ch = review.changed[id];
    const fresh = !!rep && (text ? rep.forText === text : !rep.forText);   // same rule as the server: a reply belongs to the exact comment it answered
    const st = fresh ? rep.status : null, meta = review.comments[id] || {};
    const hold = !!text && meta.state === 'draft' && (meta.text === text || !!meta.follow);   // a held comment stays held while you keep typing
    return { text, rep, fresh, st, ch, hold,
      open: !!text && !hold && st !== 'done' && st !== 'skipped', question: st === 'question', replied: fresh && st !== 'working', changed: !!ch };
  };
  const FILTERS = [['all', 'All'], ['proposed', 'Proposed'], ['open', 'Open'], ['replied', 'Replied'], ['questions', 'Questions'], ['changed', 'Changed']];
  const pass = (id, f = filter) => {
    if (f === 'all') return true; if (f === 'proposed') return propLead(id);
    const i = info(id); return (f === 'open' && i.open) || (f === 'replied' && i.replied) || (f === 'questions' && i.question) || (f === 'changed' && i.changed); };
  const visible = () => wraps().map((w) => w.dataset.id).filter((id) => pass(id));

  // ---------- proposed slides: Claude's alternatives to one of yours (prop:true, replaces:'id') ----------
  // A slide can have one proposal or several (its options). Accept puts the option on screen in the original's
  // place in this version and takes the original and the other options out; Keep original takes them all out.
  // Both save at once (the version's order, and the decisions in review.json), and both undo. Claude writes
  // them into the deck file next round (sb proposals --bake).
  const origOf = (id) => { const b = lib()[id]; return b && b.prop && b.replaces && lib()[b.replaces] ? b.replaces : null; };
  const optionsOf = (o) => Object.keys(lib()).filter((x) => origOf(x) === o);   // in deck-file order: option 1, 2, 3
  const inVersion = () => new Set(wraps().map((w) => w.dataset.id));
  const defaults = () => { try { return new Set(PITCHES[sideSelect ? sideSelect.value : current].blocks); } catch (e) { return null; } };   // eslint-disable-line no-undef
  // a slide's proposals as one decision: the clicks saved in review.json, or else what the version shows
  // (the original or some options taken out by hand). out: this version doesn't carry them.
  function groupOf(o, on = inVersion(), def = defaults()) {
    const ps = optionsOf(o), rec = (x) => { const r = (review.proposals || {})[x]; return r && !r.baked ? r : null; };
    const acc = ps.filter((x) => (rec(x) || {}).decision === 'accept');
    if (acc.length) return { o, ps, d: 'accept', pick: acc[0], said: true, version: rec(acc[0]).version };
    if (ps.every((x) => (rec(x) || {}).decision === 'keep')) return { o, ps, d: 'keep', said: true, version: rec(ps[0]).version };
    const carried = (x) => !def || def.has(x) || on.has(x), opts = ps.filter(carried);
    if (!opts.length || !carried(o)) return { o, ps, d: null, out: true };
    const shown = opts.filter((x) => on.has(x) && (rec(x) || {}).decision !== 'keep');
    if (on.has(o)) return shown.length ? { o, ps, d: null, shown } : { o, ps, d: 'keep' };
    if (shown.length === 1) return { o, ps, d: 'accept', pick: shown[0] };
    return shown.length ? { o, ps, d: null, shown } : { o, ps, d: null, out: true };
  }
  // one option's part in its group's decision
  const decisionOf = (id, on, def) => {
    const o = origOf(id); if (!o) return null; const g = groupOf(o, on, def);
    return { g, d: g.d === 'accept' ? (g.pick === id ? 'accept' : 'keep') : g.d, said: g.said, version: g.version, out: g.out };
  };
  const pendingProp = (id) => { const x = decisionOf(id); return !!x && !x.d && !x.out; };
  const propLead = (id, on = inVersion(), def = defaults()) => { const x = decisionOf(id, on, def); return !!x && !x.d && !x.out && x.g.shown[0] === id; };   // the Proposed filter steps through slides, not options
  const propList = () => { const on = inVersion(), def = defaults(); return [...on].filter((id) => propLead(id, on, def)); };
  const propDecided = () => { const on = inVersion(), def = defaults(); return [...new Set(Object.keys(lib()).map(origOf).filter(Boolean))].map((o) => groupOf(o, on, def)).filter((g) => g.d); };
  const propUndo = [];   // originals whose proposals were decided in this tab, newest last: U reopens them one by one
  function setInVersion(id, on) {
    const w = wrapOf(id);
    if (!on && w) { const rm = w.querySelector('.ctrls [data-a="rm"]'); if (rm) rm.click(); return; }
    if (on && !w) { const inp = document.querySelector(`#block-list input[data-id="${CSS.escape(id)}"]`); if (inp && !inp.checked) inp.click(); }
  }
  // d: 'accept' (pick is the option to keep), 'keep' (the original), or null (undo: the original and every option back)
  function decide(p, d, pick) {
    const o = origOf(p); if (!o) return;
    if (SB.readonly) { say('This is a read-only view of the deck.'); return; }
    const ps = optionsOf(o), def = defaults(), had = inVersion(), applied = had.has(o) || ps.some((x) => had.has(x));
    if (d === 'accept') pick = pick || p;
    const before = visible(), lead = before.find((x) => origOf(x) === o), k = before.indexOf(lead);
    if (applied) {   // the version on screen changes now; another version follows when Claude bakes it in
      // one this version doesn't carry by default (filed apart, shown by placeProps) stays in it once saved, as a slide you added
      if (d === 'accept' && def && !def.has(pick)) { try { if (typeof ADDED !== 'undefined' && ADDED instanceof Set) ADDED.add(pick); } catch (e) {} }   // eslint-disable-line no-undef
      if (d === 'accept') { setInVersion(pick, true); setInVersion(o, false); ps.forEach((x) => { if (x !== pick) setInVersion(x, false); }); }
      else if (d === 'keep') { setInVersion(o, true); ps.forEach((x) => setInVersion(x, false)); }
      else { setInVersion(o, true); ps.forEach((x) => { if (!def || def.has(x) || had.has(x)) setInVersion(x, true); }); }
    }
    const ver = sideSelect ? sideSelect.value : '', said = {};
    ps.forEach((x) => { said[x] = d === 'accept' ? (x === pick ? 'accept' : 'keep') : d; });
    review.proposals = Object.assign({}, review.proposals);
    Object.entries(said).forEach(([x, dx]) => { if (dx) review.proposals[x] = { decision: dx, replaces: o, version: ver, title: title(x) }; else delete review.proposals[x]; });
    Object.entries(said).reduce((pr, [x, dx]) => pr.then(() => post({ op: 'decide', slide: x, replaces: o, decision: dx, version: ver, title: title(x), applied })), Promise.resolve()).then(setReview);
    if (d) propUndo.push(o);
    flip(null);
    // where to go: on through the proposals while the filter is on; otherwise stay with the slide that's left
    let next = d === 'accept' ? pick : d === 'keep' ? o : (ps.find((x) => wrapOf(x)) || p);
    if (filter === 'proposed' && d) { const rest = before.filter((x) => origOf(x) !== o); next = rest[k] || rest[k - 1] || next; if (!rest.length) { filter = 'all'; next = d === 'accept' ? pick : o; } }
    const left = propList().filter((x) => origOf(x) !== o).length, many = ps.length > 1;
    const t = (x) => esc(title(x).slice(0, 70)), more = left ? `${left} left to decide.` : 'That was the last one.';
    say(d === 'accept' ? `<b>Accepted${many ? ` option ${ps.indexOf(pick) + 1}` : ''}:</b> ${t(pick)}. ${more} <b>U</b> undoes.`
      : d === 'keep' ? `<b>Kept the original:</b> ${t(o)}. ${more} <b>U</b> undoes.`
      : `<b>Undone.</b> The original and its ${many ? 'options are' : 'proposal is'} back in this version, waiting for your call.`);
    if (d && !left) setTimeout(() => say('<b>Every proposal is decided.</b> Claude writes your decisions into the deck at the next round: click Ask Claude.'), 2600);
    setTimeout(() => { refresh(); go(wrapOf(next) ? next : (visible()[0] || cur), true); }, 60);
  }
  function undoDecision() {
    while (propUndo.length) { const o = propUndo.pop(), ps = optionsOf(o); if (ps.length && groupOf(o).d) { decide(ps[0], null); return true; } }
    const x = cur && decisionOf(cur); if (x && x.d) { decide(cur, null); return true; }
    say('Nothing to undo.'); return false;
  }
  // Original | Proposed (or Original | Option 1 | 2 | 3): another member of the group drawn over the slide on
  // screen, in the same frame, so they can be flipped through. flipped: { at: the slide on screen, show: the one drawn }
  let flipped = null;
  const flipList = (id) => { const o = origOf(id); return o ? [o, ...optionsOf(o)] : []; };
  const flipShows = (id) => (flipped && flipped.at === id ? flipped.show : id);   // what the slide on screen shows now (not the deck's own showing, which is presenting)
  function flip(show) {
    const id = cur, w = id && wrapOf(id), L = flipList(id);
    if (show === 'next' || show === 'prev') { const i = L.indexOf(flipShows(id)); show = L[(i + (show === 'next' ? 1 : L.length - 1)) % L.length]; }
    document.querySelectorAll('.sb-flipov').forEach((x) => x.remove());
    flipped = null;
    if (show && show !== id && L.includes(show) && w) {
      const sl = w.querySelector('.slide'), fr = sl && sl.parentElement, live = wrapOf(show) && wrapOf(show).querySelector('.slide'); let b0 = null;
      if (!live) { try { b0 = build(show); } catch (e) {} }   // eslint-disable-line no-undef
      const s0 = live ? live.cloneNode(true) : b0 && (b0.classList.contains('slide') ? b0 : b0.querySelector('.slide'));   // as you last edited it, when it's in this version
      if (s0 && fr) {
        s0.querySelectorAll('.ctrls, .slide-tag, .sb-badge').forEach((x) => x.remove());
        s0.querySelectorAll('[contenteditable]').forEach((x) => x.removeAttribute('contenteditable'));
        s0.querySelectorAll('[id]').forEach((x) => x.removeAttribute('id'));
        s0.classList.add('sb-flipov'); s0.style.transform = sl.style.transform;
        const n = [...inVersion()].indexOf(show) + 1, j = L.indexOf(show);
        s0.appendChild(h('span', 'sb-fliptag', j === 0 ? (n ? `Original · slide ${n}` : 'Original') : `Option ${j} of ${L.length - 1}`));
        if (getComputedStyle(fr).position === 'static') fr.style.position = 'relative';
        fr.appendChild(s0); flipped = { at: id, show };
        try { if (typeof autofitText === 'function') autofitText(s0); if (typeof drawTrees === 'function') drawTrees(s0); } catch (e) {}   // eslint-disable-line no-undef
      }
    }
    document.querySelectorAll('#deck > [data-id] .sb-flip [data-flip]').forEach((b) => b.classList.toggle('on', b.dataset.flip === flipShows(b.closest('#deck > [data-id]').dataset.id)));
    if (cur && wrapOf(cur)) { const w2 = wrapOf(cur); propBar(w2, cur, w2.querySelector(':scope > .slide-no')); }
  }
  // A proposal filed apart from its original (another cat, an extra, left out of a version listed by hand, far from it in
  // LIBRARY) still shows right after its original in the version on screen, so you can decide it; an accepted one shows
  // in the original's place. Display only: nothing is saved for it until you decide, and the deck file is fixed by
  // sb proposals --fix-placement (or --bake, which files an accepted one first). Not in read-only views, which report
  // the deck as saved.
  let reviewIn = false;
  const forgiven = new Set();   // proposals this tab put in the version on screen
  const defList = () => { try { return PITCHES[sideSelect ? sideSelect.value : current].blocks; } catch (e) { return null; } };   // eslint-disable-line no-undef
  function placeProps() {
    const blocks = defList();
    if (!reviewIn || SB.readonly || !blocks || presenting()) return;
    const def = new Set(blocks), rec = (x) => { const r = (review.proposals || {})[x]; return r && !r.baked ? r : null; };
    const filedRight = (o, x) => { const i = blocks.indexOf(o); if (i < 0 || !def.has(x)) return false;   // right after its original by default
      for (let j = i + 1; j < blocks.length; j++) { if (blocks[j] === x) return true; if (origOf(blocks[j]) !== o) return false; } return false; };
    const added = []; let moved = 0;
    const put = (x, after, before) => {   // the slide on screen, or a new one built for it; nothing is saved
      let w = wrapOf(x);
      if (w && (after ? after.nextElementSibling === w : before.previousElementSibling === w)) return;
      if (!w) { try { w = build(x); } catch (e) { w = null; } if (!w) return; added.push(w); const inp = document.querySelector(`#block-list input[data-id="${CSS.escape(x)}"]`); if (inp) inp.checked = true; }   // eslint-disable-line no-undef
      if (after) after.after(w); else before.before(w);
      forgiven.add(x); moved++;
    };
    [...new Set(Object.keys(lib()).map(origOf).filter(Boolean))].forEach((o) => {
      const ps = optionsOf(o).filter((x) => !filedRight(o, x)); if (!ps.length) return;
      const acc = optionsOf(o).find((x) => (rec(x) || {}).decision === 'accept');
      if (acc) {   // accepted, not baked yet: in the original's place, in the version it was accepted in
        const r = rec(acc);
        if (!ps.includes(acc) || wrapOf(acc) || wrapOf(o) || !def.has(o) || (r.version && sideSelect && r.version !== sideSelect.value)) return;
        const i = blocks.indexOf(o), next = blocks.slice(i + 1).map(wrapOf).find((w) => w && origOf(w.dataset.id) !== o);
        const prev = blocks.slice(0, i).reverse().map(wrapOf).find(Boolean);
        if (next || prev) put(acc, next ? null : prev, next);
        return;
      }
      if (!wrapOf(o)) return;   // the original isn't in this version (or you took it out): nothing to sit next to
      ps.forEach((x) => {
        if (rec(x) || (!wrapOf(x) && def.has(x))) return;   // decided, or taken out of this version by hand: a decision too
        let last = wrapOf(o);
        while (last.nextElementSibling && last.nextElementSibling.dataset && origOf(last.nextElementSibling.dataset.id) === o && last.nextElementSibling.dataset.id !== x) last = last.nextElementSibling;
        put(x, last);
      });
    });
    if (!moved) return;
    try { added.forEach((w) => { if (typeof autofitText === 'function') autofitText(w); if (typeof drawTrees === 'function') drawTrees(w); }); } catch (e) {}   // eslint-disable-line no-undef
    try { if (typeof numberSlides === 'function') numberSlides(); } catch (e) {}   // eslint-disable-line no-undef
    if (added.length) refit();
  }
  // × on a proposal this tab put in the version is Keep original: it was never saved in the version, so taking it out
  // by hand would leave no trace and it would come back on the next load
  deck.addEventListener('click', (e) => {
    const b = e.isTrusted && e.target.closest('.cbtn[data-a="rm"]'), w = b && b.closest('#deck > [data-id]'), id = w && w.dataset.id;
    if (!id || !forgiven.has(id) || !origOf(id) || (decisionOf(id) || {}).d) return;
    const blocks = defList(); if (blocks && blocks.includes(id)) return;
    e.stopPropagation(); e.preventDefault(); decide(id, 'keep');
  }, true);

  // ---------- top bar ----------
  // Left: the deck and its version, as one control, then the filters. Right: the views, New slide (addslide.js),
  // then View, Share, and Present, each a small menu; Ask Claude, the one red button; and ? for help.
  const hasPresent = !!$('#present-btn'), hasPresenter = !!$('#presenter-btn');
  const dd = (id, label, title, chev = true) => `<div class="sb-dd" id="${id}"><button class="sb-btn sb-ddb" aria-haspopup="menu" aria-expanded="false" title="${title}">${label}${chev ? '<span class="sb-chev" aria-hidden="true">▾</span>' : ''}</button><div class="sb-pop" role="menu" aria-label="${title}"></div></div>`;
  const presentLabel = '▶<span class="sb-long"> Present</span>';
  const top = h('div'); top.id = 'sb-top';
  top.innerHTML = `<a href="/" title="All decks"><img class="sb-logo" src="/_sb/logo-decks.svg" alt="StrategyU Decks"></a>
    <a href="/" class="sb-btn sb-back" title="Back to the dashboard of all decks">← <span class="sb-lbl">All decks</span></a><span class="sb-sep"></span>
    <label class="sb-deck" title="${esc(SB.name)}"><span class="sb-deck-t"><b>${esc(SB.name)}</b><span class="sb-vname"></span></span>${sideSelect ? '<span class="sb-chev" aria-hidden="true">▾</span><select id="sb-version" aria-label="Version"></select>' : ''}</label>
    <div class="sb-chips" id="sb-chips" role="group" aria-label="Filter slides"></div>
    <span class="sb-grow"></span>
    <span class="sb-claude" id="sb-claude" role="status"><i></i><span></span></span>
    <span class="sb-saved" id="sb-saved" title="Every edit and comment saves to disk, next to the deck">Saved</span>
    <button class="sb-btn" id="sb-resolve" hidden></button>
    <div class="sb-seg" role="group" aria-label="View"><button data-v="focus" title="Focus (F)">Focus</button><button data-v="scroll" title="Scroll (S)">Scroll</button><button data-v="sorter" title="Sorter (G)">Sorter</button><button data-v="checks" title="Checks (C)">Checks</button></div>
    ${dd('sb-view', 'View', 'Titles only, side bars, facilitator notes')}
    ${dd('sb-share', 'Share', 'A PDF, or a copy to send')}
    ${hasPresent && hasPresenter ? dd('sb-present', presentLabel, 'Present, or presenter view') : hasPresent ? `<button class="sb-btn" id="sb-present" title="Present from this slide (${PKEY})">${presentLabel}</button>` : ''}
    <button class="sb-btn red" id="sb-ask" title="Copy a prompt that asks Claude (or Codex) to work through your comments (${SEND})"><span class="sb-ask-l">Ask Claude</span><span class="sb-n" id="sb-ask-n"></span><kbd class="sb-key" aria-hidden="true">${SEND}</kbd></button>
    ${dd('sb-q', '?', 'Help', false)}`;
  document.body.prepend(top);
  document.body.classList.add('sb-on');

  // the deck's name, with the version on screen after it; a click on either picks another version
  const deckCtl = $('.sb-deck', top), vname = $('.sb-vname', top);
  const verName = (t) => String(t || '').replace(/\s*\(.*$/, '').replace(/\s+—.*$/, '').trim();
  if (sideSelect) {
    const vs = $('#sb-version');
    const hidden = new Set(SB.hideVersions || []);
    const label = () => { const o = vs.options[vs.selectedIndex], many = vs.options.length > 1;
      vname.textContent = many && o ? ' · ' + verName(o.textContent) : ''; deckCtl.classList.toggle('sb-hasv', many);
      deckCtl.title = many && o ? `${SB.name} · ${o.textContent.trim()}. Click to pick another version.` : SB.name; };
    const syncVersions = () => { vs.innerHTML = [...sideSelect.options].filter((o) => !hidden.has(o.value)).map((o) => `<option value="${esc(o.value)}">${esc(o.textContent)}</option>`).join(''); vs.value = sideSelect.value; label(); };
    syncVersions();
    if (hidden.has(sideSelect.value)) { const first = [...sideSelect.options].find((o) => !hidden.has(o.value)); if (first) { sideSelect.value = first.value; sideSelect.dispatchEvent(new Event('change', { bubbles: true })); vs.value = first.value; label(); } }
    vs.addEventListener('change', () => { sideSelect.value = vs.value; sideSelect.dispatchEvent(new Event('change', { bubbles: true })); label(); });
    sideSelect.addEventListener('change', () => { vs.value = sideSelect.value; label(); });
  }

  // ---------- the menus: View, Share, Present, ? ----------
  const menus = [...top.querySelectorAll('.sb-dd')];
  const closeMenus = () => menus.forEach((m) => { m.classList.remove('open'); m.firstElementChild.setAttribute('aria-expanded', 'false'); });
  const rows = (m) => [...m.querySelectorAll('.sb-it')].filter((b) => !b.disabled && b.offsetParent);
  menus.forEach((m) => {
    const b = m.firstElementChild, pop = m.lastElementChild;
    b.addEventListener('click', (e) => {
      e.stopPropagation(); const on = !m.classList.contains('open'); closeMenus(); if (!on) return;
      m.dispatchEvent(new Event('sb:open')); m.classList.add('open'); b.setAttribute('aria-expanded', 'true');
      if (!e.detail) { const r = rows(m)[0]; if (r) r.focus(); }   // opened from the keyboard: start on the first row
    });
    pop.addEventListener('click', (e) => e.stopPropagation());
    pop.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); closeMenus(); b.focus(); return; }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault(); e.stopPropagation(); const r = rows(m), i = r.indexOf(document.activeElement);
      const n = r[(i + (e.key === 'ArrowDown' ? 1 : -1) + r.length) % r.length]; if (n) n.focus();
    });
  });
  // a click anywhere else closes them (caught early, because the page's own handlers stop some clicks)
  document.addEventListener('pointerdown', (e) => { if (!e.target.closest('.sb-dd')) closeMenus(); }, true);
  // one row: what it is, a line on what it does, and its key or an on/off switch on the right
  function item(menu, o) {
    const b = h('button', 'sb-it', `<span class="sb-it-t"><b>${esc(o.t)}</b>${o.sub ? `<span>${esc(o.sub)}</span>` : ''}</span>${o.key ? `<kbd>${esc(o.key)}</kbd>` : ''}${o.tog ? '<i class="sb-tog" aria-hidden="true"></i>' : ''}`);
    b.setAttribute('role', o.tog ? 'menuitemcheckbox' : 'menuitem'); if (o.id) b.id = o.id; if (o.title) b.title = o.title;
    b.addEventListener('click', (e) => { if (!o.tog) closeMenus(); o.act(e); });
    const pop = $('#' + menu + ' .sb-pop'); if (o.before && o.before.parentNode === pop) pop.insertBefore(b, o.before); else pop.appendChild(b);
    return b;
  }
  const sep = (menu) => $('#' + menu + ' .sb-pop').appendChild(h('div', 'sb-msep'));
  const setTog = (b, on) => { if (!b) return; b.classList.toggle('on', !!on); b.setAttribute('aria-checked', String(!!on)); };

  // View: Titles only, the two side bars, facilitator notes
  const vTitles = item('sb-view', { t: 'Titles only', sub: 'Hide everything but the titles', key: 'H', tog: true, act: () => setHide(!ui.hide) });
  sep('sb-view');
  const vLeft = item('sb-view', { t: 'Slide list', sub: 'The filmstrip on the left', key: '[', tog: true, act: () => toggleSide('left') });
  const vRight = item('sb-view', { t: 'Notes panel', sub: 'Notes and changes on the right', key: ']', tog: true, act: () => toggleSide('right') });
  const notesBox = $('#notes-toggle');
  const vFac = notesBox ? item('sb-view', { t: 'Facilitator notes', sub: 'Under each slide in Scroll', tog: true, act: () => { notesBox.click(); setTog(vFac, notesBox.checked); } }) : null;
  sep('sb-view');
  item('sb-view', { t: 'What changed, round by round', sub: 'Each round’s changes, and the proposed slides you accepted or kept', act: () => openRounds() });
  $('#sb-view').addEventListener('sb:open', () => { setTog(vTitles, ui.hide); if (vFac) setTog(vFac, notesBox.checked); });

  // Share: the PDF, then the three copies (Client and Review copy add themselves, before Editable copy)
  if ($('#export-btn')) {
    item('sb-share', { t: 'Download PDF', sub: 'The slides as they look now, one per page, landscape', id: 'sb-pdf', act: () => downloadPdf() });
    item('sb-share', { t: 'Print', sub: 'Opens the print window, for paper', act: () => $('#export-btn').click() });
    sep('sb-share');
  }
  // the server makes the PDF in headless Chrome (as sb export does), so it comes out 16:9 whatever the
  // print window's paper and orientation are set to; if it can't, the print window is the fallback
  async function downloadPdf() {
    const vs = $('#sb-version'), vlabel = vs && vs.options.length > 1 && vs.selectedIndex >= 0 ? vs.options[vs.selectedIndex].text.trim() : '';
    const name = [SB.name, vlabel].filter(Boolean).join(' · ').replace(/[\\/:*?"<>|]+/g, '-').trim() + '.pdf';
    say('<b>Making the PDF…</b> It takes a few seconds.');
    try { if (typeof snapshot === 'function') snapshot(); } catch (e) {}   // eslint-disable-line no-undef
    try { await SB.flush(); } catch (e) {}   // your latest edits reach the server first
    let r = null; try { r = await fetch(api('pdf'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: sideSelect ? sideSelect.value : '' }) }); } catch (e) {}
    if (r && r.ok) {
      const u = URL.createObjectURL(await r.blob()), a = h('a'); a.href = u; a.download = name;
      document.body.appendChild(a); HTMLAnchorElement.prototype.click.call(a); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 4000);
      say(`<b>Saved ${esc(name)}.</b> One slide per page, landscape, as the deck looks now.`); return;
    }
    let why = ''; try { why = (await r.json()).error || ''; } catch (e) {}
    say(`Couldn’t make the PDF here${why ? ` (${esc(why)})` : ''}. Opening the print window instead: choose Landscape there.`);
    setTimeout(() => $('#export-btn').click(), 1500);
  }
  const editableCopy = $('#save-copy') ? item('sb-share', { t: 'Editable copy', sub: 'The whole deck with notes and comments, for you', id: 'sb-editable-copy',
    title: 'Every version, your notes and comments, and editing: keep it for yourself', act: () => $('#save-copy').click() }) : null;
  const shareItem = (o) => item('sb-share', Object.assign({ before: editableCopy }, o));

  // Present: from this slide (in Focus the slide on screen is the one to start from)
  const fromHere = () => { if (cur && ui.view === 'focus') { const w = wrapOf(cur); if (w) w.scrollIntoView({ block: 'center' }); } };
  const presentNow = (e) => { fromHere(); $('#present-btn').dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: !!(e && e.shiftKey) })); };
  if (hasPresent && hasPresenter) {
    item('sb-present', { t: 'Present', sub: 'Full screen from this slide', key: PKEY, act: presentNow });
    item('sb-present', { t: 'Presenter view', sub: 'Your notes, the next slide, and a clock', act: (e) => { fromHere(); $('#presenter-btn').dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: !!(e && e.shiftKey) })); } });
  } else if (hasPresent) $('#sb-present').addEventListener('click', presentNow);

  const help = h('div'); help.id = 'sb-help';
  help.innerHTML = `<button class="sb-help-x" data-helpx aria-label="Close" title="Close (Esc)">×</button><h4>How this works</h4><ul>
    <li>Click any text on a slide to edit it. It saves to disk as you type.</li>
    <li>Write a comment for a slide, then click <b>Ask Claude</b> (or say <b>process changes</b> to Claude). Tick “Still drafting” to hold one back.</li>
    <li>Claude replies under your comment. <b>Looks good</b> clears it; <b>Reopen</b> sends it back.</li>
    <li>In the left bar, × leaves a slide out of this version; add slides back from “Not in this version”.</li>
    <li>A <b>proposed</b> slide is Claude’s alternative to one of yours. <b>Proposed</b> in the left bar goes through them one by one: <b>Accept</b> puts it in place of your original, <b>Keep original</b> takes it out, and Space flips between the two (or through each option, when Claude offers several). Claude writes your decisions into the deck at the next round.</li>
    <li><b>View</b> holds Titles only, the side bars, and facilitator notes. <b>Present</b> starts the show or presenter view, when the deck has them.</li>
    <li><b>Share</b> saves a PDF or a copy to send. <b>Client copy</b> is this version’s slides to read or present, and nothing else. <b>Review copy</b> is for someone who should comment and edit: this version only, no notes or comments of yours, and they send it back for Claude to bring in. <b>Editable copy</b> carries your notes, comments, and every version: keep it for yourself.</li></ul>
    <h4 style="margin-top:14px" id="sb-keys-h">Keyboard shortcuts</h4>
    <table class="sb-keys">
      <tr><td><kbd>F</kbd> <kbd>S</kbd> <kbd>G</kbd> <kbd>C</kbd></td><td>Focus, Scroll, Sorter, Checks</td></tr>
      <tr><td><kbd>←</kbd> <kbd>→</kbd></td><td>Previous and next slide (<kbd>Home</kbd> <kbd>End</kbd>: first and last)</td></tr>
      <tr><td><kbd>${SEND}</kbd></td><td>Ask Claude: copy the prompt, or start the round when Claude is watching. Works while you type a comment, too.</td></tr>
      ${hasPresent ? `<tr><td><kbd>${PKEY}</kbd></td><td>Present from this slide</td></tr>` : ''}
      <tr><td><kbd>N</kbd></td><td>New slide after this one</td></tr>
      <tr><td><kbd>A</kbd> <kbd>K</kbd> <kbd>U</kbd></td><td>On a proposed slide: accept it (or the option on screen), keep your original, undo</td></tr>
      <tr><td><kbd>Space</kbd></td><td>On a proposed slide: flip to the original and back; with several options, through each (<kbd>Shift</kbd> <kbd>Space</kbd> goes back)</td></tr>
      <tr><td><kbd>H</kbd></td><td>Titles only (hide the content)</td></tr>
      <tr><td><kbd>[</kbd> <kbd>]</kbd></td><td>Hide the slide list or the notes panel</td></tr>
      <tr><td><kbd>1</kbd>–<kbd>5</kbd></td><td>Checks: 5-second test, 10-second test, horizontal flow, vertical flow, guides. From Focus or Scroll they run that check on the slide you’re on</td></tr>
      <tr><td><kbd>Space</kbd></td><td>Start a timed test, or reveal the slide</td></tr>
      <tr><td><kbd>A</kbd> <kbd>M</kbd></td><td>After a timed test: show again, missed it</td></tr>
      <tr><td><kbd>P</kbd> <kbd>L</kbd></td><td>Horizontal flow: paragraphs, one per line</td></tr>
      <tr><td><kbd>?</kbd></td><td>Show this card</td></tr>
    </table>`;
  document.body.appendChild(help);
  const openHelp = (keys) => { help.classList.add('on'); help.scrollTop = keys ? $('#sb-keys-h', help).offsetTop - 12 : 0; };
  // close: the ×, Esc, or a click anywhere else (caught before the page's own handlers, which stop some clicks)
  help.addEventListener('click', (e) => { if (e.target.closest('[data-helpx]')) help.classList.remove('on'); });
  document.addEventListener('pointerdown', (e) => { if (help.classList.contains('on') && !help.contains(e.target) && !e.target.closest('#sb-q, [data-keys]')) help.classList.remove('on'); }, true);

  // the deck's record: each round Claude ran (review.json), newest first, with the proposals decided in it
  const roundsCard = h('div'); roundsCard.id = 'sb-rounds'; document.body.appendChild(roundsCard);
  const dayOf = (t) => { if (!t) return ''; const d = new Date(t * 1000), n = new Date(), y = new Date(n - 864e5);
    return d.toDateString() === n.toDateString() ? 'Today' : d.toDateString() === y.toDateString() ? 'Yesterday' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); };
  // what changed on each slide in a round: kept with the round, or still on a slide's Changed badge
  const notesOf2 = (r) => { const n = Object.assign({}, r.notes || {});
    Object.entries(review.changed || {}).forEach(([s, c]) => { if (c && c.round === r.number && c.note && !(s in n)) n[s] = c.note; });
    (r.changed || []).forEach((s) => { if (!(s in n)) n[s] = ''; }); return n; };
  const slideName = (id) => (lib()[id] ? title(id) : id);
  function openRounds() {
    const P = (d, t) => `<li><b class="${d === 'accept' ? 'a' : 'k'}">${d === 'accept' ? 'Accepted' : 'Kept'}</b>${esc(t)}</li>`;
    const wait = propDecided().map((g) => P(g.d, g.d === 'accept' ? title(g.pick) + (g.ps.length > 1 ? ` (option ${g.ps.indexOf(g.pick) + 1} of ${g.ps.length})` : '') : title(g.o)));
    const rs = (review.rounds || []).slice().reverse();
    roundsCard.innerHTML = `<button class="sb-help-x" data-roundx aria-label="Close" title="Close (Esc)">×</button><h4>What changed, round by round</h4>
      ${wait.length ? `<div class="sb-r sb-rwait"><div class="sb-rh">Next round <span>waiting for Claude</span></div><p>Your decisions on proposed slides. Claude writes them into the deck file at the next round.</p><ul>${wait.join('')}</ul></div>` : ''}
      ${rs.map((r, i) => { const nt = notesOf2(r), ids = Object.keys(nt);
        return `<div class="sb-r"><div class="sb-rh">Round ${esc(r.number)} <span>${[dayOf(r.at), r.export ? `${esc(r.export)} export` : ''].filter(Boolean).join(' · ')}</span></div>
        ${r.summary ? `<p>${esc(r.summary)}</p>` : ''}${(r.proposals || []).length ? `<ul>${r.proposals.map((x) => P(x.decision, x.title || x.slide)).join('')}</ul>` : ''}
        ${ids.length ? `<details class="sb-rnotes"${i === 0 ? ' open' : ''}><summary>${ids.length} slide${ids.length === 1 ? '' : 's'} changed</summary><ul>${ids.map((x) => `<li><button class="sb-rgo" data-rgo="${esc(x)}" title="Open this slide">${esc(slideName(x))}</button>${nt[x] ? `<span>${esc(nt[x])}</span>` : ''}</li>`).join('')}</ul></details>` : ''}
        <div class="sb-rmeta">${r.commit ? `commit ${esc(r.commit)}` : ''}</div></div>`; }).join('')
        || (wait.length ? '' : '<p class="sb-hint">No rounds yet. Each time Claude works through your comments, it shows up here.</p>')}`;
    closeMenus(); help.classList.remove('on'); roundsCard.classList.add('on'); roundsCard.scrollTop = 0;
  }
  roundsCard.addEventListener('click', (e) => {
    if (e.target.closest('[data-roundx]')) roundsCard.classList.remove('on');
    const g = e.target.closest('[data-rgo]'); if (!g) return;
    const id = g.dataset.rgo;
    if (!wrapOf(id)) { say('That slide isn’t in this version.'); return; }
    roundsCard.classList.remove('on'); if (ui.view !== 'focus' && ui.view !== 'scroll') setView('focus'); go(id);
  });
  document.addEventListener('pointerdown', (e) => { if (roundsCard.classList.contains('on') && !roundsCard.contains(e.target) && !e.target.closest('#sb-view')) roundsCard.classList.remove('on'); }, true);

  // ?: help, and the plain file
  item('sb-q', { t: 'How this works', sub: 'Comment, Ask Claude, read the replies', act: () => openHelp(false) });
  item('sb-q', { t: 'Keyboard shortcuts', sub: 'Every key in one list', key: '?', act: () => openHelp(true) });
  if (!(SB.hideVersions || []).length) { sep('sb-q'); item('sb-q', { t: 'Open the plain deck file', sub: 'The file itself, without Decks around it', act: () => window.open(location.pathname + '?raw=1', '_blank') }); }
  sep('sb-q');
  item('sb-q', { t: 'Send feedback', sub: 'Email Paul what works and what you’d want next', title: 'Email paul@strategyu.co', act: async () => {
    const ok = await copyText('paul@strategyu.co'); window.open('mailto:paul@strategyu.co?subject=' + encodeURIComponent('Decks feedback'), '_blank');
    say(ok ? '<b>Opening an email to paul@strategyu.co.</b> The address is copied too, in case your mail app doesn’t open.' : 'Email <b>paul@strategyu.co</b>.'); } });
  item('sb-q', { t: 'Check for updates', sub: 'Ask GitHub now whether a newer Decks is out', act: async () => {
    say('Checking for updates…'); let d = null;
    try { const r = await fetch('/api/check-updates', { method: 'POST' }); if (r.ok) d = await r.json(); } catch (e) {}
    if (d && d.ok) updateNote(d.update);
    say(!d || !d.ok ? 'Couldn’t reach GitHub. Check your connection, then try again.'
      : !d.update ? `<b>You’re up to date.</b> Decks ${esc(d.version)} is the newest.`
      : `<b>Decks ${esc(d.update.version)} is out.</b> Open this menu again and click its first row to copy a prompt that updates it.`); } });
  item('sb-q', { t: 'Made by StrategyU ↗', sub: 'Where Paul teaches the method behind Decks',
    act: () => window.open('https://strategyu.co/?utm_source=decks&utm_medium=app&utm_campaign=deck-menu', '_blank', 'noopener') });
  // a newer Decks (the server's check, in the pulse): a row at the top of ?, and a dot on ? until you open it
  let updBox = null, updSeen = ''; try { updSeen = localStorage.getItem('__decks_upd_seen') || ''; } catch (e) {}
  function updateNote(u) {
    const qb = $('#sb-q > .sb-ddb');
    // the pulse calls this every 2.5 s: touch the page only when something changed (even a same-value write
    // repaints, and screen recordings of the page then blink)
    if (!u) { if (updBox) { updBox.remove(); updBox = null; } if (qb.classList.contains('sb-newdot')) qb.classList.remove('sb-newdot'); return; }
    if (updBox && updBox.dataset.v === u.version) return;
    if (updBox) updBox.remove();
    const row = item('sb-q', { t: `Decks ${u.version} is out`, sub: 'Click to copy a prompt that updates it, for Claude Code or Codex', act: async () => {
      const ok = u.prompt && await copyText(u.prompt);
      say(ok ? `<b>Update prompt copied.</b> Paste it into Claude Code or Codex, and it updates Decks to ${esc(u.version)} and restarts it. What’s new is linked on the dashboard.`
        : 'Couldn’t copy. To update, run <code>git pull</code> in your Decks folder, then restart the server.'); } });
    updBox = h('div', 'sb-updbox'); updBox.dataset.v = u.version; updBox.append(row, h('div', 'sb-msep'));
    $('#sb-q .sb-pop').prepend(updBox);
    qb.classList.toggle('sb-newdot', updSeen !== u.version);
  }
  $('#sb-q').addEventListener('sb:open', () => { if (!updBox) return; updSeen = updBox.dataset.v; try { localStorage.setItem('__decks_upd_seen', updSeen); } catch (e) {} $('#sb-q > .sb-ddb').classList.remove('sb-newdot'); });
  updateNote(SB.pulse && SB.pulse.update);

  // ---------- getting help from the agent ----------
  const toast = h('div'); toast.id = 'sb-toast'; document.body.appendChild(toast);
  let toastT = null; const say = (msg) => { toast.innerHTML = msg; toast.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => toast.classList.remove('on'), 5200); };
  const copyText = async (t) => { try { await navigator.clipboard.writeText(t); return true; } catch (e) { return false; } };
  const deckFile = () => `${SB.folder}/${SB.entry}`;
  const askPrompt = () => [
    `Work through the comments on my slide deck “${SB.name}” in Decks.`,
    `Deck file: ${deckFile()} (open at ${location.origin}${location.pathname}).`,
    `If you have the decks skill, this is “process changes”. Otherwise, from ${SB.app || 'the Decks folder'}:`,
    `1. ./sb comments ${SB.slug} lists my comments; ./sb edits ${SB.slug} shows text I edited on the slides.`,
    `2. For each comment, change the deck file, then reply on that slide: ./sb reply ${SB.slug} <slide-id> done "what changed" (question to ask me something, skipped to say why not).`,
    `   If I accepted proposed slides or kept the originals, ./sb proposals ${SB.slug} --bake writes those decisions into the deck file.`,
    `3. Check your work: ./sb shot ${SB.slug} <slide-ids> and ./sb audit ${SB.slug}.`,
    `4. Finish: ./sb export ${SB.slug}, then ./sb round ${SB.slug} --summary "what changed", then ./sb commit ${SB.slug} "Round N".`,
    'Titles are plain sentences, two lines at most, and every slide passes Checks › Guides.'].join('\n');
  // watch mode: while Claude waits on this deck (sb watch), the button starts the round itself
  let watched = false;
  function askButton(p) {
    watched = !!(p && p.watching); const b = $('#sb-ask'); if (!b) return;
    const queued = watched && p.asked, l = b.querySelector('.sb-ask-l');
    const text = queued ? 'Queued…' : watched ? 'Process now' : 'Ask Claude';
    const title = queued ? 'Claude starts as soon as it finishes what it’s doing (' + SEND + ')' : watched ? 'Claude is watching this deck in Claude Code. Click to start a round (' + SEND + ').' : 'Copy a prompt that asks Claude (or Codex) to work through your comments (' + SEND + ')';
    if (l.textContent !== text) l.textContent = text;   // only when it changed: the pulse calls this every 2.5 s
    if (b.title !== title) b.title = title;
  }
  $('#sb-ask').addEventListener('click', async () => {
    if (watched) {
      // your latest typing reaches the server first: the deck saves 400 ms after a keystroke, so save it now
      try { if (typeof snapshot === 'function') snapshot(); else await new Promise((r) => setTimeout(r, 500)); } catch (e) {}   // eslint-disable-line no-undef
      try { await SB.flush(); } catch (e) {}
      const r = await fetch(api('process'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => null);
      say(r && r.ok ? '<b>Sent.</b> Claude is starting the round in Claude Code. Its progress shows up here.' : 'Couldn’t reach the server. Try again in a moment.');
      askButton({ watching: true, asked: true }); return;
    }
    const ok = await copyText(askPrompt());
    say(ok ? '<b>Prompt copied.</b> Paste it into Claude Code or Codex. Tip: say “watch this deck” in Claude Code, and this button starts each round for you.' : 'Couldn’t copy. In Claude Code, say “process changes”.');
  });
  fetch(api('')).then((r) => r.json()).then((d) => {   // a deck just made from the New deck form: say what's next
    const key = '__sb_next_' + SB.slug; let gone = false; try { gone = localStorage.getItem(key) === '1'; } catch (e) {}
    if (!d || !d.prompt || (d.rounds || []).length || gone) return;
    const nb = h('div'); nb.id = 'sb-nextstep';
    nb.innerHTML = '<span><b>Next:</b> paste your prompt into Claude Code or Codex, and it builds the first draft from your brief. You’ll see its progress up here.</span><span><button class="sb-btn" data-c>Copy prompt</button> <button class="sb-btn icon" data-x aria-label="Dismiss">×</button></span>';
    nb.querySelector('[data-c]').addEventListener('click', async () => { say((await copyText(d.prompt)) ? '<b>Prompt copied.</b> Paste it into Claude Code or Codex.' : 'Couldn’t copy the prompt.'); });
    nb.querySelector('[data-x]').addEventListener('click', () => { nb.remove(); document.body.classList.remove('sb-has-next'); size(); try { localStorage.setItem(key, '1'); } catch (e) {} });
    document.body.appendChild(nb); document.body.classList.add('sb-has-next'); size();
  }).catch(() => {});
  { let seen = false; try { seen = localStorage.getItem('__sb_welcome') === '1'; } catch (e) {}
    if (!seen && !SB.readonly) {
      const wc = h('div'); wc.id = 'sb-welcome';
      wc.innerHTML = `<h4>Three things to know</h4><ol>
        <li><b>Click any text on a slide to edit it.</b> It saves as you type.</li>
        <li><b>Leave a comment under a slide</b> for anything you want changed.</li>
        <li><b>Click Ask Claude</b> (or say “process changes” in Claude Code). Claude edits the deck, replies under each comment, and exports a PDF.</li></ol>
        <p><kbd>N</kbd> adds a slide · <kbd>1</kbd>–<kbd>5</kbd> run the checks · <kbd>?</kbd> shows every shortcut</p><button class="sb-btn red">Got it</button>`;
      wc.querySelector('button').addEventListener('click', () => { wc.remove(); try { localStorage.setItem('__sb_welcome', '1'); } catch (e) {} });
      document.body.appendChild(wc);
    } }

  const banner = h('div'); banner.id = 'sb-banner';
  banner.innerHTML = '<span>Claude updated this deck.</span><button class="sb-btn">Reload</button>';
  banner.querySelector('button').addEventListener('click', () => reload());
  document.body.appendChild(banner);

  const saved = $('#sb-saved');
  window.addEventListener('sb:saved', () => { saved.textContent = 'Saved'; saved.classList.remove('off'); });
  window.addEventListener('sb:offline', () => { saved.textContent = 'Server offline: saving in this browser'; saved.classList.add('off'); });

  let dragId = null;   // the slide being dragged, in the filmstrip or the sorter
  // ---------- focus view: filmstrip and thread panel ----------
  const film = h('aside'); film.id = 'sb-film';
  film.innerHTML = '<div class="sb-colhead"><span id="sb-film-h">Slides</span><button data-hide="left" title="Hide ( [ )">«</button></div><div class="sb-scroll" id="sb-film-list"></div>';
  const panel = h('aside'); panel.id = 'sb-panel';
  panel.innerHTML = '<div class="sb-colhead"><span>Notes</span><button data-hide="right" title="Hide ( ] )">»</button></div><div class="sb-scroll" id="sb-panel-body"></div>';
  document.body.append(film, panel);
  // the filters and Looks good act on the slide list, so they live with it (and keep the top bar short)
  { const ch = $('#sb-chips'), rs = $('#sb-resolve'), tools = h('div', 'sb-filmtools'); film.querySelector('.sb-colhead').after(tools); tools.append(ch, rs); }
  const sorter = h('div'); sorter.id = 'sb-sorter';
  deck.before(sorter);
  const checks = h('div'); checks.id = 'sb-checks';
  deck.before(checks);
  const under = h('div', 'sb-under');
  under.innerHTML = '<span id="sb-pos"></span><span><button class="sb-btn" id="sb-prev">← Previous</button> <button class="sb-btn red" id="sb-reveal" title="Show or hide this slide\'s content (space)">Reveal</button> <button class="sb-btn" id="sb-next">Next →</button></span>';
  deck.after(under);
  film.querySelector('[data-hide]').addEventListener('click', () => toggleSide('left'));
  panel.querySelector('[data-hide]').addEventListener('click', () => toggleSide('right'));
  $('#sb-prev').addEventListener('click', () => step(-1));
  $('#sb-next').addEventListener('click', () => step(1));
  $('#sb-reveal').addEventListener('click', () => reveal());
  under.addEventListener('click', (e) => { if (e.target.closest('[data-keys]')) { e.stopPropagation(); closeMenus(); help.classList.toggle('on'); } });

  const thumbs = new IntersectionObserver((es) => es.forEach((e) => { if (!e.isIntersecting) return; const box = e.target; thumbs.unobserve(box); fillThumb(box); }), { root: $('#sb-film-list'), rootMargin: '300px' });
  function fillThumb(box) {
    const w = wrapOf(box.dataset.id); const s = w && w.querySelector('.slide'); if (!s) return;
    const c = s.cloneNode(true);
    c.querySelectorAll('.ctrls, .slide-tag, .sb-badge').forEach((x) => x.remove());
    c.querySelectorAll('[contenteditable]').forEach((x) => x.removeAttribute('contenteditable'));
    c.querySelectorAll('[id]').forEach((x) => x.removeAttribute('id'));
    c.style.transform = ''; box.innerHTML = ''; box.appendChild(c);
  }

  const dotsFor = (id) => { const i = info(id); let d = '';
    if (i.st === 'working') d += '<span class="sb-dot w">Claude working</span>';
    else if (i.question) d += '<span class="sb-dot q">Question</span>';
    else if (i.st === 'done' && i.text) d += '<span class="sb-dot d">Done</span>';
    else if (i.st === 'skipped' && i.text) d += '<span class="sb-dot">Skipped</span>';
    else if (i.open) d += `<span class="sb-dot c">${i.hold ? 'Drafting' : 'Comment'}</span>`;
    if (i.changed) d += '<span class="sb-dot x">Changed</span>';
    return d; };

  let filmKey = '';
  function renderFilm() {
    const list = $('#sb-film-list'), all = wraps().map((w) => w.dataset.id), ids = visible();
    $('#sb-film-h').textContent = filter === 'all' ? `Slides · ${all.length}` : `${ids.length} of ${all.length}`;
    const outIds = [...document.querySelectorAll('#block-list input[data-id]')].filter((i) => !i.checked).map((i) => i.dataset.id);
    const key = [filter, all.join(','), ids.join(','), outIds.join(',')].join('|');
    if (key === filmKey && list.firstChild) {   // same slides in the same order: refresh labels, keep the thumbnails
      list.querySelectorAll('.sb-fi').forEach((b) => { const id = b.dataset.id, t = title(id), d = b.querySelector('.sb-dots'), fl = b.querySelector('.sb-fl'), html = dotsFor(id);
        b.classList.toggle('on', id === cur); if (d.innerHTML !== html) d.innerHTML = html; if (fl.textContent !== t) { fl.textContent = t; b.title = t; } });
      return;
    }
    filmKey = key;
    list.innerHTML = '';
    if (!ids.length) { list.appendChild(h('div', 'sb-empty', 'Nothing here. Pick another filter.')); return; }
    ids.forEach((id) => {
      const n = all.indexOf(id) + 1;
      const b = h('button', 'sb-fi' + (id === cur ? ' on' : ''));
      b.dataset.id = id; b.title = title(id);
      b.innerHTML = `<span class="sb-fn">${n}</span><span class="sb-thumb" data-id="${esc(id)}"></span><span class="sb-fn"></span><span class="sb-fl">${esc(title(id))}</span><span class="sb-fn"></span><span class="sb-dots">${dotsFor(id)}</span><span class="sb-x" role="button" title="Leave this slide out of this version" aria-label="Leave out">×</span>`;
      if (filter === 'all') {   // drag up and down to reorder
        b.draggable = true;
        b.addEventListener('dragstart', (e) => { dragId = id; b.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', id); });
        b.addEventListener('dragend', () => { dragId = null; list.querySelectorAll('.sb-fi').forEach((x) => x.classList.remove('dragging', 'drop-before', 'drop-after')); });
        b.addEventListener('dragover', (e) => { if (!dragId || dragId === id) return; e.preventDefault(); const r = b.getBoundingClientRect(), after = e.clientY > r.top + r.height / 2;
          list.querySelectorAll('.sb-fi').forEach((x) => x.classList.remove('drop-before', 'drop-after')); b.classList.add(after ? 'drop-after' : 'drop-before'); });
        b.addEventListener('drop', (e) => { e.preventDefault(); if (!dragId || dragId === id) return; const after = b.classList.contains('drop-after');
          const order = all.filter((x) => x !== dragId); order.splice(order.indexOf(id) + (after ? 1 : 0), 0, dragId); const moved = dragId; saveOrder(order); setTimeout(() => go(moved, true), 200); });
      }
      b.addEventListener('click', (e) => {
        if (e.target.closest('.sb-x')) { e.stopPropagation(); const w = wrapOf(id), rm = w && w.querySelector('.ctrls [data-a="rm"]'); if (rm) { const k = ids.indexOf(id); if (id === cur) cur = ids[k + 1] || ids[k - 1] || null; rm.click(); } return; }
        go(id);
      });
      list.appendChild(b);
      thumbs.observe(b.querySelector('.sb-thumb'));
    });
    const out = [...document.querySelectorAll('#block-list input[data-id]')].filter((i) => !i.checked && lib()[i.dataset.id] && !lib()[i.dataset.id].lib && !clientOnly.has(i.dataset.id));
    if (out.length && filter === 'all') {
      const ex = h('details', 'sb-extras'); ex.open = !!ui.extrasOpen;
      ex.innerHTML = `<summary>Not in this version · ${out.length}</summary>`;
      ex.addEventListener('toggle', () => { ui.extrasOpen = ex.open; saveUi(); });
      out.forEach((inp) => {
        const id = inp.dataset.id, b = lib()[id] || {};
        const tag = b.fac ? 'Facilitator' : b.prop ? 'Proposed' : b.alt ? 'Extra' : '';
        const r = h('div', 'sb-ex', `<span>${tag ? `<span class="sb-tag">${tag}</span>` : ''}${esc(title(id))}</span><button class="sb-btn">Add</button>`);
        r.querySelector('button').addEventListener('click', () => { inp.click(); setTimeout(() => go(id), 250); });
        ex.appendChild(r);
      });
      list.appendChild(ex);
    }
  }


  // the right bar: the slide's notes and what changed. Comments live under the slide itself.
  function renderPanel() {
    const body = $('#sb-panel-body'); if (!cur) { body.innerHTML = '<div class="sb-empty">No slide selected.</div>'; return; }
    const id = cur, i = info(id), all = wraps().map((w) => w.dataset.id), n = all.indexOf(id) + 1;
    const notes = notesOf(id), o = origOf(id), on = o ? all.indexOf(o) + 1 : 0, sibs = o ? optionsOf(o).filter((y) => y !== id) : [];
    body.innerHTML = `<div class="sb-sec"><p class="sb-title">${esc(title(id))}</p><div class="sb-meta">Slide ${n} of ${all.length} · ${esc(id)}</div>${o ? `<div class="sb-meta sb-pmeta">${optionsOf(o).length > 1 ? `Option ${optionsOf(o).indexOf(id) + 1} of ${optionsOf(o).length} · ` : ''}${{ accept: `Proposed · accepted in place of ${esc(o)}`, keep: `Proposed · you kept the original, ${esc(o)}` }[(decisionOf(id) || {}).d] || `Proposed · would replace ${on ? `slide ${on}` : `${esc(o)}, which isn’t in this version`}`}</div>` : ''}</div>
      <div class="sb-sec" id="sb-change-slot">${changeBlock(id, i)}</div>
      ${historyBlock(id) ? `<div class="sb-sec">${historyBlock(id)}</div>` : ''}
      ${changesBlock(id, i) ? `<div class="sb-sec">${changesBlock(id, i)}</div>` : ''}
      <div class="sb-sec"><h4>Notes and sources</h4>${notes ? `<div class="sb-notes">${esc(notes)}</div>` : '<div class="sb-hint">No notes on this slide.</div>'}</div>
      ${o ? `<div class="sb-sec"><h4>The original</h4><button class="sb-porig" data-flipo="${esc(o)}" title="Show it in place of the proposal (Space)"><span class="sb-pthumb" data-id="${esc(o)}"></span></button><div class="sb-hint">${esc(title(o))}</div></div>` : ''}
      ${sibs.length ? `<div class="sb-sec"><h4>The other options</h4><div class="sb-psibs">${sibs.map((y) => `<button class="sb-porig" data-flipo="${esc(y)}" title="Show it here (Space)"><span class="sb-pthumb" data-id="${esc(y)}"></span><span class="sb-hint">Option ${optionsOf(o).indexOf(y) + 1}</span></button>`).join('')}</div></div>` : ''}
      <div class="sb-sec"><div class="sb-hint">${o ? 'Accept it or keep your original with the buttons under the slide, or ask for a change in the box. Space flips between the two.' : 'Comment under the slide, then click Ask Claude (or say “process changes” in Claude Code). Tick “Still drafting” to hold one back.'}</div></div>`;
    body.querySelectorAll('.sb-pthumb').forEach((pt) => requestAnimationFrame(() => fitThumb(pt, pt.clientWidth / 1000)));
  }
  // the slide's thread: each earlier comment, Claude's reply, and how it ended
  const historyBlock = (id) => {
    const hs = (review.history || []).filter((x) => x.slide === id && x.reply && x.reply.status !== 'working');
    if (!hs.length) return '';
    const day = (t) => t ? new Date(t * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
    const said = { done: 'Done', question: 'Question', skipped: 'Skipped' };
    const end = (x) => x.resolved ? 'Looks good' : x.reopened ? 'Reopened' : x.reply.status === 'question' ? 'You answered' : 'Followed up';
    return `<h4>History on this slide</h4><ol class="sb-hist">${hs.map((x) => `<li>
      ${x.reply.forText ? `<div class="sb-h-you"><b>You</b>${esc(x.reply.forText)}</div>` : ''}
      <div class="sb-h-claude"><b>Claude · ${said[x.reply.status] || ''}</b>${esc(x.reply.text)}</div>
      <div class="sb-h-end">${end(x)} · ${day(x.resolved || x.reopened || x.replaced)}</div></li>`).join('')}</ol>`;
  };
  const changesBlock = (id, i) => {
    const rows = (review.rounds || []).slice().reverse().filter((r) => !(i.ch && i.ch.round === r.number)).map((r) => ({ r, note: notesOf2(r)[id] })).filter((x) => x.note !== undefined);
    return rows.length ? `<h4>Changes to this slide</h4><ol class="sb-hist sb-chist">${rows.map(({ r, note }) => `<li><b>Round ${esc(r.number)}${r.at ? ` · ${esc(dayOf(r.at))}` : ''}</b>${note ? esc(note) : 'Changed in this round.'}</li>`).join('')}</ol>` : '';
  };
  const changeBlock = (id, i) => i.ch ? `<h4>Changed in round ${esc(i.ch.round || '')}<button class="sb-btn" data-act="seen" style="padding:2px 8px;font-size:11.5px;text-transform:none;letter-spacing:0">Mark as seen</button></h4><div class="sb-change">${esc(i.ch.note || 'Updated this round.')}</div>` : '<div class="sb-hint">No changes on this slide in the last round.</div>';

  // buttons inside the panel and under slides
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const id = b.closest('[data-sbid]') ? b.closest('[data-sbid]').dataset.sbid : cur; if (!id) return;
    const act = b.dataset.act; b.disabled = true;
    if (act === 'resolve') post({ op: 'resolve', slide: id }).then((r) => { setComment(id, ''); setReview(r); });
    else if (act === 'reopen') post({ op: 'reopen', slide: id, text: commentOf(id) }).then(setReview);
    else if (act === 'seen') post({ op: 'seen', slides: [id] }).then(setReview);
  });

  // ---------- sorter ----------
  const fitThumb = (box, k) => { let w = wrapOf(box.dataset.id) || null; if (!w) { try { w = build(box.dataset.id); } catch (e) { w = null; } } const s0 = w && w.querySelector('.slide'); if (!s0) return;
    const c = s0.cloneNode(true);
    c.querySelectorAll('.ctrls, .slide-tag, .sb-badge').forEach((x) => x.remove()); c.querySelectorAll('[contenteditable]').forEach((x) => x.removeAttribute('contenteditable')); c.querySelectorAll('[id]').forEach((x) => x.removeAttribute('id'));
    c.style.transform = `scale(${k})`; box.innerHTML = ''; box.appendChild(c); };
  const lazy = new IntersectionObserver((es) => {   // every thumbnail is the same width: measure once, not once per slide
    const boxes = es.filter((e) => e.isIntersecting).map((e) => e.target); if (!boxes.length) return;
    const k = boxes[0].clientWidth / 1000; boxes.forEach((b) => { lazy.unobserve(b); fitThumb(b, k); });
  }, { rootMargin: '400px' });
  const refitThumbs = debounce(() => { const boxes = [...sorter.querySelectorAll('.sb-tb')]; if (!boxes.length) return; const k = boxes[0].clientWidth / 1000; boxes.forEach((box) => { const sl = box.querySelector('.slide'); if (sl) sl.style.transform = `scale(${k})`; }); }, 30);
  function saveOrder(ids) {
    try { if (typeof applyOrder === 'function') { applyOrder(ids); return; } } catch (e) {}   // eslint-disable-line no-undef
    ids.forEach((id) => { const w = wrapOf(id); if (w) deck.appendChild(w); });
    try { if (typeof numberSlides === 'function') numberSlides(); } catch (e) {}              // eslint-disable-line no-undef
    deck.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function renderSorter() {
    const ids = wraps().map((w) => w.dataset.id), y = window.scrollY;
    const zw = ui.zoom || 210;
    sorter.innerHTML = `<div class="sb-sorter-head"><span><b>${ids.length} slides</b> in this version · drag to reorder · click a slide to open it</span><label class="sb-zoom">Smaller <input type="range" min="120" max="520" step="10" value="${zw}" aria-label="Thumbnail size"> Bigger</label></div><div class="sb-grid" id="sb-grid"></div>`;
    sorter.style.setProperty('--sb-thumbw', zw + 'px');
    const zoom = sorter.querySelector('.sb-zoom input');
    zoom.addEventListener('input', () => { sorter.style.setProperty('--sb-thumbw', zoom.value + 'px'); refitThumbs(); });
    zoom.addEventListener('change', () => { ui.zoom = +zoom.value; saveUi(); });
    const grid = $('#sb-grid', sorter);
    ids.forEach((id, k) => {
      const c = h('div', 'sb-card' + (id === cur ? ' on' : '')); c.draggable = true; c.dataset.id = id; c.title = title(id);
      c.innerHTML = `<div class="sb-tb" data-id="${esc(id)}"></div><span class="sb-x" title="Leave this slide out of this version">×</span><div class="sb-cap"><b>${k + 1}</b><span class="sb-t">${esc(title(id))}</span><span class="sb-dots">${dotsFor(id)}</span></div>`;
      c.addEventListener('click', (e) => {
        if (e.target.closest('.sb-x')) { const rm = wrapOf(id) && wrapOf(id).querySelector('.ctrls [data-a="rm"]'); if (rm) rm.click(); return; }
        cur = id; setView('focus');
      });
      c.addEventListener('dragstart', (e) => { dragId = id; c.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', id); });
      c.addEventListener('dragend', () => { dragId = null; grid.querySelectorAll('.sb-card').forEach((x) => x.classList.remove('dragging', 'drop-before', 'drop-after')); });
      c.addEventListener('dragover', (e) => { if (!dragId || dragId === id) return; e.preventDefault(); const r = c.getBoundingClientRect(), after = e.clientX > r.left + r.width / 2;
        grid.querySelectorAll('.sb-card').forEach((x) => x.classList.remove('drop-before', 'drop-after')); c.classList.add(after ? 'drop-after' : 'drop-before'); });
      c.addEventListener('drop', (e) => { e.preventDefault(); if (!dragId || dragId === id) return; const after = c.classList.contains('drop-after');
        const order = ids.filter((x) => x !== dragId); order.splice(order.indexOf(id) + (after ? 1 : 0), 0, dragId); cur = dragId; saveOrder(order); });
      grid.appendChild(c); lazy.observe(c.querySelector('.sb-tb'));
    });
    const out = [...document.querySelectorAll('#block-list input[data-id]')].filter((i) => !i.checked && lib()[i.dataset.id] && !lib()[i.dataset.id].lib && !clientOnly.has(i.dataset.id));
    if (out.length) {
      const shelf = h('div', 'sb-shelf', `<h4>Not in this version · ${out.length}</h4><div class="sb-grid"></div>`);
      const g2 = shelf.querySelector('.sb-grid');
      out.forEach((inp) => { const id = inp.dataset.id, b = lib()[id] || {}, tag = b.fac ? 'Facilitator' : b.prop ? 'Proposed' : b.alt ? 'Extra' : '';
        const c = h('div', 'sb-card', `<div class="sb-tb" data-id="${esc(id)}"></div><div class="sb-cap"><span></span><span class="sb-t">${tag ? `<span class="sb-tag" style="font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:#8A4B00;background:#FFF1DC;border-radius:4px;padding:0 4px;margin-right:4px">${tag}</span>` : ''}${esc(title(id))}</span></div><button class="sb-btn sb-add">Add to this version</button>`);
        c.querySelector('.sb-add').addEventListener('click', () => { inp.click(); });
        g2.appendChild(c);
        const box = c.querySelector('.sb-tb'); box.dataset.id = id;
        lazy.observe(box); });
      sorter.appendChild(shelf);
    }
    window.scrollTo(0, y);
  }

  // ---------- checks: read the story (horizontal flow), or the title test ----------
  const EXEMPT = new Set(['title', 'closing', 'reflect', 'lines', 'statement', 'image', 'photo', 'agenda', 'pptx', 'team']);
  // a slide's title, wherever its layout puts it (guides.js knows how to find one)
  const titleOfSlide = (sl) => { if (!sl) return null; const d = sl.querySelector(':scope > .h-title'); if (d && d.textContent.trim()) return d;
    try { return window.SBGuides && window.SBGuides.titleOf ? window.SBGuides.titleOf(sl) : null; } catch (e) { return null; } };
  const titleEl = (id) => { const w = wrapOf(id); return w && titleOfSlide(w.querySelector('.slide')); };
  const catOf = (id) => (lib()[id] || {}).cat || '';
  function flags(id, text) {
    const b = lib()[id] || {}, f = [];
    if (!text || EXEMPT.has(b.layout) || /-section$/.test(id)) return f;
    const words = text.split(/\s+/).filter(Boolean).length;
    if (words <= 4 && !text.includes(':')) f.push(['Topic label', 'Reads like a label. Say the point.']);
    if (words > 22 || text.length > 130) f.push(['Long', 'Hard to take in at a glance.']);
    const halves = text.split(', ');   // "The same shape, blank": a short fragment, a comma, a short twist
    if (halves.length === 2 && !text.includes(':') && halves.every((x) => x.split(/\s+/).length <= 4)) f.push(['Comma pivot', 'A fragment with a twist. Write the plain sentence.']);
    return f;
  }
  const sentence = (id, k) => {
    const t = titleEl(id), text = t ? t.innerText.replace(/\s+/g, ' ').trim() : title(id), f = t ? flags(id, text) : [];
    const dot = !/[.?!:”"…]$/.test(text);
    return `<span class="s${t ? '' : ' none'}${f.length ? ' flag' : ''}" data-id="${esc(id)}" data-n="${k + 1}"${f.length ? ` data-flags="${esc(JSON.stringify(f))}"` : ''}${t && t.isContentEditable ? ' contenteditable="plaintext-only" spellcheck="true"' : ''}${dot ? ' data-dot' : ''}>${esc(text)}</span>`;
  };
  // Help me choose: what you want to know, and the check that answers it
  let chHelp = false;
  const CHOOSE = [
    ['horizontal', 'Does my overall story flow?', 'Horizontal flow', 'Read only the titles, in order. They should tell the whole story.'],
    ['vertical', 'Does each slide prove its title?', 'Vertical flow', 'See the title first, say what the slide must show, then check the body.'],
    ['five', 'Will people get it when I present?', '5-second test', 'Glance at each slide for five seconds. Did the one point come through?'],
    ['ten', 'Can someone read it on their own?', '10-second test', 'Ten seconds per slide: one point, a clear hierarchy, nothing to decode.'],
    ['guides', 'Does it look professional?', 'Guides', 'Margins, title length, text size, and how many text sizes.']];
  const KEYS = { five: 1, ten: 2, horizontal: 3, vertical: 4, guides: 5 };
  const CHPICK = `<div class="sb-chpick"><div class="sb-chq">What do you want to know?</div><div class="sb-chopts">${CHOOSE.map(([m, q, name, how]) =>
    `<button data-pick="${m}"><b>${q}</b><span class="sb-chname">${name} <kbd>${KEYS[m]}</kbd></span><span class="sb-chhow">${how}</span></button>`).join('')}</div>
    <div class="sb-chorder"><b>Going through a whole deck?</b> This order works: Horizontal flow, then Vertical flow, then the 5-second test if you'll present it (or the 10-second test if people will read it), then Guides.</div></div>`;
  checks.addEventListener('click', (e) => {
    if (e.target.closest('[data-chhelp]')) { chHelp = !chHelp; renderChecks(); return; }
    const p = e.target.closest('[data-pick]'); if (p) { chHelp = false; openCheck(p.dataset.pick); }
  });
  function renderChecks() {
    if (checks.querySelector('[contenteditable]:focus')) return;   // don't rebuild under the cursor
    const ids = wraps().map((w) => w.dataset.id), fmt = ui.fmt || 'para';
    let mode = ui.checks || 'horizontal'; if (!['five', 'ten', 'horizontal', 'vertical', 'guides'].includes(mode)) mode = 'horizontal';
    const timed = mode === 'five' || mode === 'ten';
    const nflag = ids.filter((id) => { const t = titleEl(id); return t && flags(id, t.innerText.trim()).length; }).length;
    let body = '';
    // the deck's own section divider slides become headings
    const isDivider = (id) => /-section$|^div-/.test(id) || ['section', 'divider'].includes((lib()[id] || {}).layout);
    if (fmt === 'para') {   // one paragraph per part of the deck, the titles as its sentences
      let para = [], last = null;
      const flush = () => { if (para.length) body += `<p>${para.join(' ')}</p>`; para = []; };
      ids.forEach((id, k) => {
        if (isDivider(id)) { flush(); body += `<h4 class="sb-divh">${sentence(id, k)}</h4>`; last = catOf(id); return; }
        if (last !== null && catOf(id) !== last) flush();
        last = catOf(id); para.push(sentence(id, k));
      });
      flush();
    } else {
      let last = null;
      ids.forEach((id, k) => { const dv = isDivider(id); body += `<div class="ln${dv ? ' divl' : ''}${!dv && last !== null && catOf(id) !== last ? ' gap' : ''}"><button class="no" data-open="${esc(id)}" title="Open slide ${k + 1}">${k + 1}</button><span>${sentence(id, k)}</span></div>`; last = catOf(id); });
    }
    const tally = timed ? Object.values(tenLog(mode)) : [], fails = tally.filter((x) => x === 'fail').length;
    const concept = {
      five: ['Check whether you can quickly grasp the slide in 5 seconds.', 'Even better: show it to someone who hasn’t seen the slide. See if they can grok it.'],
      ten: ['A slightly longer check.', 'The <a href="https://strategyu.co/ten-second-test/" target="_blank" rel="noopener">ten-second test</a> is best practice for a deck people will read: they may have a little more time, and the goal is still to capture their attention in 10 seconds.'],
      horizontal: ['The principle of “<a href="https://strategyu.co/persuasive-powerpoint-storytelling-principles-of-flow/#:~:text=%232%20Horizontal%20Flow" target="_blank" rel="noopener">horizontal flow</a>” is the idea that your slides should tell a coherent story.', 'A good way to test this is to read the titles in order to see if they make sense.'],
      vertical: ['The principle of “<a href="https://strategyu.co/persuasive-powerpoint-storytelling-principles-of-flow/#:~:text=%231%20Vertical%20Flow" target="_blank" rel="noopener">vertical flow</a>” is that the title is the takeaway and the body proves it.', 'Read the title, say what the slide must show, then reveal it and check.'],
      guides: ['Here are some basic principles for spacing, margins, titles, and text.', 'These are guidelines, not rules. They’re meant to help you make a more professional presentation.'] };
    const status = {
      five: tally.length ? `${tally.length} checked${fails ? `, ${fails} missed (left as comments for Claude)` : ''}.` : '',
      ten: tally.length ? `${tally.length} checked${fails ? `, ${fails} too much to take in (left as comments for Claude)` : ''}.` : '',
      horizontal: `${nflag ? `${nflag} note${nflag === 1 ? '' : 's'} in the margin. ` : ''}Click any sentence to edit it. Grey sentences are slides without a title, like quotes and discussion questions.`,
      vertical: '',
      guides: '' };
    const notes = Object.fromEntries(Object.keys(concept).map((k) => [k, `<b class="sb-idea">${concept[k][0]}</b><span class="sb-how">${concept[k][1]}</span>${status[k] ? `<span class="sb-stat">${status[k]}</span>` : ''}`]));
    const G = window.SBGuides || { MIN_TEXT: 12, MAX_SIZES: 4 };
    notes.guides += `<ul class="sb-principles">
      <li><b>Margins.</b> Keep text and figures inside the hatched border. The edge is kept for the logo, the source line, and the page number.</li>
      <li><b>Titles.</b> Two lines at most. The dashed box shows how much room that is.</li>
      <li><b>Text size.</b> Nothing smaller than ${G.MIN_TEXT} px on the slide (about 11 pt in PowerPoint), so it reads when projected.</li>
      <li><b>Text sizes.</b> Three or four sizes on a slide is usually enough. More starts to look unplanned.</li></ul>
      <div class="sb-glist" id="sb-glist"><span class="sb-stat">Checking every slide…</span></div>`;
    checks.innerHTML = `<div class="sb-modebar">
        <div class="sb-seg" role="group" aria-label="Check"><button data-mode="five" class="${mode === 'five' ? 'on' : ''}">5-second test <kbd>1</kbd></button><button data-mode="ten" class="${mode === 'ten' ? 'on' : ''}">10-second test <kbd>2</kbd></button><button data-mode="horizontal" class="${mode === 'horizontal' ? 'on' : ''}">Horizontal flow <kbd>3</kbd></button><button data-mode="vertical" class="${mode === 'vertical' ? 'on' : ''}">Vertical flow <kbd>4</kbd></button><button data-mode="guides" class="${mode === 'guides' ? 'on' : ''}">Guides <kbd>5</kbd></button></div>
        <button class="sb-btn sb-chhelp${chHelp ? ' on' : ''}" data-chhelp aria-expanded="${chHelp}">Help me choose</button>
        </div>
      ${chHelp ? CHPICK : ''}
      <div class="sb-note" style="${mode === 'horizontal' ? '' : 'display:block!important'}">${notes[mode]}</div>
      ${mode !== 'horizontal' ? '<div class="sb-timed" id="sb-timed"></div>' : ''}
      ${mode === 'horizontal' ? `<div class="sb-readwrap"><div class="sb-seg sb-fmt" role="group" aria-label="Format"><button data-fmt="para" class="${fmt === 'para' ? 'on' : ''}">Paragraphs <kbd>P</kbd></button><button data-fmt="lines" class="${fmt === 'lines' ? 'on' : ''}">One per line <kbd>L</kbd></button></div><div></div><div class="sb-read${fmt === 'lines' ? ' lines' : ''}">${body}</div><div class="sb-margin"></div></div>` : ''}`;
    if (mode === 'horizontal') requestAnimationFrame(placeNotes);
    document.body.classList.toggle('sb-story', mode === 'horizontal');
    document.body.classList.toggle('sb-test', mode !== 'horizontal');
    document.body.classList.toggle('sb-vflow', mode === 'vertical');
    document.body.classList.toggle('sb-gcheck', mode === 'guides');
    if (mode === 'guides') requestAnimationFrame(() => setTimeout(guideList, 30));
    document.body.classList.toggle('sb-ten', timed);
    renderUnder(); requestAnimationFrame(masks);
  }
  function guideList() {
    const box = checks.querySelector('#sb-glist'); if (!box || !window.SBGuides) return;
    const res = window.SBGuides.scan(wraps()).filter((r) => r.issues.length);
    box.innerHTML = res.length
      ? `<span class="sb-stat">${res.length} slide${res.length === 1 ? '' : 's'} to look at:</span>` + res.map((r) => `<button class="sb-gitem" data-gjump="${esc(r.id)}" title="${esc(r.issues.map((g) => g.msg).join(' '))}"><b>${r.n}</b> ${esc(r.issues.map((g) => g.short || g.msg).join(' · '))}</button>`).join('')
        + `<button class="sb-btn sb-gall" data-gall title="Adds what each slide breaks to its comment, so Claude fixes them next round">Comment on all ${res.length}</button>`
      : '<span class="sb-stat">Every slide follows these guidelines.</span>';
  }
  checks.addEventListener('click', (e) => { const b = e.target.closest('[data-gjump]'); if (b) go(b.dataset.gjump, true); });
  // a guide a slide breaks becomes a comment for Claude, without leaving Checks
  const guideIssues = (id) => { try { const sl = id && wrapOf(id) && wrapOf(id).querySelector('.slide'); return sl && window.SBGuides ? window.SBGuides.issues(sl) : []; } catch (e) { return []; } };
  const guideNote = (id) => { const is = guideIssues(id); return is.length ? `Guides: ${is.map((g) => g.msg).join(' ')} Fix it so the slide passes Checks › Guides.` : ''; };
  function addGuideComment(id) {
    const note = guideNote(id); if (!note) return false;
    const now = commentOf(id), lines = now ? now.split('\n').filter((l) => !l.startsWith('Guides: ')) : [];   // a newer guides note replaces an older one
    setComment(id, [...lines, note].join('\n')); return true;
  }
  checks.addEventListener('click', (e) => {
    if (!e.target.closest('[data-gall]') || !window.SBGuides) return;
    const res = window.SBGuides.scan(wraps()).filter((r) => r.issues.length);
    res.forEach((r) => addGuideComment(r.id));
    say(`<b>Added a comment on ${res.length} slide${res.length === 1 ? '' : 's'}.</b> Click Ask Claude when you’re ready, and Claude fixes them next round.`);
    renderUnder();
  });
  function placeNotes() {
    const read = checks.querySelector('.sb-read'), margin = checks.querySelector('.sb-margin'); if (!read || !margin) return;
    margin.innerHTML = ''; const top0 = read.getBoundingClientRect().top; let floor = 0;
    read.querySelectorAll('.s.flag').forEach((sp) => {
      const f = JSON.parse(sp.dataset.flags || '[]'), n = h('div', 'sb-mnote'); n.dataset.id = sp.dataset.id;
      n.innerHTML = f.map(([l, w]) => `<b>${esc(l)}</b> ${esc(w)}`).join('<br>') + ` <button class="sb-open" data-open="${esc(sp.dataset.id)}">Slide ${esc(sp.dataset.n)} ↗</button>`;
      const y = Math.max(sp.getBoundingClientRect().top - top0, floor); n.style.top = y + 'px'; margin.appendChild(n); floor = y + n.offsetHeight + 8;
      n.addEventListener('mouseenter', () => sp.classList.add('hl')); n.addEventListener('mouseleave', () => sp.classList.remove('hl'));
      sp.addEventListener('mouseenter', () => n.classList.add('hl')); sp.addEventListener('mouseleave', () => n.classList.remove('hl'));
    });
    margin.style.minHeight = floor + 'px';
  }
  window.addEventListener('resize', debounce(() => { if (ui.view === 'checks') placeNotes(); }, 150));
  checks.addEventListener('click', (e) => {
    const m = e.target.closest('[data-mode]'), f = e.target.closest('[data-fmt]'), o = e.target.closest('[data-open]');
    if (m) { openCheck(m.dataset.mode); return; }
    if (f) { ui.fmt = f.dataset.fmt; saveUi(); renderChecks(); return; }
    if (o) { cur = o.dataset.open; setView('focus'); }
  });
  checks.addEventListener('input', (e) => {
    const sp = e.target.closest('.s[data-id]'), t = sp && titleEl(sp.dataset.id); if (!t) return;
    t.textContent = sp.innerText.replace(/\n/g, ' ');
    t.dispatchEvent(new Event('input', { bubbles: true }));
  });
  checks.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.closest('.s')) { e.preventDefault(); e.target.blur(); } });
  checks.addEventListener('focusout', debounce(() => { if (ui.view === 'checks') renderChecks(); }, 300));
  function openCheck(mode) {
    ui.checks = mode; saveUi();
    if (ui.view !== 'checks') { setView('checks'); return; }
    tenReady(); renderChecks(); if (mode !== 'horizontal') go(cur || visible()[0], true);
  }
  // 10-second test: ready (covered) -> showing for 10 s -> covered, then the verdict
  let tenState = 'ready', tenTimer = null;
  const isTimed = () => ui.view === 'checks' && (ui.checks === 'five' || ui.checks === 'ten');
  const tenLog = (m = ui.checks) => { ui.timed = ui.timed || {}; const k = m + ':' + SB.slug; ui.timed[k] = ui.timed[k] || {}; return ui.timed[k]; };
  const slideOf = (id) => { const w = id && wrapOf(id); return w && w.querySelector('.slide'); };
  function cover(msg) { const sl = slideOf(cur); if (!sl) return; sl.classList.add('sb-cover'); sl.dataset.msg = msg; const c = sl.querySelector('.sb-count'); if (c) c.remove(); }
  function tenReady() { clearTimeout(tenTimer); document.querySelectorAll('.slide.sb-cover').forEach((x) => x.classList.remove('sb-cover')); document.querySelectorAll('.sb-count').forEach((x) => x.remove()); tenState = 'ready'; if (isTimed()) cover(`You get ${ui.checks === 'five' ? 5 : 10} seconds with this slide. Press Start.`); renderUnder(); }
  function tenStart() { const sl = slideOf(cur); if (!sl) return; clearTimeout(tenTimer); const ms = ui.checks === 'five' ? 5000 : 10000;
    sl.classList.remove('sb-cover'); const c = h('div', 'sb-count'); c.style.animationDuration = ms + 'ms'; sl.appendChild(c); tenState = 'showing'; renderUnder();
    tenTimer = setTimeout(() => { cover('What was the one point?'); tenState = 'asked'; renderUnder(); }, ms); }
  function tenVerdict(ok) {
    tenLog()[cur] = ok ? 'pass' : 'fail'; saveUi();
    if (!ok) { const now = commentOf(cur), add = ui.checks === 'five' ? 'Five-second test: the one point didn’t come through at a glance.' : 'Ten-second test: too much to take in at a glance.'; if (!now.includes(add)) setComment(cur, now ? now + '\n' + add : add); }
    const ids = visible(), k = ids.indexOf(cur); if (k < ids.length - 1) go(ids[k + 1]); tenReady(); renderChecks();
  }
  function renderUnder() {
    let box = under.querySelector('span:last-child'); if (!box) return;
    const vflow = ui.view === 'checks' && ui.checks === 'vertical', gch = ui.view === 'checks' && ui.checks === 'guides';
    under.classList.toggle('sb-timed-on', isTimed() || vflow || gch);
    const K = (k) => `<kbd>${k}</kbd>`;
    if (gch) {
      box = checks.querySelector('#sb-timed'); if (!box) return;
      const is = guideIssues(cur), asked = is.length && commentOf(cur).includes(guideNote(cur));
      box.innerHTML = `<button class="sb-btn" data-u="prev">${K('←')} Previous</button> `
        + (is.length ? `<span class="sb-gnow">${esc(is.map((g) => g.short || g.msg).join(' · '))}</span> <button class="sb-btn ${asked ? 'sb-done' : 'red'}" data-u="gfix" ${asked ? 'disabled' : ''} title="Adds what this slide breaks to its comment, so Claude fixes it next round">${asked ? 'In the comment ✓' : 'Ask Claude to fix'}</button> ` : '<span class="sb-gnow ok">This slide follows the guides.</span> ')
        + `<button class="sb-btn" data-u="next">Next ${K('→')}</button>`;
    } else if (vflow) {
      box = checks.querySelector('#sb-timed'); if (!box) return;
      box.innerHTML = `<button class="sb-btn" data-u="prev">${K('←')} Previous</button> <button class="sb-btn red" data-u="reveal">Reveal ${K('Space')}</button> <button class="sb-btn" data-u="next">Next ${K('→')}</button>`;
    } else if (isTimed()) {
      box = checks.querySelector('#sb-timed'); if (!box) return;
      const five = ui.checks === 'five';
      box.innerHTML = tenState === 'ready' ? `<button class="sb-btn" data-u="prev">${K('←')} Previous</button> <button class="sb-btn red" data-u="start">Start ${five ? 5 : 10} seconds ${K('Space')}</button> <button class="sb-btn" data-u="next">Skip ${K('→')}</button>`
        : tenState === 'showing' ? '<button class="sb-btn" data-u="stop">Stop</button>'
        : `<button class="sb-btn" data-u="again">Show again ${K('A')}</button> <button class="sb-btn" data-u="fail">${five ? 'Missed the point' : 'Too much to take in'} ${K('M')}</button> <button class="sb-btn red" data-u="pass">${five ? 'Got the one point' : 'Got it at a glance'} ${K('Space')}</button>`;
    } else if (!box.querySelector('#sb-prev')) {
      box.innerHTML = '<button class="sb-btn" id="sb-prev">← Previous</button> <button class="sb-btn red" id="sb-reveal" title="Show or hide this slide\'s content (space)">Reveal</button> <button class="sb-btn" id="sb-next">Next →</button>';
      $('#sb-prev').addEventListener('click', () => step(-1)); $('#sb-next').addEventListener('click', () => step(1)); $('#sb-reveal').addEventListener('click', () => reveal());
    }
  }
  window.addEventListener('sb:slide', () => { if (ui.view === 'checks' && ui.checks === 'guides') renderUnder(); });
  document.addEventListener('click', (e) => { const g = e.target.closest('[data-u="gfix"]'); if (!g || !cur) return;
    if (addGuideComment(cur)) say('<b>Added to the comment under this slide.</b> Click Ask Claude when you’re ready.'); renderUnder(); });
  document.addEventListener('click', (e) => { const b = e.target.closest('[data-u]'); if (!b) return; const u = b.dataset.u;
    if (u === 'start' || u === 'again') tenStart(); else if (u === 'stop') { clearTimeout(tenTimer); tenReady(); } else if (u === 'pass') tenVerdict(true); else if (u === 'fail') tenVerdict(false);
    else if (u === 'reveal') reveal();
    else if (u === 'prev') { step(-1); if (isTimed()) tenReady(); } else if (u === 'next') { step(1); if (isTimed()) tenReady(); } });

  function setHide(on) { ui.hide = on; saveUi(); document.body.classList.toggle('sb-titles-only', !!on); setTog(vTitles, on); document.querySelectorAll('.slide.sb-reveal').forEach((x) => x.classList.remove('sb-reveal')); requestAnimationFrame(masks); }
  function reveal() { const w = cur && wrapOf(cur), sl = w && w.querySelector('.slide'); if (sl) sl.classList.toggle('sb-reveal'); masks(); }
  // Vertical flow and Titles only hide everything but the title. When the title sits right in the slide,
  // CSS does it. When a layout nests it (a column, a panel), a mask covers the slide with a hole cut around
  // the title, laid over the slide frame, so the slide's own HTML (and its saved edits) never changes.
  function markTitles() {
    wraps().forEach((w) => { const sl = w.querySelector('.slide'); if (!sl) return; const d = sl.querySelector(':scope > .h-title');
      sl.classList.toggle('sb-tx', !!d && titleOfSlide(sl) !== d); });   // its real title is elsewhere: leave it to the mask
  }
  function masks() {
    document.querySelectorAll('.sb-vmask').forEach((m) => m.remove());
    const vflow = ui.view === 'checks' && ui.checks === 'vertical', hide = !!ui.hide && ui.view !== 'checks' && ui.view !== 'sorter';
    if (!vflow && !hide) return;
    const msg = vflow ? 'What should the body prove? Reveal to check.' : 'Content hidden: what should this slide prove?';
    (vflow ? [cur && wrapOf(cur)] : wraps()).filter(Boolean).forEach((w) => {
      const sl = w.querySelector('.slide'), fr = sl && sl.parentElement; if (!sl || sl.classList.contains('sb-reveal')) return;
      const d = sl.querySelector(':scope > .h-title'), t = titleOfSlide(sl); sl.classList.toggle('sb-tx', !!d && t !== d);   // fresh, in case the slide was redrawn
      if (!t || t === d) return;
      const F = fr.getBoundingClientRect(), R = t.getBoundingClientRect(); if (!F.width || !R.width) return;
      const pc = (v, of) => Math.max(0, Math.min(100, v / of * 100)), pad = 6;
      const x1 = pc(R.left - F.left - pad, F.width), y1 = pc(R.top - F.top - pad, F.height), x2 = pc(R.right - F.left + pad, F.width), y2 = pc(R.bottom - F.top + pad, F.height);
      const m = h('div', 'sb-vmask'), bg = getComputedStyle(sl).backgroundColor;
      m.style.background = bg && !/rgba\(0, 0, 0, 0\)|transparent/.test(bg) ? bg : '#FFFFFF';
      m.style.clipPath = `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${x1}% ${y1}%, ${x2}% ${y1}%, ${x2}% ${y2}%, ${x1}% ${y2}%, ${x1}% ${y1}%)`;
      const box = h('div', 'sb-vmsg'); box.textContent = msg; box.style.fontSize = Math.max(11, 22 * F.width / 1000) + 'px';
      const top = Math.min(y2 + 4, 72); box.style.top = top + '%'; box.style.left = Math.max(6, Math.min(x1, 40)) + '%';
      m.appendChild(box); if (getComputedStyle(fr).position === 'static') fr.style.position = 'relative'; fr.appendChild(m);
    });
  }
  window.addEventListener('sb:slide', () => requestAnimationFrame(masks));
  window.addEventListener('resize', debounce(masks, 150));

  // ---------- views, navigation, and sizing ----------
  function setView(v) {
    ui.view = v; saveUi();
    top.querySelectorAll('.sb-seg button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
    document.body.classList.toggle('sb-focus', v === 'focus');
    document.body.classList.toggle('sb-scroll', v === 'scroll');
    document.body.classList.toggle('sb-sorter', v === 'sorter');
    document.body.classList.toggle('sb-checks', v === 'checks');
    if (v !== 'checks') { under.classList.remove('sb-timed-on'); document.body.classList.remove('sb-story', 'sb-test', 'sb-vflow', 'sb-ten', 'sb-gcheck'); clearTimeout(tenTimer); document.querySelectorAll('.slide.sb-cover').forEach((x) => x.classList.remove('sb-cover')); document.querySelectorAll('.sb-count').forEach((x) => x.remove()); const hl = under.parentNode && under.parentNode.querySelector('.sb-hint-line'); if (hl) hl.style.display = 'none'; }
    if (v === 'checks') { if (!cur || !wrapOf(cur)) cur = (wraps()[0] || {}).dataset?.id; renderChecks(); go(cur, true); if (isTimed()) tenReady(); window.scrollTo(0, 0); sideState(); return; }
    if (document.body.classList.contains('view-sorter') && $('[data-view="slides"]')) $('[data-view="slides"]').click();
    if (v === 'sorter') { wraps().forEach((w) => w.classList.remove('sb-active')); renderSorter(); window.scrollTo(0, 0); sideState(); return; }
    top.querySelectorAll('.sb-seg button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
    if (v === 'focus') { if (document.body.classList.contains('view-sorter') && $('[data-view="slides"]')) $('[data-view="slides"]').click(); if (!cur || !wrapOf(cur)) cur = (visible()[0] || (wraps()[0] || {}).dataset?.id); go(cur, true); }
    else { wraps().forEach((w) => w.classList.remove('sb-active')); deck.style.maxWidth = ''; renderFilm(); renderPanel(); requestAnimationFrame(() => { refit(); if (cur) { const w = wrapOf(cur); if (w) w.scrollIntoView({ block: 'start' }); } }); }
    sideState();
  }
  top.querySelectorAll('.sb-seg button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.v)));
  function sideState() {
    document.body.classList.toggle('sb-noleft', !!ui.noleft);
    document.body.classList.toggle('sb-noright', !!ui.noright);
    const noL = ui.view === 'sorter' || ui.view === 'checks', noR = noL;   // Focus and Scroll share both side bars
    setTog(vLeft, !ui.noleft && !noL); setTog(vRight, !ui.noright && !noR);
    vLeft.disabled = noL; vRight.disabled = noR;
    vLeft.title = vRight.title = noL ? 'The side bars are in Focus and Scroll' : '';
    size();
  }
  function toggleSide(which) { if ((which === 'left' ? vLeft : vRight).disabled) return; if (which === 'left') ui.noleft = !ui.noleft; else ui.noright = !ui.noright; saveUi(); sideState(); }

  function size() {
    const test = ui.view === 'checks';
    if (ui.view !== 'focus' && !test) { deck.style.maxWidth = ''; under.style.maxWidth = ''; refit(); return; }
    const css = getComputedStyle(document.documentElement), px = (v) => parseFloat(css.getPropertyValue(v)) || 0;
    const left = test || ui.noleft ? 0 : px('--sb-left'), right = test || ui.noright ? 0 : px('--sb-right');
    // the comment box and Claude's reply under the slide take room too, and they wrap differently at
    // different widths; always measure from the widest layout so the size never depends on the last one
    const aw = ui.view === 'focus' && cur && wrapOf(cur);
    const below = () => { let n = 0; if (aw) [...aw.children].forEach((c) => { if (c.querySelector('.slide') || c.classList.contains('slide') || c.classList.contains('sb-reply') || !c.offsetHeight) return; const cs = getComputedStyle(c); if (cs.position === 'absolute' || cs.position === 'fixed') return; n += c.offsetHeight + (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0); }); return n; };
    const W = window.innerWidth - left - right - 68, H0 = window.innerHeight - 52 - 22 - 70 - (document.body.classList.contains('sb-has-next') ? 42 : 0) - (test ? (checks.offsetHeight || 150) + 34 : 0);
    const fit = (b) => Math.max(320, Math.min(W, (H0 - b - 30) * 16 / 9));   // 30: one line for Claude's reply, kept on every slide so moving never resizes
    deck.style.maxWidth = Math.round(W) + 'px';
    let w = fit(below());
    deck.style.maxWidth = Math.round(w) + 'px';
    const w2 = fit(below()); if (w2 < w) { w = w2; deck.style.maxWidth = Math.round(w) + 'px'; }
    under.style.maxWidth = Math.round(w) + 'px';
    refit();
  }
  window.addEventListener('resize', debounce(() => { size(); if (ui.view === 'sorter') refitThumbs(); }, 120));
  new ResizeObserver(debounce(refit, 60)).observe(deck);

  function go(id, force, fromScroll) {
    if (!id || !wrapOf(id)) return;
    const changedSlide = id !== cur; cur = id;
    if (changedSlide) { const x = $('#sb-edge'); if (x) x.classList.remove('on'); }   // the end-of-filter hint belongs to the slide it was shown on
    if (changedSlide && flipped) flip(null);
    if (ui.view === 'focus') { wraps().forEach((w) => w.classList.toggle('sb-active', w.dataset.id === id)); size(); window.scrollTo(0, 0); }
    else if (ui.view === 'checks') { wraps().forEach((w) => w.classList.toggle('sb-active', w.dataset.id === id)); size(); window.scrollTo(0, 0);
      let hl = under.querySelector('.sb-hint-line'); if (!hl) { hl = h('div', 'sb-hint-line'); under.after(hl); }
      const t = titleEl(id), f = ui.checks === 'vertical' && t ? flags(id, t.innerText.trim()) : []; hl.textContent = f.map((x) => x[0] + ': ' + x[1]).join(' '); hl.style.display = f.length ? '' : 'none';
      if (isTimed() && changedSlide) tenReady(); }
    else if (ui.view === 'scroll' && !fromScroll) { tracking = false; wrapOf(id).scrollIntoView({ block: 'start' }); setTimeout(() => { tracking = true; }, 400); }
    history.replaceState(null, '', '#' + (sideSelect ? 'v=' + encodeURIComponent(sideSelect.value) + '&' : '') + 's=' + encodeURIComponent(id));
    const all = wraps().map((w) => w.dataset.id), ids = visible(), k = ids.indexOf(id);
    const pk = origOf(id) ? ((decisionOf(id) || {}).d ? ' · <kbd>U</kbd> undo' : ' · <kbd>A</kbd> accept · <kbd>K</kbd> keep · <kbd>Space</kbd> flip') : '';
    $('#sb-pos').innerHTML = `Slide ${all.indexOf(id) + 1} of ${all.length}${filter !== 'all' && k >= 0 ? ` · ${k + 1} of ${ids.length} ${esc(FILTERS.find((f) => f[0] === filter)[1].toLowerCase())}` : ''} · <kbd>←</kbd> <kbd>→</kbd>${pk ? '' : ' to move'}${pk} · <button class="sb-keyhint" data-keys>? shortcuts</button>`;
    $('#sb-film-list').querySelectorAll('.sb-fi').forEach((b) => b.classList.toggle('on', b.dataset.id === id));
    const on = $('#sb-film-list .sb-fi.on'); if (on) on.scrollIntoView({ block: 'nearest' });
    if ((changedSlide || force) && (ui.view === 'focus' || ui.view === 'scroll')) renderPanel();
    window.dispatchEvent(new CustomEvent('sb:slide', { detail: id }));   // for guides and anything else that draws on the slide in view
  }
  // scroll view: the left bar follows the slide you are looking at
  let tracking = true;
  const seen = new IntersectionObserver((es) => {
    if (ui.view !== 'scroll' || !tracking) return;
    const vis = es.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
    if (vis) go(vis.target.dataset.id, false, true);
  }, { rootMargin: '-60px 0px -55% 0px' });
  const watch = () => { seen.disconnect(); wraps().forEach((w) => seen.observe(w)); };
  function step(d) {
    const ids = visible(); if (!ids.length) return;
    const k = ids.indexOf(cur), next = ids[k < 0 ? 0 : Math.max(0, Math.min(ids.length - 1, k + d))];
    if (next === cur) { edge(d); return; }   // nothing further this way: say so instead of redrawing the same slide
    go(next);
  }
  let edgeTimer = null;
  function edge(d) {
    const pos = $('#sb-pos'); if (!pos) return;
    let e = $('#sb-edge'); if (!e) { e = h('span'); e.id = 'sb-edge'; pos.after(e); }
    const f = FILTERS.find((x) => x[0] === filter);
    e.innerHTML = filter !== 'all' ? `That’s the ${d > 0 ? 'last' : 'first'} ${esc(f[1].toLowerCase())} slide · <button class="sb-link" data-allf>Show all slides</button>` : `That’s the ${d > 0 ? 'last' : 'first'} slide`;
    e.classList.add('on'); clearTimeout(edgeTimer); edgeTimer = setTimeout(() => e.classList.remove('on'), 4000);
  }
  document.addEventListener('click', (e) => { if (!e.target.closest('[data-allf]')) return; filter = 'all'; refresh(); const x = $('#sb-edge'); if (x) x.classList.remove('on'); });

  // ---------- badges, replies under slides, counts ----------
  function decorate() {
    wraps().forEach((w) => {
      const id = w.dataset.id, i = info(id), fr = frameOf(w);
      w.dataset.sbid = id;
      const row = w.querySelector(':scope > .slide-no'), host = row || fr;   // in the row above the slide, so it never covers the title
      let bd = host.querySelector(':scope > .sb-badge');
      if (i.changed) { if (!bd) { bd = h('span', 'sb-badge' + (row ? ' inline' : '')); if (!row && getComputedStyle(fr).position === 'static') fr.style.position = 'relative'; host.appendChild(bd); } bd.textContent = `Changed · round ${i.ch.round || ''}`; }
      else if (bd) bd.remove();
      propBar(w, id, row);
      const fb = w.querySelector('textarea.fb'); if (!fb) return;
      const hold = holdRow(w); hold.querySelector('input').checked = i.hold;
      let rp = w.querySelector('.sb-reply');
      if (i.rep && (i.fresh || i.text)) {   // a reply to a comment saved in another version stays with that version
        if (!rp) { rp = h('div', 'sb-reply'); hold.after(rp); }
        const label = !i.fresh ? 'Claude · Earlier reply' : { done: 'Claude · Done', question: 'Claude · Question', skipped: 'Claude · Skipped', working: 'Claude · Working…' }[i.rep.status] || 'Claude';
        rp.className = 'sb-reply ' + (i.fresh ? i.rep.status : 'stale');
        rp.title = i.fresh ? '' : 'Claude wrote this before your current comment. It will reply to the new one next round.';
        rp.innerHTML = `<span class="sb-who">${label}</span><span class="sb-txt">${esc(i.rep.text)}</span>${i.rep.status === 'working' || !i.fresh ? '' : '<button class="sb-btn" data-act="resolve">Looks good</button><button class="sb-btn" data-act="reopen">Reopen</button>'}`;
      } else if (rp) rp.remove();
    });
  }
  // a proposed slide: Original | Proposed above it (Original | Option 1 | 2 | 3 when there are several),
  // Accept / Keep original under it, and its comment box asks for a change
  function propBar(w, id, row) {
    const o = origOf(id), fb = w.querySelector('textarea.fb');
    let bar = w.querySelector(':scope > .sb-pbar'), sw = row && row.querySelector('.sb-flip');
    w.classList.toggle('sb-isprop', !!o);
    if (fb) { if (!fb.dataset.ph) fb.dataset.ph = fb.placeholder; fb.placeholder = o ? 'Or ask for a change to this proposal…' : fb.dataset.ph; }
    const on = inVersion(), def = defaults(), x = o && decisionOf(id, on, def);
    if (!o) { if (bar) bar.remove(); if (sw) sw.remove(); return; }
    const all = [...on], g = x.g, ps = g.ps, many = ps.length > 1, at = all.indexOf(o) + 1;
    const leads = all.filter((y) => propLead(y, on, def)), k = leads.findIndex((y) => origOf(y) === o) + 1;
    const now = flipShows(id), j = flipList(id).indexOf(now);   // 0: the original; 1…: option j
    const optName = (y) => (many ? `Option ${ps.indexOf(y) + 1}` : 'Proposed');
    const sig = [many, ps.join()].join('|');
    if (sw && sw.dataset.sig !== sig) { sw.remove(); sw = null; }
    if (row && !sw) {
      sw = h('span', 'sb-flip', `<span class="sb-ppill"></span><span class="sb-seg2" role="group" aria-label="Show"><button data-flip="${esc(o)}" title="Show the original in its place (Space)">Original</button>${ps.map((y) => `<button data-flip="${esc(y)}" title="Show ${esc(optName(y).toLowerCase())} (Space)">${esc(optName(y))}</button>`).join('')}</span><button class="sb-spacekey" data-flipo="next" title="Flip to the ${many ? 'next one' : 'other one'} (Space${many ? '; Shift+Space goes back' : ''})"><kbd>Space</kbd> flips</button>`);
      sw.dataset.sig = sig; row.appendChild(sw);
    }
    if (sw) {
      sw.querySelector('.sb-ppill').textContent = !x.d && !x.out ? `Proposal ${k} of ${leads.length}${many ? ` · ${ps.length} options` : ''}` : x.d === 'accept' ? `Proposal · ${many ? `option ${ps.indexOf(id) + 1} ` : ''}accepted` : x.d === 'keep' ? 'Proposal · original kept' : 'Proposal';
      sw.querySelectorAll('[data-flip]').forEach((b) => b.classList.toggle('on', b.dataset.flip === now));
    }
    const vn = (v) => { const op = sideSelect && [...sideSelect.options].find((q) => q.value === v); return op ? verName(op.textContent) : v; };
    const K = (t) => `<kbd>${t}</kbd>`, left = leads.filter((y) => origOf(y) !== o).length;
    const where = at ? `slide ${at}` : `“${esc(title(o))}”`;
    const seeing = !many ? (j === 0 ? `<b>Showing the original.</b> ${K('Space')} flips back to the proposal.` : `<b>Would replace ${where}.</b> ${K('Space')} flips to the original.`)
      : `<b>${ps.length} options would replace ${where}.</b> ${j === 0 ? 'Showing the original.' : `Showing option ${j}.`} ${K('Space')} flips through them.`;
    const pickNow = j > 0 ? flipList(id)[j] : many ? null : id;   // one proposal: Accept means it, whichever is on screen
    const html = !x.d
      ? `<span class="sb-pb-t">${seeing} ${left ? `${left + 1} left to decide.` : 'The last one to decide.'}</span>
         <span class="sb-pb-b"><button class="sb-btn" data-pdo="keep" title="Keep your original and take ${many ? 'every option' : 'this proposal'} out (K)">Keep original${K('K')}</button><button class="sb-btn sb-acc" data-pdo="accept" ${pickNow ? `data-pick="${esc(pickNow)}"` : 'disabled'} title="${pickNow ? `Use ${many ? `option ${j}` : 'this slide'} in place of the original (A)` : 'Flip to the one you want first (Space)'}">${many && pickNow ? `Accept option ${j}` : 'Accept'}${K('A')}</button></span>`
      : `<span class="sb-pb-t"><b>${x.d === 'accept' ? (many ? `Accepted option ${ps.indexOf(id) + 1}.` : 'Accepted.') : 'You kept the original.'}</b> ${x.d === 'accept'
          ? (x.said ? `It has taken the original’s place in this version${many ? ', and the other options are out' : ''}.` : 'You took the original out of this version.')
          : `This proposal comes out${x.version && sideSelect && x.version !== sideSelect.value ? ` (you decided in ${esc(vn(x.version))})` : ''}.`} ${j === 0 ? `Showing the original; ${K('Space')} flips back.` : `${K('Space')} flips to the original.`} Claude writes it into the deck at the next round.</span>
         <span class="sb-pb-b"><button class="sb-btn" data-pdo="undo" title="Put the original and ${many ? 'every option' : 'the proposal'} back, and decide again (U)">Undo${K('U')}</button></span>`;
    if (!bar) { bar = h('div', 'sb-pbar'); const fr = frameOf(w); (fr !== w ? fr : w.querySelector('.slide')).after(bar); }
    bar.classList.toggle('done', !!x.d);
    if (bar.dataset.html !== html) { bar.innerHTML = html; bar.dataset.html = html; }
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pdo], [data-flip], [data-flipo]'); if (!b) return;
    const w = b.closest('#deck > [data-id]'), id = w ? w.dataset.id : cur; if (!id) return;
    if (id !== cur) go(id);
    if (b.dataset.pdo) decide(id, b.dataset.pdo === 'undo' ? null : b.dataset.pdo, b.dataset.pick);
    else if (b.dataset.flip) flip(b.dataset.flip);
    else flip(b.dataset.flipo || 'next');
  });

  // "Still drafting" sits under each comment and shows once there is text
  function holdRow(w) {
    const fb = w.querySelector('textarea.fb'); let r = w.querySelector('.sb-hold');
    if (!r) { r = h('label', 'sb-check sb-hold', '<input type="checkbox"> Still drafting: Claude skips it'); fb.after(r); }
    r.classList.toggle('empty', !fb.value.trim()); return r;
  }
  deck.addEventListener('change', (e) => {
    const box = e.target.closest('.sb-hold input'), w = box && box.closest('#deck > [data-id]'); if (!w) return;
    const id = w.dataset.id;
    post({ op: 'comment-state', slide: id, state: box.checked ? 'draft' : 'ready', text: commentOf(id), follow: box.checked }).then(setReview);
  });
  const released = new Set();
  const releaseEmpty = debounce(() => { released.forEach((id) => { const m = review.comments[id]; if (m && m.state === 'draft' && !commentOf(id)) post({ op: 'comment-state', slide: id, state: 'ready', text: '' }).then(setReview); }); released.clear(); }, 600);
  function counts() {
    const ids = wraps().map((w) => w.dataset.id);
    const n = { all: ids.length };
    FILTERS.slice(1).forEach(([f]) => { n[f] = ids.filter((id) => pass(id, f)).length; });
    $('#sb-chips').innerHTML = FILTERS.map(([f, l]) => (f === 'all' || n[f] || f === filter) ? `<button class="sb-chip${f === filter ? ' on' : ''}" data-f="${f}">${l} <b>${n[f]}</b></button>` : '').join('');
    const ask = ids.filter((id) => { const i = info(id); return i.open && !i.question; }).length + propDecided().length;
    const askN = $('#sb-ask-n'); if (askN) { askN.textContent = ask ? String(ask) : ''; askN.classList.toggle('on', ask > 0); }
    const done = ids.filter((id) => { const i = info(id); return i.st === 'done' && i.text; });
    const rb = $('#sb-resolve'); rb.hidden = done.length < 2; rb.textContent = `Looks good: all ${done.length} done`;
    rb.onclick = async () => { rb.disabled = true; for (const id of done) { const r = await post({ op: 'resolve', slide: id }); setComment(id, ''); review = r; } rb.disabled = false; refresh(); };
  }
  $('#sb-chips').addEventListener('click', (e) => { const b = e.target.closest('[data-f]'); if (!b) return; filter = b.dataset.f; refresh(); const x = $('#sb-edge'); if (x) x.classList.remove('on'); if (!pass(cur)) { const v = visible(); if (v.length) go(v[0]); } else go(cur); });   // go() also refreshes the position line

  function claudeLine() {
    const c = review.claude, el = $('#sb-claude');
    const fresh = c && (Date.now() / 1000 - (c.at || 0) < 1800);
    el.classList.toggle('on', !!fresh);
    if (fresh) el.querySelector('span').textContent = 'Claude' + (c.total ? `: ${c.done || 0} of ${c.total}` : '') + (c.text ? ' · ' + c.text : '');
  }
  function refresh() { placeProps(); counts(); decorate(); markTitles(); claudeLine(); renderFilm(); if (ui.view === 'scroll') renderPanel(); if (ui.view === 'focus') { renderPanel(); size(); } if (ui.view === 'sorter') renderSorter(); if (ui.view === 'checks') renderChecks();  requestAnimationFrame(masks); }
  function setReview(r) { if (r && r.replies) { review = r; reviewIn = true; } refresh(); }
  async function loadReview() { try { setReview(await (await fetch(api('review'))).json()); } catch (e) {} }

  // comments typed under a slide; edits on a slide refresh its thumbnail
  const staleThumbs = new Set();
  const refillThumbs = debounce(() => { staleThumbs.forEach((id) => { const box = $(`#sb-film-list .sb-thumb[data-id="${CSS.escape(id)}"]`); if (box && box.firstChild) fillThumb(box); }); staleThumbs.clear(); }, 700);
  const afterComment = debounce(() => { counts(); decorate(); renderFilm(); if (ui.view === 'focus') size(); }, 300);   // decorate: a reply written before this comment becomes an earlier reply
  deck.addEventListener('input', (e) => {
    const t = e.target, w = t.closest && t.closest('#deck > [data-id]'); if (!w) return;
    if (t.matches('textarea.fb')) { holdRow(w); afterComment(); if (!t.value.trim()) { released.add(w.dataset.id); releaseEmpty(); } }
    else if (t.isContentEditable) { staleThumbs.add(w.dataset.id); refillThumbs(); }
  });

  // the deck re-renders on version switches and reorders: follow it
  new MutationObserver(debounce(() => { if (cur && !wrapOf(cur)) cur = null; if (flipped && !document.querySelector('.sb-flipov')) flipped = null; refresh(); watch(); if (ui.view === 'focus') go(cur || visible()[0] || (wraps()[0] || {}).dataset?.id, true); }, 150)).observe(deck, { childList: true });

  // keyboard
  let lastKey = 0;
  document.addEventListener('keydown', (e) => {
    lastKey = Date.now();
    const t = e.target, typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    if (typing) { if (e.key === 'Escape') t.blur(); return; }
    if (e.metaKey || e.ctrlKey || e.altKey || presenting()) return;
    const nav = ui.view === 'focus' || (ui.view === 'checks' && ['vertical', 'ten', 'five', 'guides'].includes(ui.checks));
    if (isTimed() && e.key === ' ') { e.preventDefault(); if (tenState === 'ready') tenStart(); else if (tenState === 'asked') tenVerdict(true); return; }
    if (isTimed() && tenState === 'asked' && (e.key === 'm' || e.key === 'M')) { tenVerdict(false); return; }
    if (isTimed() && tenState === 'asked' && (e.key === 'a' || e.key === 'A')) { tenStart(); return; }
    const k = e.key.toLowerCase();
    const pv = (ui.view === 'focus' || ui.view === 'scroll') && cur && origOf(cur);
    if (pv && k === 'a') { const ps = optionsOf(origOf(cur)), sh = flipShows(cur), pick = ps.length > 1 ? (ps.includes(sh) ? sh : null) : cur;
      if (!pick) { say('That’s the original on screen. Flip to the option you want (Space), then press A.'); return; }
      const x = decisionOf(pick); if (!(x && x.d === 'accept')) decide(cur, 'accept', pick); return; }
    if (pv && k === 'k') { if ((groupOf(origOf(cur)) || {}).d !== 'keep') decide(cur, 'keep'); return; }
    if (k === 'u' && (ui.view === 'focus' || ui.view === 'scroll')) { undoDecision(); return; }
    if (pv && e.key === ' ' && !ui.hide) { e.preventDefault(); flip(e.shiftKey ? 'prev' : 'next'); return; }
    if (e.key === '?') { closeMenus(); help.classList.toggle('on'); return; }
    if (e.key === 'Escape') { help.classList.remove('on'); roundsCard.classList.remove('on'); closeMenus(); return; }
    const views = { f: 'focus', s: 'scroll', g: 'sorter', c: 'checks' }, tests = { 1: 'five', 2: 'ten', 3: 'horizontal', 4: 'vertical', 5: 'guides' };
    if (views[k]) { setView(views[k]); return; }
    if (tests[k]) { openCheck(tests[k]); return; }
    if (nav && (e.key === 'Home' || e.key === 'End')) { e.preventDefault(); const ids = visible(); go(e.key === 'Home' ? ids[0] : ids[ids.length - 1]); if (isTimed()) tenReady(); return; }
    if (ui.view === 'checks' && (ui.checks || 'horizontal') === 'horizontal' && (k === 'p' || k === 'l')) { ui.fmt = k === 'p' ? 'para' : 'lines'; saveUi(); renderChecks(); return; }
    if (nav && (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'j')) { e.preventDefault(); step(1); }
    else if (nav && (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'k')) { e.preventDefault(); step(-1); }
    else if (e.key === '?' || k === '/') help.classList.toggle('on');
    else if (e.key === 'h' || e.key === 'H') setHide(!ui.hide);
    else if (e.key === ' ' && nav && (ui.hide || ui.view === 'checks')) { e.preventDefault(); reveal(); }
    else if (e.key === '[') toggleSide('left');
    else if (e.key === ']') toggleSide('right');
  });

  // ---------- "Save a copy": one file that works on its own ----------
  // The deck builds its copy and downloads it; the shell catches that download, has the server embed the
  // pictures and scripts the file points to, and saves it under the deck's name instead of "workshop.html".
  const fileName = () => (SB.name || 'deck').replace(/[\\/:*?"<>|]+/g, '-').trim() + ' (editable).html';
  const saveDl = (blob, name) => { const u = URL.createObjectURL(blob), a = document.createElement('a'); a.href = u; a.download = name; document.body.appendChild(a); anchorClick.call(a); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 4000); };
  const anchorClick = HTMLAnchorElement.prototype.click;
  let grab = null;
  document.addEventListener('click', (e) => {
    if (!e.target.closest || !e.target.closest('#save-copy')) return;
    const mk = URL.createObjectURL;
    grab = { blob: null, restore: () => { URL.createObjectURL = mk; HTMLAnchorElement.prototype.click = anchorClick; } };
    URL.createObjectURL = function (b) { if (grab && !grab.blob && b instanceof Blob) { grab.blob = b; return 'about:blank#sb-copy'; } return mk.call(URL, b); };
    HTMLAnchorElement.prototype.click = function () { if (this.download && this.href.endsWith('#sb-copy')) return; return anchorClick.call(this); };
  }, true);
  document.addEventListener('click', async (e) => {
    if (!grab || !e.target.closest || !e.target.closest('#save-copy')) return;
    const g = grab; grab = null; g.restore();
    if (!g.blob) return;
    const flag = document.getElementById('save-flag'), say2 = (t) => { if (flag) { flag.textContent = t; flag.className = 'save-flag on'; } };
    say2('Saving a copy with its pictures…');
    let out = g.blob, pics = null;
    try {
      const r = await fetch(api('bundle'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ html: await g.blob.text() }) });
      if (r.ok) { out = new Blob([await r.text()], { type: 'text/html' }); pics = +r.headers.get('X-SB-Pictures'); }
    } catch (err) {}
    saveDl(out, fileName());
    say2(pics === null ? `✓ Saved ${fileName()}. Its pictures stay next to the deck, so send the folder with it.` : `✓ Saved ${fileName()}: one file, with its ${pics} picture${pics === 1 ? '' : 's'} inside. It opens anywhere.`);
  });

  // ---------- live updates ----------
  let base = SB.pulse ? Object.assign({}, SB.pulse) : null, pending = false;
  const idle = () => { const a = document.activeElement; const typing = a && (a.isContentEditable || /^(INPUT|TEXTAREA)$/.test(a.tagName)); return !typing && Date.now() - lastKey > 8000; };
  function reload() { try { SB.flush(); } catch (e) {} setTimeout(() => location.reload(), 450); }
  async function pulse() {
    if (document.hidden) return;   // a tab in the background checks again when you come back to it
    let p; try { p = await (await fetch(api('pulse'), { cache: 'no-store' })).json(); } catch (e) { return; }
    askButton(p); updateNote(p.update);
    if (!base) { base = p; return; }
    if (p.review !== base.review) { base.review = p.review; loadReview(); }
    if (p.file !== base.file || p.shell !== base.shell) { pending = true; banner.firstChild.textContent = 'Claude updated this deck.'; }
    const other = p.saved && p.saved.by && p.saved.by !== SB.tab && !(base.saved && base.saved.at === p.saved.at);
    base.saved = p.saved;
    if (other && !SB.readonly && !pending) { pending = true; banner.firstChild.textContent = p.saved.by === 'sb-import' ? 'Claude brought in a reviewer’s comments and edits.' : 'You saved changes in another tab.'; }   // reload to see them; nothing here is lost
    if (pending) { if (idle()) reload(); else banner.classList.add('on'); }
  }
  setInterval(pulse, 2500);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pulse(); });

  // ---------- agent-friendly handle (Claude can drive the page with this) ----------
  window.SlideBuilder = {
    go, step, setView, say, shareItem, current: () => cur, decide, undo: undoDecision, flip, proposals: () => Object.keys(lib()).filter(origOf).map((p) => ({ p, o: origOf(p), option: optionsOf(origOf(p)).indexOf(p) + 1, of: optionsOf(origOf(p)).length, decision: (decisionOf(p) || {}).d || null })), filter: (f) => { filter = f; refresh(); }, order: (ids) => saveOrder(ids), title, hidden: (id) => clientOnly.has(id),
    slides: () => wraps().map((w, k) => Object.assign({ n: k + 1, id: w.dataset.id, title: title(w.dataset.id) }, (({ text, st, changed, hold }) => ({ comment: text, reply: st, changed, draft: hold }))(info(w.dataset.id)))),
  };

  // ---------- start ----------
  const wantV = decodeURIComponent((location.hash.match(/[#&]v=([^&]+)/) || [])[1] || '');
  if (wantV && sideSelect && !(SB.hideVersions || []).includes(wantV) && [...sideSelect.options].some((o) => o.value === wantV) && sideSelect.value !== wantV) { sideSelect.value = wantV; sideSelect.dispatchEvent(new Event('change', { bubbles: true })); }
  const want = decodeURIComponent((location.hash.match(/[#&]s=([^&]+)/) || [])[1] || '');
  cur = want && wrapOf(want) ? want : null;
  setHide(!!ui.hide);
  watch();
  loadReview().then(() => { setView(['scroll', 'sorter', 'checks'].includes(ui.view) ? ui.view : 'focus'); requestAnimationFrame(() => document.body.classList.add('sb-ready')); });
})();
