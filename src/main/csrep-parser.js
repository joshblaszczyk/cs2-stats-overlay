// csrep.gg page scraping. Extracted from csstats-scraper.js where the same
// ~90 lines of parsing appeared in both scrapePlayer (full scrape) and
// topUpEntry (add csrep to a cached entry).
//
// Two exports:
//   scrapeCsrepPage(page, steamId64) — navigate + wait + evaluate + return
//   parseDomInBrowser                 — the function passed to page.evaluate.
//
// parseDomInBrowser MUST be self-contained: page.evaluate serialises it via
// Function.prototype.toString and executes it inside the browser context, so
// it cannot reference any variable outside its own body.

function parseDomInBrowser() {
  const text = document.body.innerText || '';

  // Finds a "NN%" near a label within a character window. Used for trust,
  // anomalies, and SBA — these render as pill badges whose exact DOM shape
  // we don't want to depend on.
  const pctNear = (label, window = 180) => {
    const i = text.indexOf(label);
    if (i < 0) return null;
    const slice = text.slice(Math.max(0, i - window), i + window);
    const m = slice.match(/(\d{1,3}(?:\.\d+)?)\s*%/);
    return m ? parseFloat(m[1]) : null;
  };

  // Trust rating — try multiple extraction paths in order of specificity:
  //   1. SVG <text> containing "N% Trust Rating" (old ring layout)
  //   2. Any element text matching "N% Trust Rating" (redesign may have
  //      moved this to a non-SVG element)
  //   3. pctNear — any "%" within 180 chars of the label (loosest)
  // The "%" digit can live anywhere near "Trust Rating" — don't lock to
  // a single DOM shape because csrep restyles their cards periodically.
  let trust = null;
  let trustSource = null; // diagnostic: which path matched
  for (const t of document.querySelectorAll('svg text')) {
    const m = (t.textContent || '').match(/(\d{1,3})\s*%\s*Trust\s*Rating/i);
    if (m) { trust = parseInt(m[1]); trustSource = 'svg'; break; }
  }
  if (trust == null) {
    // Walk all elements — find one whose text contains the Trust Rating pattern.
    for (const el of document.querySelectorAll('*')) {
      const t = el.textContent || '';
      if (t.length > 500) continue; // skip big containers, want leaf-ish
      const m = t.match(/(\d{1,3}(?:\.\d+)?)\s*%\s*Trust\s*Rating/i);
      if (m) { trust = parseFloat(m[1]); trustSource = 'elem'; break; }
    }
  }
  if (trust == null) {
    const v = pctNear('Trust Rating');
    if (v != null) { trust = v; trustSource = 'pctNear'; }
  }

  const lines = text.split('\n').map(s => s.trim());
  const parseNum = (s) => {
    if (!s) return null;
    const m = String(s).match(/-?\d+(?:\.\d+)?/);
    return m ? parseFloat(m[0]) : null;
  };
  const parsePct = (s) => {
    if (!s) return null;
    const m = String(s).match(/(-?\d+(?:\.\d+)?)\s*%/);
    return m ? parseFloat(m[1]) : null;
  };

  // Each metric card renders as "{value}{unit}" then "{label}" on the next
  // line. When csrep flags a metric as anomalous, it inserts a delta
  // (e.g. "+1.14" / "-0.3%") and a verdict tag (e.g. "Highly Suspicious")
  // directly after the label, before the next metric's value starts:
  //   {value}
  //   {label}
  //   {delta}      ← optional
  //   {verdict}    ← optional
  //   {next value}
  // Walk for a known label, take its previous line as the value, and
  // peek the next 1-2 lines for delta+verdict. A delta starts with
  // + or -; a verdict is one of a small known set.
  const VERDICTS = new Set([
    'Highly Suspicious', 'Very Suspicious', 'Suspicious',
    'Slightly Suspicious', 'Normal', 'Legit', 'Clean',
    'Insufficient Data',
  ]);
  const DELTA_RE = /^[+-]\d+(?:\.\d+)?%?$/;
  const findMetric = (label) => {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i] === label) {
        const raw = lines[i - 1];
        const l1 = lines[i + 1];
        const l2 = lines[i + 2];
        let delta = null, verdict = null;
        if (l1 && DELTA_RE.test(l1)) {
          const m = l1.match(/(-?\d+(?:\.\d+)?)/);
          if (m) delta = parseFloat(m[1]);
          if (l2 && VERDICTS.has(l2)) verdict = l2;
        } else if (l1 && VERDICTS.has(l1)) {
          // Some metrics render a verdict with no delta.
          verdict = l1;
        }
        return { raw, delta, verdict };
      }
    }
    return { raw: null, delta: null, verdict: null };
  };
  const LABELS = [
    ['ttdMs',         'Time to Damage',   'num'],
    ['reactionMs',    'Reaction Time',    'num'],
    ['crosshairDeg',  'Crosshair Placement', 'num'],
    ['preaimDeg',     'Preaim',           'num'],
    ['kd',            'K/D Ratio',        'num'],
    ['adr',           'ADR',              'num'],
    ['aimAcc',        'Aim Accuracy',     'pct'],
    ['headAcc',       'Head Accuracy',    'pct'],
    ['wallbang',      'Wallbang Kill %',  'pct'],
    ['smoke',         'Smoke Kill %',     'pct'],
    ['hltvRating',    'HLTV Rating 2.0',  'num'],
    ['kast',          'KAST',             'pct'],
  ];
  const metrics = {};
  const metricDeltas = {};
  const metricVerdicts = {};
  for (const [key, label, kind] of LABELS) {
    const { raw, delta, verdict } = findMetric(label);
    metrics[key] = kind === 'pct' ? parsePct(raw) : parseNum(raw);
    if (delta   != null) metricDeltas[key]   = delta;
    if (verdict != null) metricVerdicts[key] = verdict;
  }

  // SBA is shown as just a delta on recent csrep layouts — there's no
  // absolute score next to the "Stats Based Analysis" label. Grab the
  // signed number that appears immediately after the label.
  let sbaDelta = null;
  {
    const i = lines.indexOf('Stats Based Analysis');
    if (i >= 0) {
      const next = lines[i + 1];
      if (next && DELTA_RE.test(next)) {
        const m = next.match(/(-?\d+(?:\.\d+)?)/);
        if (m) sbaDelta = parseFloat(m[1]);
      }
    }
  }

  // Account Reputation block — csrep's DOM order doesn't match reading order.
  // Verified via a live probe, lines look like:
  //   +2.8%          ← delta for ACCOUNT AGE
  //   ACCOUNT AGE    ← label (first)
  //   +2.4%          ← delta for CS2 HOURS (appears here, not after its label)
  //   9y 0m          ← value for ACCOUNT AGE (2 lines after its label)
  //   CS2 HOURS      ← label
  //   +0.0%          ← delta for INVENTORY VALUE
  //   0h             ← value for CS2 HOURS
  //   …
  // Rule: value_i = lines[pos_i + 2]. Delta for the first label is at pos-1;
  // for every later label it's at pos-2. An earlier parser used lines[pos-1]
  // as value, which pulled deltas into value slots (user-visible bug:
  // age showed "+2.8%" where "9y 0m" belonged).
  const ACCT_LABELS = [
    ['age',          'ACCOUNT AGE'],
    ['hours',        'CS2 HOURS'],
    ['inventory',    'INVENTORY VALUE'],
    ['level',        'STEAM LEVEL'],
    ['collectibles', 'COLLECTIBLES'],
  ];
  const account = {};
  const positions = ACCT_LABELS.map(([, lbl]) => lines.indexOf(lbl));
  for (let i = 0; i < ACCT_LABELS.length; i++) {
    const [key] = ACCT_LABELS[i];
    const pos = positions[i];
    if (pos < 0) { account[key] = { value: null, delta: null }; continue; }
    const value = lines[pos + 2] ?? null;
    // Guard: on private profiles some value slots collapse and pos+2 lands
    // on another known label — reject to avoid showing "CS2 HOURS" as an age.
    const valueClean = (value && ACCT_LABELS.some(([, l]) => l === value)) ? null : value;
    const deltaLine = (i === 0) ? lines[pos - 1] : lines[pos - 2];
    account[key] = { value: valueClean, delta: parsePct(deltaLine) };
  }

  // Diagnostic snippet — when trust is null the node side logs the first
  // 240 chars around "Trust Rating" so we can tell WHAT the site is
  // actually rendering (label changed? new percent format? etc.).
  let trustDebug = null;
  if (trust == null) {
    const idx = text.indexOf('Trust Rating');
    if (idx >= 0) {
      trustDebug = text.slice(Math.max(0, idx - 80), idx + 160).replace(/\s+/g, ' ');
    } else {
      trustDebug = 'NO_LABEL ' + text.slice(0, 200).replace(/\s+/g, ' ');
    }
  }

  return {
    trust,
    trustSource,
    trustDebug,
    anomalies: pctNear('Anomalies Detected'),
    sba: pctNear('Stats Based Analysis'),
    sbaDelta,
    metrics,
    metricDeltas,
    metricVerdicts,
    account,
  };
}

// csrep.gg sits behind an aggressive Cloudflare managed-challenge. The
// FIRST page load of any browser session triggers the full "Just a
// moment..." interstitial (can take 10-30s to solve). Subsequent loads
// reuse the cf_clearance cookie and pass straight through.
//
// Without pre-warming, the first player we scrape fails (timeout before
// the challenge is solved) while every later player succeeds. Since
// the roster usually places the local player first, the user-visible
// symptom is "cswatch doesn't detect me (and sometimes my first friend)."
//
// Session-scoped flag: pre-warm once per process. csstats-browser's
// ensureBrowser preserves cookies across tabs, so one warm-up covers
// all subsequent scrapePlayer calls.
let csrepWarmed = false;

const CHALLENGE_WAIT_MS       = 25000;  // initial wait for challenge + hydration
const CHALLENGE_RETRY_WAIT_MS = 20000;  // second attempt after warmup
const WARMUP_TIMEOUT_MS       = 30000;  // cap pre-warm so a stuck page doesn't block everything

// Navigate once to csrep.gg root and wait through the Cloudflare
// challenge. After this, the tab's cookie jar holds cf_clearance and
// subsequent /player/<id> loads don't re-challenge.
async function warmupCsrep(page) {
  if (csrepWarmed) return true;
  try {
    await page.goto('https://csrep.gg/', { waitUntil: 'domcontentloaded', timeout: WARMUP_TIMEOUT_MS });
    await page.waitForFunction(() => {
      const title = document.title || '';
      const txt = document.body?.innerText || '';
      if (/Just a moment/i.test(title) || /Enable JavaScript and cookies/i.test(txt)) return false;
      return txt.length > 100; // real content rendered
    }, { timeout: CHALLENGE_WAIT_MS }).catch(() => {});
    csrepWarmed = true;
    console.log('[CSRep] Cloudflare pre-warm succeeded');
    return true;
  } catch (err) {
    console.log('[CSRep] Pre-warm failed:', err.message?.slice(0, 120));
    return false;
  }
}

// Wait for the player page to clear CF and hydrate, or timeout.
// Returns true if content is ready, false on timeout.
//
// Readiness signal: "Stats Based Analysis" — a label that only appears
// inside the player data block (not the landing page chrome). It renders
// for every profile shape we've seen:
//   • healthy profile:      "96%Trust Rating … Stats Based Analysis"
//   • insufficient-data:    "--Trust Rating … Stats Based Analysis (N games)"
//   • fully private:        block may still render with all "Insufficient Data"
// Using a bare /Trust Rating/ or /Player Reputation/ match is too loose:
// both strings also appear in the landing hero tagline and nav chrome
// BEFORE the player stats block hydrates, which caused premature parse
// runs that captured an empty DOM.
async function waitForPlayerPage(page, timeoutMs) {
  return page.waitForFunction(() => {
    const title = document.title || '';
    const txt = document.body?.innerText || '';
    if (/Just a moment/i.test(title) || /Enable JavaScript and cookies/i.test(txt)) return false;
    return /Stats Based Analysis/i.test(txt);
  }, { timeout: timeoutMs }).then(() => true).catch(() => false);
}

// Navigate the provided page to csrep.gg for the given SteamID, wait for
// the SPA to hydrate, then extract fields. Returns an object with nulls
// on failure so callers can degrade gracefully.
async function scrapeCsrepPage(page, steamId64) {
  // Pre-warm once so the first real player scrape doesn't take the CF hit.
  if (!csrepWarmed) await warmupCsrep(page);

  await page.goto(`https://csrep.gg/player/${steamId64}`, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });

  let ready = await waitForPlayerPage(page, CHALLENGE_WAIT_MS);

  // Retry path: if we're still stuck on CF after the first wait, the
  // warmup didn't catch cf_clearance (common on cold browser starts).
  // Re-warmup + retry once — this rescues the rare stuck-first-scrape.
  if (!ready) {
    csrepWarmed = false;
    const warmed = await warmupCsrep(page);
    if (warmed) {
      try {
        await page.goto(`https://csrep.gg/player/${steamId64}`, {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        });
        ready = await waitForPlayerPage(page, CHALLENGE_RETRY_WAIT_MS);
      } catch {}
    }
  }

  if (!ready) {
    // Diagnostic: the text snippet tells us whether we're still on CF,
    // a 404-profile page, or something unexpected.
    try {
      const diag = await page.evaluate(() => ({
        title: document.title,
        snippet: (document.body?.innerText || '').slice(0, 200).replace(/\s+/g, ' '),
      }));
      console.log(`[CSRep] wait timeout for ${steamId64} — title="${diag.title}" snippet="${diag.snippet}"`);
    } catch {}
  }

  const result = await page.evaluate(parseDomInBrowser);
  // Log the one-time diagnostic when the parser finds the Trust Rating
  // label but can't pull a percentage out of it. This is the symptom
  // when csrep.gg changes DOM shape and our extractor's regex misses.
  if (result && result.trust == null && result.trustDebug) {
    console.log(`[CSRep] parse miss for ${steamId64} — snippet="${result.trustDebug}"`);
  } else if (result && result.trust != null) {
    console.log(`[CSRep] ${steamId64}: trust=${result.trust}% (source=${result.trustSource})`);
  }
  delete result.trustDebug;
  delete result.trustSource;
  return result;
}

// Reset warmup state — called by the scraper shutdown path so the next
// cold browser session re-runs the pre-warm instead of trusting a stale flag.
function resetCsrepWarmup() { csrepWarmed = false; }

module.exports = { scrapeCsrepPage, parseDomInBrowser, warmupCsrep, resetCsrepWarmup };
