/* Decks: guides (Checks › Guides, key B).
   Basic principles for a professional-looking slide, drawn on the slide in Checks › Guides:
   - the protected border: a band around the edge kept for the logo, the source line,
     and the page number. Text and figures stay inside it.
   - titles take two lines at most (title, section, and closing slides are exempt,
     since their type is meant to be big).
   - no text smaller than MIN_TEXT slide pixels (about 11 pt in PowerPoint).
   - a few text sizes per slide, not many.
   These are guidelines, not rules: they flag, they never block. The same check runs
   headlessly in `sb audit` (window.SBGuides), so it also works on a plain deck. */
(function () {
  // the band, in slide pixels (slides are 1000 x 562.5)
  const BAND = { t: 28, r: 44, b: 40, l: 44 };
  const W = 1000, H = 562.5, SLACK = 3, MIN_TEXT = 12, MAX_SIZES = 4;
  const NO_BORDER = new Set(['title', 'closing', 'image', 'photo', 'photowords', 'photofull', 'section']);
  const NO_TITLE = new Set(['title', 'closing', 'section', 'statement', 'reflect', 'lines', 'image', 'photo', 'pptx', 'team', 'shout']);
  const SKIP = '.ctrls, .slide-tag, .sb-badge, .sbg-ov, .logo, .logo-plate, .src, .num, .slide-no, [aria-hidden="true"]';   // aria-hidden: decorative, not read

  const layoutOf = (slide) => ((slide.className.match(/\bl-([a-z0-9-]+)/) || [])[1] || '');

  // a slide's title, wherever its layout puts it: the deck's own title element (even nested in a
  // column or panel), PowerPoint's title on a slide rebuilt from PowerPoint, then a heading (h1, h2).
  // Decks built by an agent nest titles in custom layouts, so "the first child with class h-title" is
  // not enough. No guessing from font size: a quote or a reflection question is not a title.
  function titleOf(slide) {
    if (!slide) return null;
    const live = slide.getBoundingClientRect().width > 0;   // a slide off screen (another view, another slide) has no layout: go by markup
    const shown = (el) => { if (!el.textContent.trim() || getComputedStyle(el).display === 'none') return false; if (!live) return true; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const direct = slide.querySelector(':scope > .h-title'); if (direct && shown(direct)) return direct;
    const named = [...slide.querySelectorAll('.h-title, [data-title]')].find((e) => !e.closest(SKIP) && shown(e)); if (named) return named;
    const pp = pptxTitle(slide); if (pp && shown(pp)) return pp;
    const size = (e) => parseFloat(getComputedStyle(e).fontSize) || 0;
    const heads = [...slide.querySelectorAll('h1, h2')].filter((e) => !e.closest(SKIP) && shown(e));
    if (heads.length) return heads.sort((a, b) => size(b) - size(a))[0];
    return null;   // no title element and no heading: a quote, a question, a picture. Those show whole.
  }

  // A slide rebuilt from PowerPoint (layout pptx, like the consulting template) is boxes of text with no
  // title element. PowerPoint's own data says where its title placeholder sits: on the slide's shapes, or,
  // where the template strips that mark (so the engine doesn't enlarge the title), in the PowerPoint
  // slides the deck was built from (CT, ct-slides.js). Take the box drawn at that spot. A title in one run
  // of text returns that run, so Checks can edit it in place without touching its font; a title in mixed
  // formatting returns the whole box, found but edited on the slide.
  function pptxTitle(slide) {
    if (layoutOf(slide) !== 'pptx') return null;
    const isTitle = (sh) => sh && sh.k === 'box' && sh.ph === 'title';
    let spots = [];
    /* eslint-disable no-undef */
    try { const b = LIBRARY[slide.dataset.id]; spots = ((b && b.pp && b.pp.shapes) || []).filter(isTitle); } catch (e) { /* no deck data */ }
    if (!spots.length) try { spots = Object.values(CT).flatMap((c) => ((c && c.shapes) || []).filter(isTitle)); } catch (e) { /* no PowerPoint data */ }
    /* eslint-enable no-undef */
    let box = null, gap = 24;   // a nudge moves a box a few pixels at most
    slide.querySelectorAll(':scope > .pp-t').forEach((d) => {
      const x = parseFloat(d.style.left), y = parseFloat(d.style.top);
      spots.forEach((sh) => { const g = Math.abs(x - sh.x) + Math.abs(y - sh.y); if (g < gap) { gap = g; box = d; } });
    });
    if (!box) return null;
    const paras = [...box.children].filter((p) => p.textContent.trim());
    if (paras.length !== 1) return box;
    const p = paras[0], runs = [...p.children];
    if (!runs.length) return p;
    const bare = [...p.childNodes].some((n) => n.nodeType === 3 && n.nodeValue.trim());
    return runs.length === 1 && !bare ? runs[0] : box;
  }

  // what a slide breaks, in slide pixels
  function check(slide) {
    const out = [], layout = layoutOf(slide);
    const R = slide.getBoundingClientRect(); if (!R.width) return out;
    const k = R.width / W, toSlide = (r) => ({ x: (r.left - R.left) / k, y: (r.top - R.top) / k, w: r.width / k, h: r.height / k });

    // a converted slide's source line: it belongs in the footer band, and footnote size is fine for it
    const footnote = (n) => layout === 'pptx' && /^\s*(sources?|note|notes)\b/i.test((n.parentElement.closest('.pp') || n.parentElement).textContent);
    const t = titleOf(slide);
    if (t && !NO_TITLE.has(layout) && t.textContent.trim()) {
      const cs = getComputedStyle(t), lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
      const lines = Math.round(t.offsetHeight / lh);
      const r = toSlide(t.getBoundingClientRect());
      out.push({ kind: 'zone', x: r.x, y: r.y, w: r.w, h: lh * 2 });
      if (lines > 2) out.push({ kind: 'title', lines, x: r.x, y: r.y, w: r.w, h: r.h, msg: `Title runs to ${lines} lines. Two max.`, short: `${lines}-line title` });
    }

    if (!NO_BORDER.has(layout)) {
      const safe = { x0: BAND.l, y0: BAND.t, x1: W - BAND.r, y1: H - BAND.b };
      const hits = [];
      const consider = (r, what) => {
        if (!r || r.w < 1 || r.h < 1) return;
        if (r.w > W * .9 || r.h > H * .9) return;   // a full-bleed background, not content
        const over = Math.max(safe.x0 - r.x, r.x + r.w - safe.x1, safe.y0 - r.y, r.y + r.h - safe.y1);
        if (over > SLACK) hits.push(Object.assign(r, { over, what }));
      };
      // text: measure the words themselves, not the box they sit in
      const walker = document.createTreeWalker(slide, NodeFilter.SHOW_TEXT, { acceptNode: (n) => n.nodeValue.trim() && !n.parentElement.closest(SKIP) && !n.parentElement.closest('svg') && !footnote(n) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT });
      const rng = document.createRange();
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const cs = getComputedStyle(n.parentElement); if (cs.visibility === 'hidden' || cs.display === 'none') continue;
        rng.selectNodeContents(n); const rr = rng.getBoundingClientRect(); if (!rr.width) continue;
        consider(toSlide(rr), 'Text');
      }
      // figures: the drawing inside an svg, pictures
      slide.querySelectorAll('svg').forEach((svg) => {
        if (svg.parentElement.closest('svg') || svg.closest(SKIP)) return;
        try {
          const bb = svg.getBBox(), m = svg.getScreenCTM(); if (!m || !bb.width) return;
          const p1 = new DOMPoint(bb.x, bb.y).matrixTransform(m), p2 = new DOMPoint(bb.x + bb.width, bb.y + bb.height).matrixTransform(m);
          consider(toSlide({ left: Math.min(p1.x, p2.x), top: Math.min(p1.y, p2.y), width: Math.abs(p2.x - p1.x), height: Math.abs(p2.y - p1.y) }), 'Figure');
        } catch (e) {}
      });
      slide.querySelectorAll('img').forEach((im) => { if (!im.closest(SKIP)) consider(toSlide(im.getBoundingClientRect()), 'Picture'); });
      // one flag per kind of thing, around everything of that kind that crosses
      ['Text', 'Figure', 'Picture'].forEach((what) => {
        const hs = hits.filter((h) => h.what === what); if (!hs.length) return;
        const x = Math.min(...hs.map((h) => h.x)), y = Math.min(...hs.map((h) => h.y));
        const x2 = Math.max(...hs.map((h) => h.x + h.w)), y2 = Math.max(...hs.map((h) => h.y + h.h));
        const over = Math.round(Math.max(...hs.map((h) => h.over)));
        const side = y2 > safe.y1 + SLACK ? 'the footer' : y < safe.y0 - SLACK ? 'the top edge' : 'the side edge';
        out.push({ kind: 'border', what, x, y, w: x2 - x, h: y2 - y, over, msg: `${what} crosses into ${side} by ${over} px.`, short: `${what} in ${side.replace('the top edge', 'the top margin').replace('the side edge', 'the side margin')}` });
      });
    }
    // text size: nothing too small, and only a few sizes (titles, footers, and the logo don't count)
    if (!['image', 'photo'].includes(layout)) {
      const sizes = [], small = [];
      const rng = document.createRange();
      const tw = document.createTreeWalker(slide, NodeFilter.SHOW_TEXT, { acceptNode: (n) => n.nodeValue.trim() && !n.parentElement.closest(SKIP + ', .h-title') && !footnote(n) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT });
      for (let n = tw.nextNode(); n; n = tw.nextNode()) {
        const el = n.parentElement, cs = getComputedStyle(el); if (cs.visibility === 'hidden' || cs.display === 'none') continue;
        let fs = parseFloat(cs.fontSize) || 0;
        const svgText = el.closest('text, tspan');
        if (svgText) { try { const m = svgText.getScreenCTM(); fs = fs * Math.hypot(m.a, m.b) / k; } catch (e) {} }
        if (!fs) continue;
        rng.selectNodeContents(n); const rr = rng.getBoundingClientRect(); if (!rr.width) continue;
        sizes.push(fs);
        if (fs < MIN_TEXT - .25) small.push(Object.assign(toSlide(rr), { fs }));
      }
      if (small.length) {
        const x = Math.min(...small.map((h) => h.x)), y = Math.min(...small.map((h) => h.y)), x2 = Math.max(...small.map((h) => h.x + h.w)), y2 = Math.max(...small.map((h) => h.y + h.h));
        const least = Math.round(Math.min(...small.map((h) => h.fs)) * 10) / 10;
        out.push({ kind: 'small', x, y, w: x2 - x, h: y2 - y, msg: `Text as small as ${least} px. Keep it at ${MIN_TEXT} or more so it reads when projected.`, short: `Text at ${least} px` });
      }
      const groups = []; [...sizes].sort((a, b) => a - b).forEach((v) => { if (!groups.length || v - groups[groups.length - 1] > 1.5) groups.push(v); });
      if (groups.length > MAX_SIZES) out.push({ kind: 'sizes', count: groups.length, x: W - 330, y: 8, w: 0, h: 0, msg: `${groups.length} text sizes. Three or four is usually enough.`, short: `${groups.length} text sizes` });
    }
    return out;
  }
  const issues = (slide) => check(slide).filter((f) => f.kind !== 'zone');
  // every slide in the deck, shown or not: each is measured as an unscaled copy off screen
  function scan(wraps) {
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;left:-30000px;top:0;width:1000px;pointer-events:none;';
    document.body.appendChild(host);
    const out = wraps.map((w, i) => {
      const s = w.querySelector('.slide'); if (!s) return { id: w.dataset.id, n: i + 1, issues: [] };
      const c = s.cloneNode(true); c.style.transform = 'none'; c.classList.remove('sb-cover'); c.classList.add('sb-reveal');
      c.querySelectorAll('.sb-count, .sbg-ov').forEach((x) => x.remove());
      host.appendChild(c); const iss = issues(c); c.remove();
      return { id: w.dataset.id, n: i + 1, issues: iss };
    });
    host.remove(); return out;
  }
  window.SBGuides = { check, issues, scan, titleOf, BAND, MIN_TEXT, MAX_SIZES };

  // ---------- the overlay (only inside Decks) ----------
  const deck = document.getElementById('deck');
  if (!window.__SB || !deck) return;
  const css = new CSSStyleSheet();
  css.replaceSync(`
    .sbg-ov { position: absolute; inset: 0; pointer-events: none; z-index: 30; font: 600 11px/1.3 'DM Sans', -apple-system, sans-serif; }
    .sbg-band { position: absolute; background: repeating-linear-gradient(45deg, rgba(239,159,39,.30) 0 2px, rgba(250,238,218,.40) 2px 8px); }
    .sbg-safe { position: absolute; border: 1px dashed #BA7517; }
    .sbg-zone { position: absolute; border: 1.5px dashed #A22731; border-radius: 2px; }
    .sbg-zone i { position: absolute; right: 0; top: -15px; font-style: normal; color: #A22731; font-weight: 600; }
    .sbg-hit { position: absolute; border: 2px dashed #E24B4A; border-radius: 3px; background: rgba(226,75,74,.06); }
    .sbg-lab { position: absolute; background: #A32D2D; color: #fff; padding: 2px 7px; border-radius: 4px; white-space: nowrap; max-width: 60%; overflow: hidden; text-overflow: ellipsis; }
    @media print { .sbg-ov { display: none !important; } }`);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, css];

  const isOn = () => document.body.classList.contains('sb-gcheck');   // Checks › Guides
  const frames = () => [...deck.querySelectorAll(':scope > [data-id]')].map((w) => { const sl = w.querySelector('.slide'); return sl && sl.parentElement !== w ? sl.parentElement : null; }).filter(Boolean);
  function clear() { document.querySelectorAll('.sbg-ov').forEach((n) => n.remove()); }
  function draw() {
    if (!isOn()) { clear(); return; }
    // read everything first, then write, so the page lays out once
    const plans = frames().map((f) => { const s = f.querySelector('.slide'); return f.clientWidth && s ? { f, k: f.clientWidth / W, flags: check(s) } : { f }; });
    let total = 0;
    plans.forEach(({ f, k, flags }) => {
      let ov = f.querySelector(':scope > .sbg-ov');
      if (!flags) { if (ov) ov.remove(); return; }
      if (!ov) { ov = document.createElement('div'); ov.className = 'sbg-ov'; f.appendChild(ov); }
      const px = (v) => (v * k).toFixed(1) + 'px';
      const box = (cls, x, y, w, h, html) => `<div class="${cls}" style="left:${px(x)};top:${px(y)};width:${px(w)};height:${px(h)}">${html || ''}</div>`;
      let o = box('sbg-band', 0, 0, W, BAND.t) + box('sbg-band', 0, H - BAND.b, W, BAND.b) + box('sbg-band', 0, BAND.t, BAND.l, H - BAND.t - BAND.b) + box('sbg-band', W - BAND.r, BAND.t, BAND.r, H - BAND.t - BAND.b)
        + box('sbg-safe', BAND.l, BAND.t, W - BAND.l - BAND.r, H - BAND.t - BAND.b);
      flags.forEach((g) => {
        if (g.kind === 'zone') { o += box('sbg-zone', g.x - 3, g.y - 2, g.w + 6, g.h + 4, '<i>2 lines</i>'); return; }
        total++;
        if (g.kind !== 'sizes') o += box('sbg-hit', g.x - 3, g.y - 2, g.w + 6, g.h + 4);
        const ly = g.kind === 'title' ? g.y + g.h + 6 : g.kind === 'sizes' ? g.y : Math.max(4, g.y - 20);
        o += `<div class="sbg-lab" style="left:${px(Math.max(4, g.x))};top:${px(Math.min(ly, H - 22))}">${g.msg}</div>`;
      });
      ov.innerHTML = o;
    });
  }
  let timer = null;
  const later = (ms = 120) => { clearTimeout(timer); timer = setTimeout(() => requestAnimationFrame(draw), ms); };
  // redraw when the slides move, change size, or change text
  new MutationObserver(() => later()).observe(deck, { childList: true, subtree: false, attributes: true, attributeFilter: ['class', 'style'] });
  new ResizeObserver(() => later()).observe(deck);
  deck.addEventListener('input', () => later(400));
  window.addEventListener('resize', () => later());
  // moving between slides of the same size changes nothing the observers see: redraw on the shell's signal, and again once the slide has settled
  window.addEventListener('sb:slide', () => { later(40); setTimeout(() => requestAnimationFrame(draw), 450); });
  new MutationObserver(() => later(60)).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  if (document.fonts) document.fonts.ready.then(() => later(300));
  later(400);
})();
