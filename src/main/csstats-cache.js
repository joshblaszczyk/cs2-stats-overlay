// Two-layer cache for csstats.gg scrape results.
//
//   Layer 1 — in-memory Map, checked on every request.
//   Layer 2 — JSON file on disk, loaded once on first read and written
//             back on a 2-second debounce whenever entries change.
//
// csstats updates slowly (daily at best) and Cloudflare rate-limits
// aggressively; serving stale data for a few hours is a much better UX
// than re-scraping on every match and risking a 20-minute cooldown.

const path = require('path');
const fs = require('fs');

// Cache lifetime: 4 hours. Long enough that a full session of CS2 never
// triggers a re-scrape; short enough that rank changes show up same-day.
const SCRAPE_TTL_MS = 4 * 60 * 60 * 1000;

// Bump this whenever the scraper output shape changes (new fields, renamed
// fields). Entries persisted under an older schema are ignored at load
// time and forced to re-scrape. Top-up logic in the scraper also runs when
// an older entry is missing newer fields, so bumping isn't always required.
const CACHE_SCHEMA_VERSION = 2; // v2 adds csrepTrust / csrepAnomalies / faceitNickname

const DISK_SAVE_DEBOUNCE_MS = 2000;

const scrapeCache = new Map();
let diskCacheLoaded = false;
let diskSaveTimer = null;

// Resolve the cache file path. In a packaged app it lives under
// userData/csstats-cache.json (roaming across app updates); in dev it
// sits at the project root so a `git clean` wipes it.
function getDiskCachePath() {
  try {
    const { app } = require('electron');
    if (app && app.getPath) {
      return path.join(app.getPath('userData'), 'csstats-cache.json');
    }
  } catch {}
  return path.join(__dirname, '../../.csstats-cache.json');
}

// One-shot lazy load so the cost isn't paid on boot. Expired entries are
// dropped at load time; missing newer fields are handled by the scraper's
// top-up path, not here.
function loadDiskCache() {
  if (diskCacheLoaded) return;
  diskCacheLoaded = true;
  try {
    const p = getDiskCachePath();
    if (!fs.existsSync(p)) return;
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const now = Date.now();
    let loaded = 0;
    for (const [id, entry] of Object.entries(raw)) {
      if (!entry || !entry.scrapedAt) continue;
      if ((now - entry.scrapedAt) >= SCRAPE_TTL_MS) continue;
      scrapeCache.set(id, entry);
      loaded++;
    }
    if (loaded > 0) console.log(`[CSScrape] Loaded ${loaded} cached player(s) from disk`);
  } catch (e) {
    console.log('[CSScrape] Disk cache load failed:', e.message);
  }
}

// Debounced save — many entries land back-to-back after a scrape batch,
// so coalescing writes keeps us from thrashing the filesystem.
function scheduleDiskCacheSave() {
  if (diskSaveTimer) return;
  diskSaveTimer = setTimeout(() => {
    diskSaveTimer = null;
    try {
      const out = {};
      for (const [id, entry] of scrapeCache.entries()) out[id] = entry;
      fs.writeFileSync(getDiskCachePath(), JSON.stringify(out));
    } catch (e) {
      console.log('[CSScrape] Disk cache save failed:', e.message);
    }
  }, DISK_SAVE_DEBOUNCE_MS);
}

function getCachedEntry(id) {
  return scrapeCache.get(id);
}

function isFresh(entry) {
  return !!(entry && (Date.now() - entry.scrapedAt) < SCRAPE_TTL_MS);
}

// Store a freshly-scraped entry and schedule a disk flush.
function setCachedEntry(id, data) {
  scrapeCache.set(id, { scrapedAt: Date.now(), schema: CACHE_SCHEMA_VERSION, data });
  scheduleDiskCacheSave();
}

// Mutate an existing entry in place (top-up path) and flush. Does not
// reset scrapedAt — the entry's freshness window is still the original.
function patchCachedEntry(id, patchedData) {
  const existing = scrapeCache.get(id);
  if (!existing) return;
  existing.data = patchedData;
  existing.schema = CACHE_SCHEMA_VERSION;
  scheduleDiskCacheSave();
}

function cacheSize() { return scrapeCache.size; }

module.exports = {
  SCRAPE_TTL_MS,
  CACHE_SCHEMA_VERSION,
  loadDiskCache,
  scheduleDiskCacheSave,
  getCachedEntry,
  isFresh,
  setCachedEntry,
  patchCachedEntry,
  cacheSize,
  getDiskCachePath,
};
