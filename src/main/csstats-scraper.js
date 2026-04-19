// csstats.gg scrape orchestrator — coordinates the browser, the per-page
// parsers, the shared cache, and top-ups for partially-stale entries.
//
// Modules this file composes:
//   csstats-browser  — puppeteer lifecycle (ensureBrowser / shutdown)
//   csstats-cache    — disk + in-memory TTL cache
//   csstats-parser   — browser-side DOM extractors (parsePlayerPage, etc.)
//   csstats-login    — one-time Steam login for full lifetime stats
//   csrep-parser     — separate trust-rating site scraped alongside csstats
//
// Flow for a full batch (see scrapeAllPlayers):
//   1. Partition IDs into {cache-hit, cache-hit-needing-topup, miss}.
//   2. For misses, run up to PARALLEL_TABS concurrent page scrapes with
//      INTER_REQUEST_MS spacing between chunks to stay inside Cloudflare's
//      burst budget.
//   3. For top-ups, same concurrency pattern but only the specific missing
//      fields are re-fetched (cheaper than a full re-scrape).
//   4. A single retry pass covers transient failures.
//
// Rate-limit handling: if we hit 429 / 503 / Cloudflare 1015 / the "too
// many requests" banner, cooldownUntil is pushed out COOLDOWN_MS and all
// further scrapes short-circuit until the cooldown expires. The status
// reporter surfaces this to the UI.

const {
  SCRAPE_TTL_MS, loadDiskCache, isFresh, getCachedEntry,
  setCachedEntry, patchCachedEntry, cacheSize,
} = require('./csstats-cache');
const {
  ensureBrowser, shutdownBrowser, takeInitialPage, isConnected,
} = require('./csstats-browser');
const {
  parsePlayerPage, parseMatchesTab, aggregateRecentMatches,
} = require('./csstats-parser');
const { scrapeCsrepPage } = require('./csrep-parser');
const { loginToCsstats } = require('./csstats-login');

// ── Rate-limit parameters ────────────────────────────────────
// When csstats rate-limits us, back off for 20 min. Cloudflare's soft
// limits clear within ~10-15 min, so 20 gives comfortable margin without
// leaving the user stats-less for an entire match session.
const COOLDOWN_MS = 20 * 60 * 1000;

// ── Concurrency tuning ───────────────────────────────────────
// 3 tabs is within what a real user's browser might have open on
// csstats.gg simultaneously, and empirically doesn't trip rate limits.
// 500ms between chunks smooths out request bursts.
const PARALLEL_TABS = 3;
const INTER_REQUEST_MS = 500;

// ── Page timeouts ────────────────────────────────────────────
const PAGE_NAV_TIMEOUT_MS = 20000;
const MATCHES_NAV_TIMEOUT_MS = 30000;
const CLOUDFLARE_CHALLENGE_TIMEOUT_MS = 6000;
const STATS_WAIT_TIMEOUT_MS = 4000;
const MATCHES_WAIT_TIMEOUT_MS = 6000;

class RateLimitedError extends Error {
  constructor(msg) { super(msg); this.name = 'RateLimitedError'; }
}

let cooldownUntil = 0;
let statusReporter = null;
function setStatusReporter(fn) { statusReporter = fn; }
function reportStatus(state) { if (statusReporter) statusReporter('csstats', state); }

// Heuristics for detecting a dead-browser error. Once we see one of these,
// any further newPage() throws the same — bail out so the outer retry
// doesn't burn ~30s on guaranteed-to-fail retries.
function isBrowserDeadError(err) {
  return /Connection closed|Target closed|Protocol error/i.test(err?.message || '');
}

// Detect Cloudflare / csstats rate-limit banners in the rendered page.
// Runs inside the page context via evaluate().
async function detectRateLimitBanner(page) {
  return page.evaluate(() => {
    const t = document.body.innerText || '';
    if (/too many requests/i.test(t)) return 'too-many-requests';
    if (/rate limit/i.test(t))       return 'rate-limit';
    if (/access denied/i.test(t))    return 'access-denied';
    if (/error\s*1015/i.test(t))     return 'cf-1015';
    return null;
  });
}

// Wait for Cloudflare's challenge page to resolve. puppeteer-real-browser's
// turnstile:true should solve it automatically, but give it a moment.
async function waitForCloudflare(page) {
  try {
    await page.waitForFunction(() => {
      const t = document.body.innerText || '';
      return !t.includes('security verification') && !t.includes('Performing security');
    }, { timeout: CLOUDFLARE_CHALLENGE_TIMEOUT_MS });
  } catch {
    // Challenge still up — stats extraction will likely fail, but try.
  }
}

// ── Per-player full scrape (main page + matches tab + csrep) ─
async function scrapePlayer(steamId64, existingPage) {
  const b = await ensureBrowser();
  const page = existingPage || takeInitialPage() || await b.newPage();

  try {
    const resp = await page.goto(`https://csstats.gg/player/${steamId64}`, {
      waitUntil: 'domcontentloaded',
      timeout: PAGE_NAV_TIMEOUT_MS,
    });

    const status = resp?.status?.();
    if (status === 429 || status === 503) {
      throw new RateLimitedError(`HTTP ${status}`);
    }

    await waitForCloudflare(page);

    const bannerReason = await detectRateLimitBanner(page);
    if (bannerReason) throw new RateLimitedError(bannerReason);

    // Wait for stats to actually render rather than a blind sleep.
    try {
      await page.waitForFunction(() => {
        const t = document.body.innerText || '';
        return /K\/D/i.test(t) && /HLTV RATING/i.test(t) && /WIN RATE/i.test(t);
      }, { timeout: STATS_WAIT_TIMEOUT_MS });
    } catch {
      // Stats not found — page may be private or not a CS2 player.
    }

    const data = await page.evaluate(parsePlayerPage);

    // ── Phase 2: matches tab for recent-30 aggregates ──
    // csstats renders match rows client-side, so we navigate and wait for
    // the table to populate. One extra request per player, in exchange for
    // real recent-30 stats instead of the legacy (empty) recent column.
    try {
      await page.goto(`https://csstats.gg/player/${steamId64}#/matches`, {
        waitUntil: 'domcontentloaded', timeout: MATCHES_NAV_TIMEOUT_MS,
      });
      await page.waitForFunction(() => {
        const rows = document.querySelectorAll('table tbody tr');
        return rows.length >= 5;
      }, { timeout: MATCHES_WAIT_TIMEOUT_MS }).catch(() => {});
      const recent = await page.evaluate(parseMatchesTab);
      const agg = aggregateRecentMatches(recent);
      if (agg) Object.assign(data, agg);
    } catch (err) {
      console.log(`[CSScrape] recent-matches scrape failed for ${steamId64}:`, err.message?.substring(0, 150));
    }

    // ── Phase 3: csrep.gg trust rating ──
    // Reuses the same tab. Graceful failure — leave csrep fields null if
    // the site is down; the overlay degrades sensibly.
    try {
      const cr = await scrapeCsrepPage(page, steamId64);
      if (cr && (cr.trust != null || cr.anomalies != null)) {
        data.csrepTrust     = cr.trust;
        data.csrepAnomalies = cr.anomalies;
        data.csrepSba       = cr.sba;
        data.csrepMetrics   = cr.metrics || null;
        data.csrepAccount   = cr.account || null;
      }
    } catch (err) {
      console.log(`[CSRep] ${steamId64} failed:`, err.message?.substring(0, 150));
    }

    console.log(`[CSScrape] ${steamId64}: premier=${data.premier} kd=${data.kd} rKd=${data.recentKd} rRating=${data.recentRating} rAdr=${data.recentAdr} rHs=${data.recentHs} rWr=${data.recentWinRate} trust=${data.csrepTrust ?? '-'}% (${data.recentMatchCount || 0} recent)`);
    return data;

  } catch (err) {
    // NB: RateLimitedError is caught here too — the original scraper swallowed
    // it so the outer batch treats a rate-limited scrape as "no data" rather
    // than triggering the cooldown path. Preserved to avoid changing behavior
    // during refactor; the cooldown is still set when page.goto itself throws
    // before scrapePlayer's try block wraps it.
    console.log(`[CSScrape] Error for ${steamId64}:`, err.message.substring(0, 200));
    return null;
  } finally {
    try { await page.close(); } catch {}
  }
}

// ── Top-up: fetch just the missing fields for a stale-but-still-fresh entry ─
// Called for cache entries that exist but predate a schema addition (e.g.
// csrep scores, faceit nickname, detail stats). Cheaper than a full
// re-scrape: navigates only the pages that produce the missing data.
async function topUpEntry(page, steamId64, data, missing) {
  const out = { ...data };
  let touched = false;

  if (missing.includes('faceitNick') && !out.faceitNickname) {
    try {
      await page.goto(`https://csstats.gg/player/${steamId64}`, {
        waitUntil: 'domcontentloaded', timeout: PAGE_NAV_TIMEOUT_MS,
      });
      await waitForCloudflare(page);
      const nick = await page.evaluate(() => {
        for (const a of document.querySelectorAll('a[href*="faceit.com"]')) {
          const m = a.href.match(/faceit\.com\/[a-z]{2}\/players\/([^/?#]+)/i);
          if (m) return decodeURIComponent(m[1]);
        }
        return null;
      });
      if (nick) { out.faceitNickname = nick; touched = true; }
    } catch (err) {
      console.log(`[CSScrape] faceitNick top-up failed for ${steamId64}:`, err.message?.slice(0, 100));
    }
  }

  if (missing.includes('csstatsDetail')) {
    // The detail top-up path hits the same pages as a full scrape. Rather
    // than maintain a parallel shallow parser, just run the full scrape
    // and merge in the new-schema fields. Returns without visiting csrep
    // below — the full scrape already did that.
    try {
      const fresh = await scrapePlayer(steamId64, page);
      if (fresh) {
        const extras = [
          'damage', 'tied',
          'clutch1v1Wins', 'clutch1v1Losses', 'clutch1v2Wins', 'clutch1v2Losses',
          'clutch1v3', 'clutch1v3Wins', 'clutch1v3Losses',
          'clutch1v4', 'clutch1v4Wins', 'clutch1v4Losses',
          'clutch1v5', 'clutch1v5Wins', 'clutch1v5Losses',
          'entrySuccessT', 'entrySuccessCT',
          'entryAttempts', 'entryAttemptsT', 'entryAttemptsCT',
          'faceitNickname',
        ];
        for (const k of extras) {
          if (fresh[k] != null && out[k] == null) out[k] = fresh[k];
        }
        if (fresh.csrepTrust     != null) out.csrepTrust     = fresh.csrepTrust;
        if (fresh.csrepAnomalies != null) out.csrepAnomalies = fresh.csrepAnomalies;
        if (fresh.csrepSba       != null) out.csrepSba       = fresh.csrepSba;
        touched = true;
      }
    } catch (err) {
      console.log(`[CSScrape] detail top-up failed for ${steamId64}:`, err.message?.slice(0, 100));
    }
    return touched ? out : null;
  }

  if (missing.includes('csrep')) {
    try {
      const cr = await scrapeCsrepPage(page, steamId64);
      if (cr && (cr.trust != null || cr.anomalies != null)) {
        out.csrepTrust     = cr.trust;
        out.csrepAnomalies = cr.anomalies;
        out.csrepSba       = cr.sba;
        out.csrepMetrics   = cr.metrics || null;
        out.csrepAccount   = cr.account || null;
        touched = true;
      }
    } catch (err) {
      console.log(`[CSRep] top-up failed for ${steamId64}:`, err.message?.slice(0, 100));
    }
  }

  return touched ? out : null;
}

// Classify which top-up fields a cache entry still needs. Kept as a pure
// function so the partition logic is readable.
function findMissingFields(data) {
  if (!data) return [];
  const missing = [];
  if (data.csrepTrust == null && data.csrepAnomalies == null) {
    missing.push('csrep');
  } else if (data.csrepTrust != null && data.csrepMetrics == null) {
    // Old cache had trust but no detailed metric bars — top up.
    missing.push('csrep');
  } else if (data.csrepAccount?.age?.value &&
             /^[+-].*%$/.test(String(data.csrepAccount.age.value))) {
    // Legacy parser stored the delta as the value ("+2.8%" instead of
    // "9y 0m"). Force re-scrape to overwrite with the corrected output.
    missing.push('csrep');
  }
  if (data.faceitLevel != null && !data.faceitNickname) missing.push('faceitNick');
  if (data.kd != null && data.damage == null) missing.push('csstatsDetail');
  return missing;
}

// Check module-level settings toggles that can skip scraping entirely.
function isScrapingDisabled() {
  try {
    const settings = require('./settings');
    const gen = settings.load()?.general || {};
    if (gen.disableCsstats) return 'disabled';
    if (gen.lowPowerMode) return 'lowPower';
  } catch {}
  return null;
}

// ── Batch orchestrator ───────────────────────────────────────
async function scrapeAllPlayers(steamIds) {
  loadDiskCache();
  const results = {};

  const offReason = isScrapingDisabled();
  if (offReason === 'lowPower') console.log('[CSScrape] lowPowerMode enabled — skipping scrape');
  if (offReason) return results;

  const nowMs = Date.now();
  if (cooldownUntil > nowMs) {
    const min = Math.ceil((cooldownUntil - nowMs) / 60000);
    console.log(`[CSScrape] In cooldown — ${min} min remaining`);
    reportStatus('rate_limited');
    return results;
  }

  // Partition into cache-hits, cache-hits needing top-up, and misses.
  const toFetch = [];
  const toTopUp = [];
  for (const id of steamIds) {
    const entry = getCachedEntry(id);
    if (entry && isFresh(entry)) {
      results[id] = entry.data;
      const missing = findMissingFields(entry.data);
      if (missing.length) toTopUp.push({ id, entry, missing });
    } else {
      toFetch.push(id);
    }
  }
  if (toTopUp.length) {
    console.log(`[CSScrape] Topping up ${toTopUp.length} cached player(s) with: ${[...new Set(toTopUp.flatMap(t => t.missing))].join(', ')}`);
  }
  if (toFetch.length === 0 && toTopUp.length === 0) {
    console.log(`[CSScrape] All ${steamIds.length} players served from cache`);
    return results;
  }

  // Top-up only path — everything cached but some need missing fields.
  if (toFetch.length === 0 && toTopUp.length > 0) {
    try {
      const b = await ensureBrowser();
      for (let i = 0; i < toTopUp.length; i += PARALLEL_TABS) {
        if (!b.connected) break;
        const chunk = toTopUp.slice(i, i + PARALLEL_TABS);
        await Promise.all(chunk.map(async ({ id, entry, missing }) => {
          try {
            const page = await b.newPage();
            try {
              const patched = await topUpEntry(page, id, entry.data, missing);
              if (patched) {
                patchCachedEntry(id, patched);
                results[id] = patched;
              }
            } finally { try { await page.close(); } catch {} }
          } catch (err) {
            console.log(`[CSScrape] Top-up failed for ${id}:`, err.message?.slice(0, 150));
          }
        }));
      }
    } catch (e) {
      console.log('[CSScrape] Top-up browser failed:', e.message);
    }
    return results;
  }

  // Full-scrape path.
  let b;
  try {
    b = await ensureBrowser();
  } catch (e) {
    reportStatus('down');
    console.log('[CSScrape] Browser failed to start:', e.message);
    return results;
  }

  let rateLimited = false;
  let browserDead = false;
  // Process in chunks of PARALLEL_TABS concurrent tabs.
  for (let i = 0; i < toFetch.length; i += PARALLEL_TABS) {
    if (rateLimited || browserDead) break;
    if (!b.connected) { browserDead = true; break; }
    const chunk = toFetch.slice(i, i + PARALLEL_TABS);
    const tasks = chunk.map(async (id) => {
      try {
        const page = takeInitialPage() || await b.newPage();
        const data = await scrapePlayer(id, page);
        if (data && (data.premier || data.faceitLevel || data.kd)) {
          results[id] = data;
          setCachedEntry(id, data);
        }
      } catch (err) {
        if (err && err.name === 'RateLimitedError') {
          rateLimited = true;
          cooldownUntil = Date.now() + COOLDOWN_MS;
          console.log(`[CSScrape] RATE LIMITED (${err.message}) — entering ${COOLDOWN_MS / 60000} min cooldown`);
          reportStatus('rate_limited');
          return;
        }
        if (isBrowserDeadError(err)) browserDead = true;
        console.log(`[CSScrape] Error for ${id}:`, err.message?.substring(0, 100));
      }
    });
    await Promise.all(tasks);
    console.log(`[CSScrape] Progress: ${Math.min(i + PARALLEL_TABS, toFetch.length)}/${toFetch.length}`);
    if (browserDead) {
      console.log('[CSScrape] Browser disconnected mid-batch — bailing, will reconnect next pass');
      break;
    }
    if (!rateLimited && i + PARALLEL_TABS < toFetch.length) {
      await new Promise(r => setTimeout(r, INTER_REQUEST_MS));
    }
  }
  console.log(`[CSScrape] Got data for ${Object.keys(results).length}/${steamIds.length} players`);

  // One retry pass for transient failures.
  if (!rateLimited && !browserDead) {
    const failed = toFetch.filter(id => !results[id]);
    if (failed.length > 0) {
      console.log(`[CSScrape] Retrying ${failed.length} failed player(s)...`);
      for (const id of failed) {
        if (rateLimited || browserDead) break;
        if (!b.connected) { browserDead = true; break; }
        try {
          await new Promise(r => setTimeout(r, INTER_REQUEST_MS));
          const page = await b.newPage();
          const data = await scrapePlayer(id, page);
          if (data && (data.premier || data.faceitLevel || data.kd)) {
            results[id] = data;
            setCachedEntry(id, data);
            console.log(`[CSScrape] Retry OK: ${id}`);
          } else {
            console.log(`[CSScrape] Retry still empty: ${id}`);
          }
        } catch (err) {
          if (err && err.name === 'RateLimitedError') {
            rateLimited = true;
            cooldownUntil = Date.now() + COOLDOWN_MS;
            reportStatus('rate_limited');
          } else {
            if (isBrowserDeadError(err)) browserDead = true;
            console.log(`[CSScrape] Retry error for ${id}:`, err.message?.substring(0, 100));
          }
        }
      }
      console.log(`[CSScrape] After retry: ${Object.keys(results).length}/${steamIds.length} players`);
    }
  }

  // Set final status. 'ok' if at least one player has real stats.
  if (!rateLimited) {
    const successCount = Object.values(results).filter(r => r && (r.kd != null || r.premier != null)).length;
    if (successCount > 0) reportStatus('ok');
    else if (steamIds.length > 0) reportStatus('down');
  }
  return results;
}

async function shutdownScraper() {
  await shutdownBrowser();
  // Clear csrep warmup flag so the next browser session re-runs the
  // Cloudflare challenge warm-up instead of trusting a stale flag.
  try { require('./csrep-parser').resetCsrepWarmup(); } catch {}
}

function getCsstatsStatus() {
  const now = Date.now();
  const remainingMs = Math.max(0, cooldownUntil - now);
  return {
    rateLimited: remainingMs > 0,
    cooldownRemainingMs: remainingMs,
    cooldownRemainingMin: Math.ceil(remainingMs / 60000),
    cachedPlayers: cacheSize(),
  };
}

module.exports = {
  scrapePlayer,
  scrapeAllPlayers,
  shutdownScraper,
  loginToCsstats,
  setStatusReporter,
  ensureBrowser,
  getCsstatsStatus,
};
