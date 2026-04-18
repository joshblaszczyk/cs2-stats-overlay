// Build a sanitized bug report folder. Scrubs SteamIDs + Windows username
// paths so reports can be shared publicly, but preserves everything useful
// for debugging: timestamps, errors, stack traces, state transitions,
// service flags, scrape timings, worker coverage counts.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { app } = require('electron');

const MAX_REPORTS = 5;
const STEAMID_RE = /\b7656119\d{10}\b/g;

// Stable 6-char token per SteamID so "same player across lines" stays
// traceable. Uses a per-report random salt so tokens can't be cross-matched
// between reports by an attacker who got two of them.
function makeSteamIdScrubber() {
  const salt = crypto.randomBytes(8).toString('hex');
  const map = new Map();
  let nextIdx = 0;
  return {
    replace(text) {
      if (typeof text !== 'string') return text;
      return text.replace(STEAMID_RE, (id) => {
        if (!map.has(id)) {
          const hash = crypto.createHash('sha256').update(salt + id).digest('hex').slice(0, 4);
          map.set(id, `P${(nextIdx++).toString().padStart(2, '0')}_${hash}`);
        }
        return map.get(id);
      });
    },
    size() { return map.size; },
  };
}

// C:\Users\<anything>\  →  C:\Users\<USER>\
// Also handles forward-slash variants and case-insensitive drive letter.
function scrubHomePath(text) {
  if (typeof text !== 'string') return text;
  const userName = os.userInfo().username;
  const escaped = userName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rePair = [
    new RegExp(`([A-Za-z]:\\\\Users\\\\)${escaped}`, 'g'),
    new RegExp(`([A-Za-z]:/Users/)${escaped}`, 'g'),
  ];
  for (const re of rePair) text = text.replace(re, '$1<USER>');
  return text;
}

function sanitizeText(text, scrubber) {
  return scrubHomePath(scrubber.replace(text));
}

function sanitizeJson(raw, scrubber) {
  try {
    const obj = JSON.parse(raw);
    const walk = (v) => {
      if (typeof v === 'string') return sanitizeText(v, scrubber);
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === 'object') {
        const out = {};
        for (const k of Object.keys(v)) out[sanitizeText(k, scrubber)] = walk(v[k]);
        return out;
      }
      return v;
    };
    return JSON.stringify(walk(obj), null, 2);
  } catch {
    // Non-JSON fallback
    return sanitizeText(raw, scrubber);
  }
}

function ensureDir(p) { try { fs.mkdirSync(p, { recursive: true }); } catch {} }

function rotateOldReports(reportsDir) {
  try {
    const entries = fs.readdirSync(reportsDir)
      .map(name => ({ name, full: path.join(reportsDir, name) }))
      .filter(e => { try { return fs.statSync(e.full).isDirectory(); } catch { return false; } })
      .sort((a, b) => fs.statSync(b.full).mtimeMs - fs.statSync(a.full).mtimeMs);
    for (const e of entries.slice(MAX_REPORTS - 1)) {
      try { fs.rmSync(e.full, { recursive: true, force: true }); } catch {}
    }
  } catch {}
}

async function exportBugReport() {
  const userData = app.getPath('userData');
  const logsDir = app.getPath('logs');
  const reportsDir = path.join(userData, 'bug-reports');
  ensureDir(reportsDir);
  rotateOldReports(reportsDir);

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const reportDir = path.join(reportsDir, `report-${ts}`);
  ensureDir(reportDir);

  const scrubber = makeSteamIdScrubber();

  // --- Logs (all recent) ---
  try {
    if (fs.existsSync(logsDir)) {
      const logFiles = fs.readdirSync(logsDir).filter(f => f.endsWith('.log')).slice(-3);
      for (const f of logFiles) {
        try {
          const raw = fs.readFileSync(path.join(logsDir, f), 'utf8');
          fs.writeFileSync(path.join(reportDir, f), sanitizeText(raw, scrubber), 'utf8');
        } catch {}
      }
    }
  } catch {}

  // --- Settings (strip encrypted keys entirely) ---
  try {
    const settingsPath = path.join(userData, 'settings.json');
    if (fs.existsSync(settingsPath)) {
      const raw = fs.readFileSync(settingsPath, 'utf8');
      try {
        const obj = JSON.parse(raw);
        if (obj.apiKeys) {
          const masked = {};
          for (const k of Object.keys(obj.apiKeys)) {
            masked[k] = obj.apiKeys[k] ? '<SET>' : '';
          }
          obj.apiKeys = masked;
        }
        fs.writeFileSync(path.join(reportDir, 'settings.json'),
          sanitizeJson(JSON.stringify(obj), scrubber), 'utf8');
      } catch {
        // malformed JSON — skip
      }
    }
  } catch {}

  // --- csstats cache (keys + values sanitized, stats shape preserved) ---
  try {
    const cachePath = path.join(userData, 'csstats-cache.json');
    if (fs.existsSync(cachePath)) {
      const raw = fs.readFileSync(cachePath, 'utf8');
      fs.writeFileSync(path.join(reportDir, 'csstats-cache.json'),
        sanitizeJson(raw, scrubber), 'utf8');
    }
  } catch {}

  // --- System info (for env-specific bugs) ---
  try {
    const info = {
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron,
      chromeVersion: process.versions.chrome,
      nodeVersion: process.versions.node,
      platform: `${os.platform()} ${os.release()}`,
      arch: os.arch(),
      cpus: os.cpus().length,
      totalMemoryGB: Math.round(os.totalmem() / 1024 / 1024 / 1024),
      displays: 'see logs',
      steamIdsScrubbed: scrubber.size(),
      generatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(reportDir, 'system-info.txt'),
      Object.entries(info).map(([k, v]) => `${k}: ${v}`).join('\n'), 'utf8');
  } catch {}

  // --- Scrubbing notes for the report recipient ---
  const readme = [
    'CS2 Stats Overlay — Bug Report Bundle',
    '='.repeat(40),
    '',
    'All files in this folder are sanitized:',
    `  • ${scrubber.size()} unique SteamID(s) → Pxx_hash tokens`,
    '  • Windows user paths (C:\\Users\\<name>\\) → C:\\Users\\<USER>\\',
    '  • API keys → <SET> or empty',
    '',
    'What is preserved (and why):',
    '  • Timestamps, errors, stack traces',
    '  • Map names, round phases, match epoch numbers',
    '  • Service status (leetify ok/down, csstats rate-limited)',
    '  • Worker coverage (steam=X/Y, faceit=X/Y)',
    '  • Scrape timings, cache hit/miss counts',
    '  • Opacity, perf mode, font scale, other settings',
    '',
    'Share this folder (or ZIP it) when filing a bug. Reports older than',
    `${MAX_REPORTS} are auto-deleted to prevent disk fill.`,
  ].join('\n');
  try { fs.writeFileSync(path.join(reportDir, 'README.txt'), readme, 'utf8'); } catch {}

  return { reportDir, steamIdsScrubbed: scrubber.size() };
}

module.exports = { exportBugReport };
