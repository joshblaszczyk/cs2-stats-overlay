// Live-test API keys by issuing a single cheap request per provider and
// mapping the HTTP response to a pass/fail + reason the UI can show.
// Extracted from index.js so the save-api-keys + validate-api-keys IPC
// handlers stay small and the mapping logic is one readable function.

const https = require('https');

const REQUEST_TIMEOUT_MS = 10000;
const MAX_BODY_BYTES = 200000;

// Minimal GET that resolves with { status, body } instead of rejecting on
// network error — simplifies the per-provider branching below.
function httpGet(url, headers = {}) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
        if (data.length > MAX_BODY_BYTES) req.destroy();
      });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
      res.on('error', () => resolve({ status: 0, body: '' }));
    });
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy());
  });
}

// Steam: GetPlayerSummaries with a well-known test SteamID64. 200 + JSON
// with "response.players" = valid key. 401/403 = rejected. Anything else
// = network/unknown.
async function validateSteamKey(key) {
  if (!key) return { ok: false, reason: 'Steam key missing (optional)', optional: true };
  const url = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${encodeURIComponent(key)}&steamids=76561197960435530`;
  const r = await httpGet(url);
  if (r.status === 200 && r.body.includes('"response"') && r.body.includes('"players"')) {
    return { ok: true };
  }
  if (r.status === 401 || r.status === 403) return { ok: false, reason: 'Invalid Steam API key' };
  if (r.status === 0) return { ok: false, reason: 'Network error reaching Steam' };
  return { ok: false, reason: `Steam returned ${r.status}` };
}

// FACEIT: cheapest endpoint that authenticates — GET /games/cs2 with a
// bearer header returns 200 OK with minimal payload.
async function validateFaceitKey(key) {
  if (!key) return { ok: false, reason: 'FACEIT key missing (optional)', optional: true };
  const r = await httpGet('https://open.faceit.com/data/v4/games/cs2', {
    Authorization: `Bearer ${key}`,
  });
  if (r.status === 200) return { ok: true };
  if (r.status === 401 || r.status === 403) return { ok: false, reason: 'Invalid FACEIT API key' };
  if (r.status === 0) return { ok: false, reason: 'Network error reaching FACEIT' };
  return { ok: false, reason: `FACEIT returned ${r.status}` };
}

// Validate whatever keys were provided. Keys set to empty strings are
// reported as "missing (optional)" so the UI can distinguish "not set" from
// "set but wrong".
async function validateApiKeys(keys) {
  return {
    steam: await validateSteamKey(String(keys?.steam || '').trim()),
    faceit: await validateFaceitKey(String(keys?.faceit || '').trim()),
  };
}

module.exports = { validateApiKeys, validateSteamKey, validateFaceitKey };
