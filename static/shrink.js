/* Decks: Shrink file size (Share menu).
   Lists what makes the deck heavy (the server's /api/decks/<slug>/shrink looks): photos saved as PNG,
   pictures larger than a slide ever shows them, pictures written into the deck file, and, for a tidy
   folder, pictures no slide uses and older PDF exports. Tick what to shrink, then Shrink all. Nothing is
   deleted: the originals go to .slidebuilder/originals/, and Undo puts them back. */
(function () {
  const SB = window.__SB, API = window.SlideBuilder;
  if (!SB || SB.readonly || !API || !(API.menuItem || API.shareItem)) return;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const api = () => '/api/decks/' + SB.slug + '/shrink';
  const size = (n) => n >= 950000 ? (n / 1e6).toFixed(1) + ' MB' : Math.max(n ? 1 : 0, Math.round(n / 1000)) + ' KB';
  const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;
  const KEPT = '__sb_shrink_done';

  const card = document.createElement('div'); card.id = 'sb-shrinkp'; card.setAttribute('role', 'dialog'); card.setAttribute('aria-label', 'Shrink file size');
  document.body.appendChild(card);
  const css = new CSSStyleSheet();
  css.replaceSync(`
#sb-shrinkp { display: none; position: fixed; z-index: 1002; top: calc(var(--sb-top, 52px) + 8px); right: 14px; width: 460px; max-height: calc(100vh - var(--sb-top, 52px) - 30px); overflow-y: auto; box-sizing: border-box; background: #fff; border: 1px solid var(--sb-line); border-radius: 12px; box-shadow: 0 12px 34px rgba(35,31,32,.16); padding: 14px 16px 0; font: 13px/1.5 'DM Sans', sans-serif; color: var(--sb-ink); }
#sb-shrinkp.on { display: block; }
#sb-shrinkp h4 { margin: 0 0 6px; font-size: 14px; }
#sb-shrinkp .sb-help-x { position: sticky; top: 0; float: right; margin: -6px -6px 0 8px; border: 0; background: #fff; font-size: 20px; line-height: 1; color: var(--sb-mute); cursor: pointer; padding: 2px 6px; border-radius: 6px; }
#sb-shrinkp .sb-help-x:hover { background: var(--sb-paper); color: var(--sb-ink); }
#sb-shrinkp p { margin: 0 0 10px; color: var(--sb-mute); font-size: 12.5px; }
#sb-shrinkp p b { color: var(--sb-ink); }
.sbk-sec { display: flex; justify-content: space-between; gap: 10px; margin: 12px 0 2px; padding-bottom: 4px; border-bottom: 1px solid #EEEAE7; font-weight: 700; font-size: 12.5px; }
.sbk-sec span:last-child { font-weight: 400; color: var(--sb-faint); }
.sbk-row { display: grid; grid-template-columns: 18px 40px minmax(0, 1fr) auto; gap: 4px 10px; align-items: start; padding: 8px 0; border-bottom: 1px solid #F3F0EE; cursor: pointer; }
.sbk-row.nopic { grid-template-columns: 18px minmax(0, 1fr) auto; }
.sbk-row input { margin: 3px 0 0; accent-color: var(--sb-red); cursor: pointer; }
.sbk-row img { width: 40px; height: 40px; object-fit: contain; border-radius: 5px; background: repeating-conic-gradient(#EEEBE8 0 25%, #F8F6F4 0 50%) 0 0 / 10px 10px; }
.sbk-t { min-width: 0; }
.sbk-t b { display: block; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sbk-t span { display: block; color: var(--sb-mute); font-size: 12px; margin-top: 1px; }
.sbk-n { text-align: right; white-space: nowrap; font-size: 12px; color: var(--sb-mute); padding-top: 1px; }
.sbk-n b { color: var(--sb-ink); font-weight: 700; }
.sbk-row:not(:has(input:checked)) :is(.sbk-t, .sbk-n, img) { opacity: .45; }
.sbk-more { border: 0; background: none; padding: 0; font: inherit; font-size: 12px; color: var(--sb-red); cursor: pointer; }
.sbk-list { margin: 0 0 4px 28px; padding: 0; list-style: none; font-size: 12px; color: var(--sb-mute); }
.sbk-list label { display: flex; gap: 8px; align-items: center; padding: 2px 0; cursor: pointer; }
.sbk-list label span:first-of-type { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sbk-list input { margin: 0; accent-color: var(--sb-red); }
.sbk-foot { position: sticky; bottom: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin: 10px -16px 0; padding: 12px 16px 14px; background: #fff; border-top: 1px solid #EEEAE7; }
.sbk-foot span { flex: 1 1 200px; font-size: 11.5px; color: var(--sb-faint); line-height: 1.4; }
.sbk-foot .sb-btn { font-weight: 700; }
.sbk-foot .sb-btn:disabled { opacity: .5; cursor: default; }
.sbk-done { background: #F2F8F2; border: 1px solid #CFE3CF; border-radius: 9px; padding: 9px 11px; margin: 4px 0 10px; font-size: 12.5px; }
.sbk-done b { display: block; }
.sbk-note { color: var(--sb-faint); font-size: 12px; padding: 10px 0 14px; }
@media print { #sb-shrinkp { display: none !important; } }`);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, css];

  let data = null, busy = false;
  const ticked = () => [...card.querySelectorAll('input[data-id]:checked')].map((i) => i.dataset.id);
  const byId = () => Object.fromEntries((data ? data.items : []).map((it) => [it.id, it]));

  function row(it, pic) {
    const name = it.kind === 'inline' ? 'A picture inside ' + it.file : it.kind === 'pdf' ? it.file : it.file.replace(/^img\//, '');
    const n = it.inDeck ? `${size(it.size)} → <b>${size(it.after)}</b>` : `<b>${size(it.size)}</b>`;
    const where = it.kind !== 'pdf' || !it.to ? '' : it.to === '_archive/' + it.file ? ' Moves to _archive/.' : ` Moves to ${it.to} (_archive/ has another file by this name).`;
    return `<label class="sbk-row${pic ? '' : ' nopic'}"><input type="checkbox" data-id="${esc(it.id)}" checked>${pic ? `<img src="${esc(it.kind === 'inline' ? it.to : it.file)}" alt="" loading="lazy">` : ''}
      <span class="sbk-t"><b title="${esc(it.file)}">${esc(name)}</b><span>${esc(it.why + where)}</span></span><span class="sbk-n">${n}</span></label>`;
  }
  function render() {
    if (!data) { card.innerHTML = `<button class="sb-help-x" data-x aria-label="Close" title="Close (Esc)">×</button><h4>Shrink file size</h4><p class="sbk-note">Looking at the deck’s pictures…</p>`; return; }
    const its = data.items, pics = its.filter((it) => it.inDeck), unused = its.filter((it) => it.kind === 'unused'), pdfs = its.filter((it) => it.kind === 'pdf');
    const saves = pics.reduce((a, it) => a + it.size - it.after, 0);
    const last = data.last, done = data.done;
    let h = `<button class="sb-help-x" data-x aria-label="Close" title="Close (Esc)">×</button><h4>Shrink file size</h4>`;
    if (done) h += `<div class="sbk-done"><b>${esc(done.summary || 'Done.')}</b>The originals are in .slidebuilder/originals/${esc(done.batch)}/${done.commit ? `, and the change is commit ${esc(done.commit)}` : ''}.</div>`;
    if (!its.length) {
      h += `<p>${done ? 'Nothing else to shrink.' : `Nothing to shrink: the ${plural(data.pictures, 'picture')} on these slides weigh ${size(data.weight)}, and each is about as small as it can be while it looks the same.`}</p>`;
    } else {
      h += !data.pillow ? `<p>The pictures on these slides weigh <b>${size(data.weight)}</b>. Making them smaller needs Pillow, which the server’s Python doesn’t have: <b>python3 -m pip install Pillow</b>, then restart the server. Folder tidying works without it.</p>`
        : pics.length ? `<p>The pictures on these slides weigh <b>${size(data.weight)}</b>. Shrunk, <b>${size(data.weight - saves)}</b>: the deck opens faster, and every copy you send is ${size(saves)} lighter. They look the same.</p>`
        : `<p>The pictures on these slides are about as small as they can be (${size(data.weight)} in all). The rest is folder tidying.</p>`;
      if (pics.length) h += `<div class="sbk-sec"><span>On the slides</span><span data-sum="deck"></span></div>` + pics.map((it) => row(it, true)).join('');
      if (unused.length || pdfs.length) {
        h += `<div class="sbk-sec"><span>Tidy the folder</span><span>not in the deck or the copies you send</span></div>`;
        if (unused.length) {
          const tot = unused.reduce((a, it) => a + it.size, 0);
          h += `<label class="sbk-row nopic"><input type="checkbox" data-group="unused" checked><span class="sbk-t"><b>${plural(unused.length, 'picture')} no slide uses</b><span>Moved out of img/, into .slidebuilder/originals/. <button class="sbk-more" data-more>Show them</button></span></span><span class="sbk-n"><b>${size(tot)}</b></span></label>
            <ul class="sbk-list" hidden>${unused.map((it) => `<li><label><input type="checkbox" data-id="${esc(it.id)}" data-in="unused" checked><span title="${esc(it.file)}">${esc(it.file.replace(/^img\//, ''))}</span><span>${size(it.size)}</span></label></li>`).join('')}</ul>`;
        }
        h += pdfs.map((it) => row(it, false)).join('');
      }
    }
    h += `<div class="sbk-foot">${its.length ? `<button class="sb-btn red" data-go></button>` : ''}${last ? `<button class="sb-btn" data-undo title="Put back the originals from ${esc(last.batch)}">Undo the last shrink</button>` : ''}<span>Nothing is deleted. The originals are kept, and Undo puts them back.</span></div>`;
    card.innerHTML = h;
    sums();
  }
  function sums() {
    const on = new Set(ticked()), its = data ? data.items : [], all = its.length && its.every((it) => on.has(it.id));
    const saves = its.filter((it) => it.inDeck && on.has(it.id)).reduce((a, it) => a + it.size - it.after, 0);
    const deckSum = card.querySelector('[data-sum="deck"]'); if (deckSum) deckSum.textContent = 'saves ' + size(saves);
    const g = card.querySelector('[data-group="unused"]');
    if (g) { const u = [...card.querySelectorAll('[data-in="unused"]')]; g.checked = u.some((i) => i.checked); g.indeterminate = g.checked && !u.every((i) => i.checked); }
    const go = card.querySelector('[data-go]'); if (!go) return;
    go.disabled = busy || !on.size;
    go.textContent = busy ? 'Shrinking…' : !on.size ? 'Nothing ticked' : (all ? 'Shrink all' : `Shrink ${plural(on.size, 'ticked item')}`) + (saves ? ` · saves ${size(saves)}` : '');
  }

  async function load() {
    data = null; render();
    try { const r = await fetch(api(), { cache: 'no-store' }); if (!r.ok) throw new Error((await r.json()).error || r.status); data = await r.json(); }
    catch (e) { card.innerHTML = `<button class="sb-help-x" data-x aria-label="Close">×</button><h4>Shrink file size</h4><p class="sbk-note">Couldn’t look at the deck (${esc(e.message)}).</p>`; return; }
    render();
  }
  async function post(body, working) {
    busy = true; sums(); API.say(working);
    try { await SB.flush(); } catch (e) {}   // your latest edits reach the server first, so their pictures follow a rename
    let r = null, d = null;
    try { r = await fetch(api(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); d = await r.json(); } catch (e) {}
    busy = false;
    if (!r || !r.ok) { API.say(`Couldn’t do that${d && d.error ? `: ${esc(d.error)}` : ''}.`); sums(); return null; }
    return d;
  }
  async function shrinkNow() {
    const ids = ticked(); if (!ids.length) return;
    const d = await post({ op: 'apply', ids }, '<b>Shrinking…</b> A few seconds for the pictures.');
    if (!d) return;
    // the deck file names the new pictures: reload to pick them up, and show what happened when it's back
    try { sessionStorage.setItem(KEPT, JSON.stringify({ summary: d.summary, batch: d.batch, commit: d.commit })); } catch (e) {}
    location.reload();
  }
  async function undoNow() {
    const d = await post({ op: 'undo' }, '<b>Putting the originals back…</b>');
    if (!d) return;
    try { sessionStorage.setItem(KEPT, JSON.stringify({ summary: `Undone: ${plural(d.back.length, 'file')} back as they were.` + (d.problems.length ? ` ${d.problems.length} couldn’t be: ${d.problems.join('; ')}.` : ''), batch: d.batch, commit: d.commit })); } catch (e) {}
    location.reload();
  }
  function open() {
    document.querySelectorAll('#sb-rounds.on, #sb-help.on').forEach((n) => n.classList.remove('on'));
    card.classList.add('on'); card.scrollTop = 0; load();
  }

  card.addEventListener('click', (e) => {
    if (e.target.closest('[data-x]')) card.classList.remove('on');
    else if (e.target.closest('[data-more]')) { e.preventDefault(); const l = card.querySelector('.sbk-list'); l.hidden = !l.hidden; e.target.textContent = l.hidden ? 'Show them' : 'Hide the list'; }
    else if (e.target.closest('[data-go]')) shrinkNow();
    else if (e.target.closest('[data-undo]')) undoNow();
  });
  card.addEventListener('change', (e) => {
    if (e.target.dataset.group === 'unused') card.querySelectorAll('[data-in="unused"]').forEach((i) => { i.checked = e.target.checked; });
    sums();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && card.classList.contains('on')) { e.stopPropagation(); card.classList.remove('on'); } }, true);
  document.addEventListener('pointerdown', (e) => { if (card.classList.contains('on') && !card.contains(e.target) && !e.target.closest('#sb-share')) card.classList.remove('on'); }, true);

  const o = { t: 'Shrink file size', sub: 'Smaller pictures, lighter copies to send', id: 'sb-shrink-it', act: open };
  if (API.menuItem) { API.menuSep('sb-share'); API.menuItem('sb-share', o); } else API.shareItem(o);

  // back from a shrink or an undo: say what happened
  let kept = null; try { kept = JSON.parse(sessionStorage.getItem(KEPT) || 'null'); sessionStorage.removeItem(KEPT); } catch (e) {}
  if (kept) { card.classList.add('on'); load().then(() => { if (data) { data.done = kept; render(); } }); }
})();
