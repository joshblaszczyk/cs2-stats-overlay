// Worker process — handles all API fetching so the main process event loop stays free

process.on('uncaughtException', (err) => {
  console.error('[Worker] Uncaught:', err.message);
});

const path = require('path');
const fs = require('fs');

// Load .env
const envPath = path.join(__dirname, '../../.env');
try {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([\w]+)\s*=\s*(.+)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {}

const { setApiKey, fetchAllPlayerStats, fetchLeetifyForPlayers, clearCache, clearNoLeetify } = require('./steam-api');
const { setFaceitKey } = require('./faceit-api');
const { setLeetifyKey, setLeetifyKey2, setStatusReporter: setLeetifyStatusReporter } = require('./leetify-api');

// Forward Leetify health to main process
setLeetifyStatusReporter((service, state) => {
  try { if (process.connected) process.send({ type: 'status', service, state }); } catch {}
});

if (process.env.STEAM_API_KEY) setApiKey(process.env.STEAM_API_KEY);
if (process.env.FACEIT_API_KEY) setFaceitKey(process.env.FACEIT_API_KEY);
if (process.env.LEETIFY_API_KEY) setLeetifyKey(process.env.LEETIFY_API_KEY);
if (process.env.LEETIFY_API_KEY_2) setLeetifyKey2(process.env.LEETIFY_API_KEY_2);

function safeSend(data) {
  try { if (process.connected) process.send(data); }
  catch { /* parent closed */ }
}

process.on('message', async (msg) => {
  if (msg.type === 'fetch') {
    try {
      // Phase 1: Steam + FACEIT (fast) — send immediately
      const players = await fetchAllPlayerStats(msg.steamIds);
      const teams = msg.teams || {};
      const tagged = players.map(p => ({ ...p, team: teams[p.steamId] || null }));
      safeSend({ type: 'result', players: tagged, map: msg.map, epoch: msg.epoch });
      const withFaceit = tagged.filter(p => p.faceit).length;
      const withStats = tagged.filter(p => p.stats).length;
      console.log(`[Worker] Phase 1: ${tagged.length} players (${withFaceit} FACEIT, ${withStats} Steam stats)`);

      // Phase 2: Leetify (batched, slower) — includes map stats from recent_matches
      const updated = await fetchLeetifyForPlayers(msg.steamIds);
      if (updated.length > 0) {
        const allPlayers = await fetchAllPlayerStats(msg.steamIds);
        const retagged = allPlayers.map(p => ({ ...p, team: teams[p.steamId] || null }));
        safeSend({ type: 'result', players: retagged, map: msg.map, epoch: msg.epoch });
        console.log(`[Worker] Phase 2: ${updated.length} Leetify profiles fetched`);
      } else {
        console.log(`[Worker] Phase 2: No new Leetify profiles`);
      }
    } catch (err) {
      safeSend({ type: 'error', message: err.message });
    }
  } else if (msg.type === 'clear-cache') {
    clearCache();
    clearNoLeetify();
    console.log('[Worker] Cache cleared');
  } else if (msg.type === 'set-api-key') {
    if (msg.key) {
      setApiKey(msg.key);
      clearCache();
      console.log('[Worker] Steam API key updated, cache cleared');
    }
  }
});

safeSend({ type: 'ready' });
