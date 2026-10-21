// The headless jobs (tools/browser.mjs runs them, in its shared Chrome or a Chrome of their own).
// Each job opens its pages in a browser context of its own and closes it at the end, so nothing one
// job loads or saves (storage, cookies, cache) is there for the next.
import { chromium } from 'playwright-core';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { format } from 'util';

export function chrome() {
  const env = process.env.SB_CHROME;
  if (env) { if (fs.existsSync(env)) return env; throw new Error(`SB_CHROME is set to ${env}, which does not exist`); }
  // where Playwright keeps its browsers, newest first
  const home = os.homedir();
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, path.join(home, 'Library/Caches/ms-playwright'), path.join(home, '.cache/ms-playwright'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'ms-playwright')].filter((r) => r && r !== '0' && fs.existsSync(r));
  const inside = ['chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-win64/chrome.exe', 'chrome-win/chrome.exe'];
  for (const root of roots) {
    const dirs = fs.readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => +b.split('-')[1] - +a.split('-')[1]);
    for (const d of dirs) for (const rel of inside) { const exe = path.join(root, d, rel); if (fs.existsSync(exe)) return exe; }
  }
  try { const exe = chromium.executablePath(); if (exe && fs.existsSync(exe)) return exe; } catch (e) { /* not installed */ }
  const system = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'];
  for (const exe of system) if (fs.existsSync(exe)) return exe;
  throw new Error('No Chrome found. Run ./setup.sh (it installs Chrome for Testing), or set SB_CHROME to a Chrome or Chromium executable.');
}

export const launch = () => chromium.launch({ executablePath: chrome(), headless: true });

// Before the page's own scripts: count the frames the page asks for, so settled() can tell when a
// chart that draws itself frame by frame has stopped.
const countFrames = () => {
  const raf = window.requestAnimationFrame, asks = { n: 0 };
  window.requestAnimationFrame = function (cb) { asks.n++; return raf.call(window, cb); };
  Object.defineProperty(window, '__sbFrames', { value: { asks, next: () => new Promise((r) => raf.call(window, () => r())) } });
};

// In the page: resolves once it has finished drawing. The Decks shell has set sb-ready (it runs on
// ?readonly=1 pages; a ?raw=1 page has none), the deck's own window.__DECK_READY promise has settled
// if it has one (for a chart drawn later), fonts are in, every picture has loaded, the slides' CSS
// animations have finished, and the page has stopped asking for frames (2 s a page at most). Pictures
// aren't decode()d: that makes Chrome scale them down from the full decode, sharper than a browser
// shows the deck.
const settled = async () => {
  const F = window.__sbFrames, frame = F ? F.next : () => new Promise((r) => requestAnimationFrame(() => r()));
  while (window.__SB && !document.body.classList.contains('sb-ready')) await frame();
  if (window.__DECK_READY) await Promise.resolve(window.__DECK_READY).catch(() => {});
  await document.fonts.ready;
  await frame();   // layout has run, so a lazy picture in view has started loading
  const inView = (im) => { const r = im.getBoundingClientRect(); return r.width && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth; };
  const loaded = (im) => im.complete || new Promise((r) => { im.addEventListener('load', r, { once: true }); im.addEventListener('error', r, { once: true }); });
  await Promise.all([...document.images].filter((im) => im.loading !== 'lazy' || inView(im)).map(loaded));
  const deck = document.getElementById('deck');
  await Promise.all(document.getAnimations().filter((a) => a.playState === 'running' && a.effect && a.effect.getComputedTiming().endTime < Infinity
    && (!deck || deck.contains(a.effect.target))).map((a) => a.finished.catch(() => {})));
  for (;;) {
    const n = F ? F.asks.n : 0, t = performance.now();
    await frame(); await frame();
    if (!F || F.asks.n === n) break;
    F.waited = (F.waited || 0) + performance.now() - t;
    if (F.waited > 2000) break;   // a looping animation never stops asking
  }
};

// Wait for the page to be ready instead of pausing a fixed time: nothing loading, then settled().
// Fonts and pictures can start more loads, so it goes round until a pass ends with nothing loading.
async function ready(page, loading) {
  const end = Date.now() + 30000;
  const late = () => new Error('The deck was still loading after 30 seconds');
  for (;;) {
    while (loading.size) { if (Date.now() > end) throw late(); await new Promise((r) => setTimeout(r, 10)); }
    let timer;
    try { await Promise.race([page.evaluate(settled), new Promise((_, no) => { timer = setTimeout(() => no(late()), Math.max(0, end - Date.now())); })]); }
    finally { clearTimeout(timer); }
    if (!loading.size) return;
  }
}

// One job: argv as browser.mjs got it, the server at base, Chrome from browser() (started on first use).
// Returns what it printed, an error if it stopped on one, and the exit code.
export async function run(argv, { base: BASE, browser }) {
  const args = [...argv];
  const cmd = args.shift();
  const vi = args.indexOf('--version'); let version = null;
  if (vi >= 0) { version = args[vi + 1]; args.splice(vi, 2); }
  const wi = args.indexOf('--with-edits'); const withEdits = wi >= 0; if (withEdits) args.splice(wi, 1);   // export what the browser shows, saved edits included
  const printed = [], contexts = [];
  const log = (...v) => printed.push(format(...v) + '\n');

  async function open(slug, width = 1600, withState = false) {
    const deck = await (await fetch(`${BASE}/api/decks/${slug}`)).json();
    if (deck.error) throw new Error(`no deck ${slug}`);
    const context = await (await browser()).newContext({ viewport: { width, height: 1000 } });
    contexts.push(context);
    await context.addInitScript(countFrames);
    const page = await context.newPage();
    const errors = [], loading = new Set();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => loading.add(r));
    page.on('requestfinished', (r) => loading.delete(r));
    page.on('requestfailed', (r) => loading.delete(r));
    const settle = () => ready(page, loading);
    await page.goto(`${BASE}${deck.url}?${withState ? 'readonly=1' : 'raw=1'}`, { waitUntil: 'load' });
    await settle();
    if (version) {
      const ok = await page.evaluate((v) => { const s = document.querySelector('.sidebar select'); if (!s || ![...s.options].some((o) => o.value === v)) return false; s.value = v; s.dispatchEvent(new Event('change', { bubbles: true })); return true; }, version);
      if (!ok) throw new Error(`no version ${version}`);
      await settle();
    }
    return { context, page, deck, errors, settle };
  }

  const order = (page) => page.evaluate(() => [...document.getElementById('deck').children].filter((n) => n.dataset && n.dataset.id).map((w, i) => {
    const id = w.dataset.id; let t = '';
    try { t = typeof titleOf === 'function' ? titleOf(id) : ''; } catch (e) {}           // eslint-disable-line no-undef
    if (!t) { try { const b = LIBRARY[id] || {}; t = String(b.title || b.q || id).replace(/<[^>]+>/g, ''); } catch (e) { t = id; } } // eslint-disable-line no-undef
    return { n: i + 1, id, title: t };
  }));

  async function main() {
    if (cmd === 'chrome') { log(chrome()); return; }
    const slug = args.shift();
    if (cmd === 'titles') {
      const { context, page } = await open(slug);
      log(JSON.stringify(await order(page)));
      await context.close(); return;
    }
    if (cmd === 'proposals') {   // proposed slides (prop:true, replaces:'id'), and which of each pair every version shows with the saved state
      // extra ids after the slug: report their flags too (sb proposals --bake checks the file with them)
      const { context, page, errors } = await open(slug, 1600, true);
      const res = await page.evaluate((extra) => {
        const L = LIBRARY, out = { version: String(current), versions: {}, blocks: {}, pairs: [], shown: {}, saved: [], flags: {} };   // eslint-disable-line no-undef
        const plain = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/\*\*/g, '');
        const t = (id) => { try { return plain(titleOf(id)); } catch (e) { return plain((L[id] || {}).title || (L[id] || {}).q || id); } };   // eslint-disable-line no-undef
        Object.keys(PITCHES).forEach((k) => { out.versions[k] = String(PITCHES[k].name || k); out.blocks[k] = PITCHES[k].blocks.slice(); });   // eslint-disable-line no-undef
        // versions that carry the extras too ("Everything"): an accepted proposal's original stays in them
        out.extras = Object.fromEntries(Object.entries(out.blocks).map(([k, b]) => [k, b.some((id) => L[id] && L[id].alt && !L[id].lib && !L[id].prop)]));
        out.pairs = Object.keys(L).filter((id) => L[id].prop && L[id].replaces).map((id) => ({ p: id, o: L[id].replaces, title: t(id), otitle: L[L[id].replaces] ? t(L[id].replaces) : '',
          missing: !L[L[id].replaces], palt: !!L[id].alt, oalt: !!(L[L[id].replaces] || {}).alt, notes: plain(L[id].notes).slice(0, 300) }));
        const flag = (id) => ({ exists: !!L[id], prop: !!(L[id] || {}).prop, alt: !!(L[id] || {}).alt, replaces: (L[id] || {}).replaces || null });
        [...out.pairs.flatMap((x) => [x.p, x.o]), ...extra].forEach((id) => { out.flags[id] = flag(id); });
        const sel = document.querySelector('.sidebar select'), first = String(current);   // eslint-disable-line no-undef
        const ids = () => [...document.getElementById('deck').children].filter((n) => n.dataset && n.dataset.id).map((n) => n.dataset.id);
        const has = (v) => { try { const d = savedFor(v); return !!(d && Array.isArray(d.__order)); } catch (e) { return false; } };   // eslint-disable-line no-undef
        Object.keys(PITCHES).forEach((v) => {   // eslint-disable-line no-undef
          if (has(v)) out.saved.push(v);
          if (v !== String(current) && sel && [...sel.options].some((o) => o.value === v)) { sel.value = v; sel.dispatchEvent(new Event('change', { bubbles: true })); }   // eslint-disable-line no-undef
          if (String(current) !== v) return;   // eslint-disable-line no-undef
          const on = new Set(ids()); out.shown[v] = {};
          out.pairs.forEach((x) => { out.shown[v][x.p] = [on.has(x.o), on.has(x.p)]; });
        });
        if (sel && first !== String(current)) { sel.value = first; sel.dispatchEvent(new Event('change', { bubbles: true })); }   // eslint-disable-line no-undef
        return out;
      }, args);
      res.errors = errors;
      log(JSON.stringify(res));
      await context.close(); return;
    }
    if (cmd === 'deckinfo') {   // what sb import checks a returned file against: versions, slide ids, storage key, each slide's text fingerprint
      // --version v: fingerprints as that version builds its slides (a review copy says which); a version the deck lacks is reported, not fatal
      const want = version; version = null;
      const { context, page } = await open(slug);
      const res = await page.evaluate((want) => {
        const out = { key: null, versions: {}, slides: [], defs: {}, version: null, vdefs: {}, fnotes: {}, blocks: {} };
        try { Object.keys(PITCHES).forEach((k) => { out.versions[k] = String(PITCHES[k].name || k); out.blocks[k] = PITCHES[k].blocks.slice(); }); } catch (e) {}   // eslint-disable-line no-undef
        try { const s = document.querySelector('.sidebar select'); if (want && s && [...s.options].some((o) => o.value === want)) { s.value = want; s.dispatchEvent(new Event('change', { bubbles: true })); } } catch (e) {}
        try { out.version = String(current); } catch (e) {}                                                              // eslint-disable-line no-undef
        try { out.slides = Object.keys(LIBRARY); } catch (e) {}                                                          // eslint-disable-line no-undef
        try { const k = KEY(), c = String(current); if (k.endsWith(c)) out.key = k.slice(0, k.length - c.length); } catch (e) {}   // eslint-disable-line no-undef
        try { out.slides.forEach((id) => { out.defs[id] = defHash(id); }); } catch (e) { out.defs = {}; }               // eslint-disable-line no-undef
        // for a review copy: where each slide's facilitator note sits in its saved text, the note itself, and a
        // fingerprint of the rest (a review copy carries a blank note, so sb import puts this one back)
        const dj = (t) => { let h = 5381; for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0; return String(h); };
        try { out.slides.forEach((id) => { const ns = [...build(id).querySelectorAll('[contenteditable]')], at = ns.findIndex((n) => n.classList.contains('fnote'));   // eslint-disable-line no-undef
          out.vdefs[id] = dj(ns.filter((n, i) => i !== at).map((n) => n.innerHTML).join('\u0001'));
          if (at >= 0) out.fnotes[id] = [at, ns[at].innerHTML]; }); } catch (e) { out.vdefs = {}; out.fnotes = {}; }
        return out;
      }, want);
      log(JSON.stringify(res));
      await context.close(); return;
    }
    if (cmd === 'edits') {   // the reviewer's inline edits and reordering, from the state saved on disk
      const { context, page } = await open(slug, 1600, true);
      const res = await page.evaluate(() => {
        const deckEl = document.getElementById('deck'), wraps = [...deckEl.children].filter((n) => n.dataset && n.dataset.id);
        const edits = [];
        wraps.forEach((w, k) => {
          const id = w.dataset.id, now = [...w.querySelectorAll('[contenteditable]')].map((n) => n.innerHTML);
          let f = null; try { f = build(id); } catch (e) {}                                   // eslint-disable-line no-undef
          const def = f ? [...f.querySelectorAll('[contenteditable]')].map((n) => n.innerHTML) : [];
          for (let i = 0; i < Math.max(now.length, def.length); i++) if ((now[i] || '') !== (def[i] || '')) edits.push({ n: k + 1, id, field: i, was: def[i], now: now[i] });
        });
        let defaults = []; try { defaults = PITCHES[current].blocks; } catch (e) {}           // eslint-disable-line no-undef
        const order = wraps.map((w) => w.dataset.id);
        let version = ''; try { version = current; } catch (e) {}                              // eslint-disable-line no-undef
        const removed = defaults.filter((id) => !order.includes(id));
        // a slide taken out because a proposal was decided: sb proposals --bake writes that, not a hand edit
        const L = (() => { try { return LIBRARY; } catch (e) { return {}; } })(), proposals = {};   // eslint-disable-line no-undef
        removed.forEach((id) => {
          const b = L[id] || {}, by = Object.keys(L).find((x) => L[x].prop && L[x].replaces === id && order.includes(x));
          if (b.prop && b.replaces && order.includes(b.replaces)) proposals[id] = `kept the original ${b.replaces}: bake with sb proposals --bake`;
          else if (by) proposals[id] = `accepted the proposal ${by}: bake with sb proposals --bake`;
        });
        return { version, edits, removed, added: order.filter((id) => !defaults.includes(id)), proposals,
          reordered: JSON.stringify(order.filter((id) => defaults.includes(id))) !== JSON.stringify(defaults.filter((id) => order.includes(id))) };
      });
      log(JSON.stringify(res, null, 1));
      await context.close(); return;
    }
    if (cmd === 'shot') {
      const outdir = args.shift(); fs.mkdirSync(outdir, { recursive: true });
      const { context, page, errors, settle } = await open(slug);
      for (const id of args) {
        let el = await page.$(`#deck > [data-id="${id}"] .slide`);
        if (!el) {   // a slide outside this version: build it at the end of the deck
          await page.evaluate((id) => { try { const w = build(id); if (w) { document.getElementById('deck').appendChild(w); if (typeof fitSlides === 'function') fitSlides(); } } catch (e) {} }, id); // eslint-disable-line no-undef
          await settle(); el = await page.$(`#deck > [data-id="${id}"] .slide`);
        }
        if (!el) { log('missing', id); continue; }
        await el.scrollIntoViewIfNeeded(); await settle();
        const file = path.join(outdir, `${id}.png`); await el.screenshot({ path: file }); log(file);
      }
      errors.forEach((e) => log('PAGE ERROR', e));
      await context.close(); return;
    }
    if (cmd === 'audit') {
      const { context, page, errors } = await open(slug);
      const res = await page.evaluate(() => {
        const out = [], wraps = [...document.getElementById('deck').children].filter((n) => n.dataset && n.dataset.id);
        const hit = (a, b) => { const x = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)), y = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)); return x * y; };
        wraps.forEach((w, k) => {
          const id = w.dataset.id, sl = w.querySelector('.slide'); if (!sl) return; const R = sl.getBoundingClientRect(), tag = `${k + 1} ${id}`;
          sl.querySelectorAll('*').forEach((n) => {
            if (n.closest('.ctrls, .slide-tag') || (n.closest('svg') && n.tagName.toLowerCase() !== 'svg')) return;
            if (n.tagName === 'IMG' && n.parentElement.classList.contains('pp-pic')) return;   // a cropped picture: its frame clips it, and the frame is checked
            const r = n.getBoundingClientRect(); if (!r.width || !r.height) return;
            const over = Math.max(R.left - r.left, r.right - R.right, R.top - r.top, r.bottom - R.bottom);
            if (over > 2) out.push(`${tag}: <${n.tagName.toLowerCase()}> runs ${Math.round(over)}px past the slide edge`);
            const cs = getComputedStyle(n);
            if (cs.overflow !== 'visible' && !n.classList.contains('pp-pic') && n.clientHeight > 0 && n.scrollHeight > n.clientHeight + 3) out.push(`${tag}: <${n.tagName.toLowerCase()}> cuts off its text`);
          });
          sl.querySelectorAll('svg').forEach((svg) => {
            const S = svg.getBoundingClientRect();
            const texts = [...svg.querySelectorAll('text')].map((t) => ({ t, r: t.getBoundingClientRect() })).filter((x) => x.r.width && x.r.height && x.t.textContent.trim());
            texts.forEach(({ t, r }) => { const over = Math.max(S.left - r.left, r.right - S.right, S.top - r.top, r.bottom - S.bottom); if (over > 3) out.push(`${tag}: label “${t.textContent.trim().slice(0, 40)}” runs ${Math.round(over)}px outside its figure`); });
            for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) {
              const a = texts[i].r, b = texts[j].r, area = hit(a, b), small = Math.min(a.width * a.height, b.width * b.height);
              if (small && area / small > 0.18) out.push(`${tag}: labels overlap: “${texts[i].t.textContent.trim().slice(0, 30)}” and “${texts[j].t.textContent.trim().slice(0, 30)}”`);
            }
          });
        });
        return { n: wraps.length, out };
      });
      // the guides: two-line titles and the protected border (static/guides.js, the same check the page draws)
      await page.addScriptTag({ path: path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'static', 'guides.js') });
      const guides = await page.evaluate(() => [...document.getElementById('deck').children].filter((n) => n.dataset && n.dataset.id).flatMap((w, k) => {
        const sl = w.querySelector('.slide'); return sl ? window.SBGuides.issues(sl).map((g) => `${k + 1} ${w.dataset.id}: ${g.msg}`) : [];
      }));
      log(`slides: ${res.n}`); res.out.forEach((l) => log(l)); guides.forEach((l) => log(l)); errors.forEach((e) => log('PAGE ERROR', e));
      if (!res.out.length && !guides.length) log('No overflow, overlapping labels, long titles, or anything in the protected border.');
      await context.close(); return;
    }
    if (cmd === 'export') {
      const out = args.shift();
      const { context, page, errors, settle } = await open(slug, 1600, withEdits);
      await page.emulateMedia({ media: 'print' }); await settle();
      await page.pdf({ path: out, preferCSSPageSize: true, printBackground: true });
      errors.forEach((e) => log('PAGE ERROR', e));
      log(out); await context.close(); return;
    }
    if (cmd === 'thumb') {
      const out = args.shift();
      const { context, page } = await open(slug);
      const el = await page.$('#deck > [data-id] .slide');
      if (el) await el.screenshot({ path: out });
      log(out); await context.close(); return;
    }
    log('usage: node browser.mjs titles|edits|proposals|shot|audit|export|thumb <slug> ...  |  node browser.mjs chrome');
    return 2;
  }

  let code = 0, error = null;
  try { code = (await main()) || 0; }
  catch (e) { error = e.message; code = 1; }
  finally { await Promise.all(contexts.map((c) => c.close().catch(() => {}))); }
  return { out: printed.join(''), error, code };
}
