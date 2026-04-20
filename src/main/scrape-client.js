// Main-process façade over the forked scrape-worker. Matches the public API
// of csstats-scraper.js 1:1 so the call sites (index.js, diagnostics,
// settings) can swap `require('./csstats-scraper')` → `require('./scrape-client')`
// with no other edits.
//
// All heavy work (puppeteer CDP, page parsing, disk cache I/O) runs inside
// the child process — main just routes requests and cached status.

const path = require('path');
const { fork } = require('child_process');

let worker = null;
let workerReady = false;
let nextReqId = 1;
const pending = new Map(); // id → { resolve, reject }

// Statuses the diagnostics probe + bug-report export can read synchronously.
// The worker pushes a fresh snapshot after every op; between ops this is
// whatever it last told us, which is fine for the UI.
let cachedStatus = { rateLimited: false, cooldownRemainingMs: 0, cachedPlayers: 0 };

// Caller-provided hook, typically index.js's reportStatus(service, state).
// Forwarded from the worker's scraper.setStatusReporter() callback.
let statusReporter = null;

function handleMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'ready') { workerReady = true; console.log('[ScrapeWorker] Ready'); return; }

  if (msg.type === 'status') {
    if (statusReporter) {
      try { statusReporter(msg.service, msg.state); } catch {}
    }
    return;
  }

  if (msg.type === 'statusSnapshot') {
    if (msg.data) cachedStatus = msg.data;
    return;
  }

  if (msg.type === 'result') {
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    if (msg.ok) entry.resolve(msg.data);
    else entry.reject(new Error(msg.error || 'scrape worker error'));
    return;
  }
}

function startWorker() {
  const scriptPath = path.join(__dirname, 'scrape-worker.js');
  let userDataDir = process.env.USER_DATA_DIR;
  if (!userDataDir) {
    try { userDataDir = require('electron').app.getPath('userData'); }
    catch { userDataDir = ''; }
  }
  worker = fork(scriptPath, [], {
    // ELECTRON_RUN_AS_NODE tells the Electron binary we're fork()ing to
    // behave like plain Node — otherwise the child tries to boot a full
    // second Electron app. USER_DATA_DIR is forwarded so puppeteer's
    // profile stays per-install, not per-process (the child can't call
    // app.getPath once ELECTRON_RUN_AS_NODE is set).
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', USER_DATA_DIR: userDataDir },
  });

  worker.on('message', handleMessage);

  worker.on('error', (err) => {
    console.error('[ScrapeWorker] Error:', err.message);
  });

  worker.on('exit', (code, signal) => {
    console.log(`[ScrapeWorker] Exited code=${code} signal=${signal}`);
    worker = null;
    workerReady = false;
    // Reject any in-flight requests so callers don't hang forever.
    for (const entry of pending.values()) {
      try { entry.reject(new Error('scrape worker exited')); } catch {}
    }
    pending.clear();
  });
}

function ensureWorker() {
  if (!worker) startWorker();
}

function callWorker(type, payload = {}) {
  ensureWorker();
  const id = nextReqId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try {
      worker.send({ type, id, ...payload });
    } catch (err) {
      pending.delete(id);
      reject(err);
    }
  });
}

// ── Public API (mirrors csstats-scraper.js) ──────────────────

function start() { ensureWorker(); }

function setStatusReporter(fn) { statusReporter = fn; }

function getCsstatsStatus() { return cachedStatus; }

function scrapeAllPlayers(steamIds) {
  return callWorker('scrapeAll', { steamIds });
}

function probe(steamId) {
  return callWorker('probe', { steamId });
}

function loginToCsstats() {
  return callWorker('login');
}

async function shutdownScraper() {
  if (!worker) return;
  try { await callWorker('shutdown'); } catch {}
  try { worker.kill(); } catch {}
  worker = null;
  workerReady = false;
}

module.exports = {
  start,
  setStatusReporter,
  getCsstatsStatus,
  scrapeAllPlayers,
  probe,
  loginToCsstats,
  shutdownScraper,
};
