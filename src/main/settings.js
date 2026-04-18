const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

const SETTINGS_FILE = 'settings.json';
const ENC_PREFIX = 'enc:';

function encryptionAvailable() {
  try {
    return safeStorage && safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function encryptApiKeys(apiKeys) {
  if (!apiKeys || typeof apiKeys !== 'object') return apiKeys;
  if (!encryptionAvailable()) return apiKeys;
  const out = {};
  for (const k of Object.keys(apiKeys)) {
    const v = apiKeys[k];
    if (typeof v === 'string' && v && !v.startsWith(ENC_PREFIX)) {
      try {
        out[k] = ENC_PREFIX + safeStorage.encryptString(v).toString('base64');
      } catch {
        out[k] = v;
      }
    } else {
      out[k] = v;
    }
  }
  return out;
}

function decryptApiKeys(apiKeys) {
  if (!apiKeys || typeof apiKeys !== 'object') return apiKeys;
  const out = {};
  for (const k of Object.keys(apiKeys)) {
    const v = apiKeys[k];
    if (typeof v === 'string' && v.startsWith(ENC_PREFIX)) {
      if (!encryptionAvailable()) {
        out[k] = v;
        continue;
      }
      try {
        out[k] = safeStorage.decryptString(Buffer.from(v.slice(ENC_PREFIX.length), 'base64'));
      } catch {
        out[k] = v;
      }
    } else {
      out[k] = v;
    }
  }
  return out;
}

const DEFAULTS = {
  apiKeys: {
    steam: '',
    faceit: '',
    leetify: '',
    leetify2: '',
  },
  general: {
    opacity: 88,
    fancyScoreboard: true,
    setupComplete: false,
    lowPowerMode: false,
    disableCsstats: false,
    perfMode: 'balanced', // 'battery' | 'balanced' | 'high'
    fontScale: 100, // percent, 70-150
  },
  tabView: {
    premierRating: true,
    faceitLevel: true,
    kd: true,
    hsPercent: true,
    hours: true,
  },
  hoverDetail: {
    legitimacy: true,
    leetify: true,
    faceit: true,
    steamLifetime: true,
    accountInfo: true,
  },
  columnWidths: {
    name: 200, rank: 100, hltv: 58, kd: 48, win: 58, adr: 50, hs: 52, hours: 60,
  },
};

function getSettingsPath() {
  const dir = app.getPath('userData');
  return path.join(dir, SETTINGS_FILE);
}

// In-memory cache. load() is called from hot paths (every GSI POST, every TAB
// poll, every scrape tick) — reading + parsing settings.json each time was
// ~15 fs hits per second. Cache is invalidated by save().
let cached = null;

function load() {
  if (cached) return cached;
  const filePath = getSettingsPath();
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf8');
      const saved = JSON.parse(raw);
      if (saved && saved.apiKeys) {
        saved.apiKeys = decryptApiKeys(saved.apiKeys);
      }
      cached = deepMerge(DEFAULTS, saved);
      return cached;
    }
  } catch (err) {
    console.error('[Settings] Failed to load:', err.message);
  }
  cached = { ...DEFAULTS };
  return cached;
}

function save(data) {
  const filePath = getSettingsPath();
  const dir = path.dirname(filePath);
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const toWrite = { ...data };
    if (toWrite.apiKeys) {
      toWrite.apiKeys = encryptApiKeys(toWrite.apiKeys);
    }
    fs.writeFileSync(filePath, JSON.stringify(toWrite, null, 2), 'utf8');
    cached = null; // Invalidate; next load() re-reads + re-decrypts.
    return true;
  } catch (err) {
    console.error('[Settings] Failed to save:', err.message);
    return false;
  }
}

function deepMerge(defaults, overrides) {
  const result = { ...defaults };
  for (const key of Object.keys(overrides)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (
      result[key] &&
      typeof result[key] === 'object' &&
      !Array.isArray(result[key]) &&
      typeof overrides[key] === 'object' &&
      !Array.isArray(overrides[key])
    ) {
      result[key] = deepMerge(result[key], overrides[key]);
    } else {
      result[key] = overrides[key];
    }
  }
  return result;
}

module.exports = { load, save };
