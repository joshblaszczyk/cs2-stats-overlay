// Child process that owns the puppeteer browser and the csstats/csrep scrape
// pipeline. Forked from the main process so all the CDP traffic, page
// parsing, and disk-cache I/O happen off the Electron main event loop —
// main stays free to pump the GSI HTTP server, cursor polling, and the
// overlay's input forwarding during a scrape.
//
// Wire protocol with main (see scrape-client.js):
//   parent → child:  { type: 'scrapeAll' | 'probe' | 'login' | 'shutdown' |
//                      'getStatus', id, payload? }
//   child → parent:  { type: 'ready' }
//                    { type: 'result', id, ok, data }
//                    { type: 'result', id, ok: false, error }
//                    { type: 'status', service: 'csstats', state }
//                    { type: 'statusSnapshot', data }    // after each op

process.on('uncaughtException', (err) => {
  console.error('[ScrapeWorker] Uncaught:', err.message);
});

// If the parent goes away (crash, kill) the IPC channel disconnects. Exit
// instead of lingering as an orphan process holding the Chrome user-data
// dir open — next parent boot will just fork a fresh worker.
process.on('disconnect', () => {
  try { process.exit(0); } catch {}
});

const path = require('path');
const fs = require('fs');

// Load .env the same way fetch-worker does — keeps dev runs with env-file
// keys working even when the worker is a separate process.
const envPath = path.join(__dirname, '../../.env');
try {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([\w]+)\s*=\s*(.+)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {}

// Lazy-load the scraper so the child boots fast — puppeteer-real-browser
// pulls in a lot of modules at require time. First scrape pays that cost,
// not startup.
let scraper = null;
function getScraper() {
  if (!scraper) {
    scraper = require('./csstats-scraper');
    // Forward status changes from the scraper up to main.
    scraper.setStatusReporter((service, state) => {
      safeSend({ type: 'status', service, state });
    });
  }
  return scraper;
}

function safeSend(msg) {
  try { if (process.connected) process.send(msg); }
  catch { /* parent closed */ }
}

function sendStatusSnapshot() {
  try {
    const s = getScraper();
    safeSend({ type: 'statusSnapshot', data: s.getCsstatsStatus() });
  } catch {}
}

process.on('message', async (msg) => {
  if (!msg || typeof msg !== 'object') return;
  const { id, type } = msg;

  try {
    if (type === 'scrapeAll') {
      const s = getScraper();
      const data = await s.scrapeAllPlayers(msg.steamIds || []);
      safeSend({ type: 'result', id, ok: true, data });
      sendStatusSnapshot();
      return;
    }

    if (type === 'probe') {
      // Probe: single-player scrape that the diagnostics "Is csstats working?"
      // health check runs. Wrap browser + page lifecycle here so main doesn't
      // need to pass a page handle across IPC.
      const s = getScraper();
      const { ensureBrowser } = require('./csstats-browser');
      const base = s.getCsstatsStatus();
      if (base.rateLimited) {
        safeSend({ type: 'result', id, ok: true, data: { ...base, probed: false } });
        return;
      }
      let data = null;
      let probeErr = null;
      try {
        const b = await ensureBrowser();
        const page = await b.newPage();
        try { data = await s.scrapePlayer(msg.steamId, page); }
        finally { try { await page.close(); } catch {} }
      } catch (err) {
        probeErr = err;
      }

      if (probeErr) {
        const isRL = probeErr.name === 'RateLimitedError'
          || /rate.?limit|1015|cloudflare/i.test(probeErr.message || '');
        safeSend({
          type: 'result', id, ok: true, data: {
            ...s.getCsstatsStatus(),
            probed: true,
            rateLimited: isRL || base.rateLimited,
            error: probeErr.message,
          },
        });
        sendStatusSnapshot();
        return;
      }

      const ok = data && (data.kd != null || data.premier != null || data.faceitLevel != null);
      const after = s.getCsstatsStatus();
      safeSend({
        type: 'result', id, ok: true, data: {
          ...after,
          probed: true,
          rateLimited: after.rateLimited || !ok,
          probeOk: ok,
          probeId: msg.steamId,
        },
      });
      sendStatusSnapshot();
      return;
    }

    if (type === 'login') {
      const s = getScraper();
      const data = await s.loginToCsstats();
      safeSend({ type: 'result', id, ok: true, data });
      sendStatusSnapshot();
      return;
    }

    if (type === 'shutdown') {
      if (scraper) { try { await scraper.shutdownScraper(); } catch {} }
      safeSend({ type: 'result', id, ok: true, data: true });
      sendStatusSnapshot();
      return;
    }

    if (type === 'getStatus') {
      const s = getScraper();
      safeSend({ type: 'result', id, ok: true, data: s.getCsstatsStatus() });
      return;
    }

    safeSend({ type: 'result', id, ok: false, error: `unknown message type: ${type}` });
  } catch (err) {
    safeSend({ type: 'result', id, ok: false, error: err && err.message || String(err) });
  }
});

safeSend({ type: 'ready' });
