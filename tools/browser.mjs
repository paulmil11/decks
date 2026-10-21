// Headless jobs for Decks (run by `sb` and the server). Always loads the plain
// deck (?raw=1), so the Decks shell never ends up in a screenshot or a PDF.
//
//   node browser.mjs titles <slug> [--version v]
//   node browser.mjs edits  <slug> [--version v]   (the reviewer's inline edits and order, read-only)
//   node browser.mjs proposals <slug> [ids…]      (proposed slides, and what each version shows of each pair, read-only)
//   node browser.mjs deckinfo <slug> [--version v] (versions, slide ids, storage key, fingerprints: what sb import checks against)
//   node browser.mjs shot   <slug> <outdir> [--version v] <slide-id> ...
//   node browser.mjs audit  <slug> [--version v]
//   node browser.mjs export <slug> <out.pdf> [--version v]
//   node browser.mjs thumb  <slug> <out.png>
//   node browser.mjs chrome                        (print the Chrome it will use; setup.sh asks)
//
// The server is at SB_URL (sb and the server set it), else http://localhost:$SB_PORT (8790).
// Chrome: SB_CHROME if set, else Playwright's Chrome for Testing (setup.sh installs it),
// else an installed Google Chrome or Chromium.
//
// One Chrome serves the jobs (they are in browser-jobs.mjs). The first job starts a worker for this user
// that keeps headless Chrome open: it listens on a Unix socket in a folder only this user can open, runs
// one job at a time, each in a fresh browser context, and quits after two idle minutes. A job runs here,
// in a Chrome of its own, when SB_BROWSER_WORKER=0, on Windows, or when no worker can take it.
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import { createHash } from 'crypto';
import { execFileSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';

const BASE = (process.env.SB_URL || `http://localhost:${process.env.SB_PORT || 8790}`).replace(/\/$/, '');
const args = process.argv.slice(2);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CWD = (() => { try { return process.cwd(); } catch (e) { return null; } })();   // null: the caller's folder is gone
const IDLE_MS = Math.max(1000, Number(process.env.SB_BROWSER_IDLE_MS) || 120000);
const JOB_MS = 300000;   // a job still running after five minutes is stuck: the worker gives up on it and quits

// A worker and its Chrome run at the priority of whoever started them, and a server run by launchd
// can be throttled to background priority (macOS shows that as a low PRI), which makes shots about
// twice as slow. So a throttled caller gets a worker of its own, and never hands one to the others.
function priority() {
  let p = String(os.getPriority());
  if (process.platform === 'darwin') {
    try { if (Number(execFileSync('/bin/ps', ['-o', 'pri=', '-p', String(process.pid)], { encoding: 'utf8' })) < 31) p += ' throttled'; } catch (e) {}
  }
  return p;
}

// The worker's socket and lock. The name changes with this code and the Chrome it would start, so a
// worker from older code (or for another Chrome) is never asked; it quits when idle.
function where() {
  if (process.env.SB_BROWSER_WORKER === '0' || typeof process.getuid !== 'function') return null;   // Windows: no getuid, no worker
  const id = createHash('sha256')
    .update([HERE, os.tmpdir(), priority(), process.env.SB_CHROME, process.env.PLAYWRIGHT_BROWSERS_PATH, IDLE_MS].map((x) => String(x || '')).join('\0'))
    .update(fs.readFileSync(path.join(HERE, 'browser.mjs'))).update(fs.readFileSync(path.join(HERE, 'browser-jobs.mjs')))
    .digest('hex').slice(0, 16);
  for (const root of [os.tmpdir(), '/tmp']) {   // macOS allows a socket path of 103 bytes at most: a long TMPDIR falls back to /tmp
    const sock = path.join(root, `decks-browser-${process.getuid()}`, `${id}.sock`);
    if (Buffer.byteLength(sock) <= 103) return paths(sock);
  }
  return null;
}
const paths = (sock) => ({ sock, dir: path.dirname(sock), lock: sock.replace(/\.sock$/, '.lock') });

function privateDir(dir) {   // this user's, and only this user's
  try {
    try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const st = fs.lstatSync(dir);
    return st.isDirectory() && st.uid === process.getuid() && !(st.mode & 0o077);
  } catch (e) { return false; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- the client: hand the job to the worker, starting one if none is running

function ask(w) {   // { result } from the worker, or { code }: why no worker took the job
  return new Promise((resolve) => {
    const sock = net.createConnection(w.sock);
    let data = '', code = 'gone';   // gone: the worker quit before answering
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(JSON.stringify({ args, base: BASE, cwd: CWD }) + '\n'));
    sock.on('data', (chunk) => { data += chunk; });
    sock.on('error', (e) => { code = e.code; });
    sock.on('close', () => { const i = data.indexOf('\n'); try { resolve(i < 0 ? { code } : { result: JSON.parse(data.slice(0, i)) }); } catch (e) { resolve({ code }); } });
  });
}

async function viaWorker(w) {
  let res = await ask(w);
  if (res.result) return res.result;
  if (!['ENOENT', 'ECONNREFUSED', 'gone'].includes(res.code)) return null;   // sockets not allowed here, say
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--worker', w.sock], { detached: true, stdio: 'ignore' });
  let exited = 0;
  child.on('error', () => { exited = Date.now(); }); child.on('exit', () => { exited = Date.now(); }); child.unref();
  // wait for it; if it quits instead (another worker won the lock, or it can't start), give the winner a second
  for (const until = Date.now() + 5000; Date.now() < until && !(exited && Date.now() - exited > 1000);) {
    await sleep(40);
    if (fs.existsSync(w.sock) && (res = await ask(w)).result) return res.result;
  }
  return null;
}

async function direct() {   // this job alone, in a Chrome of its own
  const jobs = await import('./browser-jobs.mjs');
  let chrome = null;
  try { return await jobs.run(args, { base: BASE, browser: async () => (chrome ||= await jobs.launch()) }); }
  finally { if (chrome) await chrome.close().catch(() => {}); }
}

// --- the worker

const answers = (sock) => new Promise((resolve) => {
  const s = net.createConnection(sock);
  s.on('connect', () => { s.destroy(); resolve(true); });
  s.on('error', () => resolve(false));
});

async function stale(w) {   // the lock's worker is gone: its process ended, or (its pid reused since) its socket is dead
  let pid = 0, age = 0;
  try { age = Date.now() - fs.statSync(w.lock).mtimeMs; pid = Number(fs.readFileSync(path.join(w.lock, 'pid'), 'utf8')); } catch (e) {}
  if (pid > 0) { try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') return true; } }
  return age > 30000 && !(await answers(w.sock));
}

// One worker at a time: the lock is a folder holding the worker's pid. A worker that finds a stale lock
// takes it over; the .reap folder makes sure only one worker at a time does that.
async function claim(w) {
  const take = () => { fs.mkdirSync(w.lock, { mode: 0o700 }); fs.writeFileSync(path.join(w.lock, 'pid'), String(process.pid)); return true; };
  try { return take(); } catch (e) { if (e.code !== 'EEXIST') return false; }
  const reap = w.lock + '.reap';
  try { fs.mkdirSync(reap, { mode: 0o700 }); } catch (e) {
    try { if (Date.now() - fs.statSync(reap).mtimeMs > 30000) fs.rmdirSync(reap); } catch (e2) {}   // left by a worker that died reaping
    return false;
  }
  try {
    if (!(await stale(w))) return false;
    fs.rmSync(w.lock, { recursive: true, force: true });
    return take();
  } catch (e) { return false; }
  finally { try { fs.rmdirSync(reap); } catch (e) {} }
}

async function worker(w) {
  if (!privateDir(w.dir) || !(await claim(w))) return;
  const jobs = await import('./browser-jobs.mjs');
  let chrome = null, timer = null, busy = 0, queue = Promise.resolve(), closing = false;
  const browser = async () => { if (!chrome || !chrome.isConnected()) chrome = await jobs.launch(); return chrome; };
  const quit = async () => {
    if (closing) return;
    closing = true; clearTimeout(timer);
    server.close();
    try { fs.unlinkSync(w.sock); } catch (e) {}
    try { if (Number(fs.readFileSync(path.join(w.lock, 'pid'), 'utf8')) === process.pid) fs.rmSync(w.lock, { recursive: true, force: true }); } catch (e) {}
    if (chrome) await Promise.race([chrome.close().catch(() => {}), sleep(5000)]);
    process.exit(0);
  };
  const idle = () => { clearTimeout(timer); if (!busy && !closing) timer = setTimeout(quit, IDLE_MS); };

  async function job(line) {
    let req = null; try { req = JSON.parse(line); } catch (e) {}
    if (!req || !Array.isArray(req.args) || req.args.some((a) => typeof a !== 'string') || typeof req.base !== 'string' || typeof req.cwd !== 'string')
      return { out: '', error: 'Not a browser job', code: 1 };
    try { process.chdir(req.cwd); } catch (e) { return { out: '', error: e.message, code: 1 }; }   // relative paths mean what they did to the caller
    let stuck;
    const res = await Promise.race([jobs.run(req.args, { base: req.base, browser }), new Promise((r) => { stuck = setTimeout(r, JOB_MS); })]);
    clearTimeout(stuck);
    if (res) return res;
    setImmediate(quit);   // Chrome may be wedged: close it and this worker; the next job starts a fresh one
    return { out: '', error: `The browser job was still running after ${JOB_MS / 60000} minutes, so it was stopped.`, code: 1 };
  }

  const server = net.createServer((sock) => {
    let input = '', got = false, gone = false;
    sock.setEncoding('utf8');
    sock.on('error', () => {});
    sock.on('close', () => { gone = true; });
    sock.setTimeout(10000, () => { if (!got) sock.destroy(); });   // a client sends its job at once
    sock.on('data', (chunk) => {
      if (got) return;
      input += chunk;
      if (input.length > 1 << 20) return sock.destroy();
      if (!input.includes('\n')) return;
      got = true; sock.setTimeout(0); busy++; clearTimeout(timer);
      queue = queue.then(async () => {   // one job at a time: exports don't fight over the CPU
        if (!gone) sock.end(JSON.stringify(await job(input.slice(0, input.indexOf('\n')))) + '\n');   // a caller that gave up waiting is skipped
      }).catch(() => sock.destroy()).finally(() => { busy--; idle(); });
    });
  });
  server.on('error', quit);
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, quit);
  try { fs.unlinkSync(w.sock); } catch (e) {}   // left by a worker that died
  server.listen(w.sock, () => { fs.chmodSync(w.sock, 0o600); idle(); });
}

async function main() {
  if (args[0] === '--worker') { if (args[1]) await worker(paths(args[1])); return; }
  const w = args[0] !== 'chrome' && CWD && where();
  const res = (w && privateDir(w.dir) && await viaWorker(w)) || await direct();
  process.stdout.write(res.out);
  if (res.error) console.error(res.error);
  process.exitCode = res.code;
}
main().catch((e) => { console.error(e.message); process.exitCode = 1; });
