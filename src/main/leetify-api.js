const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");

const BASE_URL = "https://api-public.cs-prod.leetify.com/v3/profile";
let statusReporter = null;
function setStatusReporter(fn) { statusReporter = fn; }
function reportStatus(state) { if (statusReporter) statusReporter('leetify', state); }
let keys = [process.env.LEETIFY_API_KEY, process.env.LEETIFY_API_KEY_2].filter(Boolean);
let currentKeyIndex = 0;
let LEETIFY_SAMPLE_LOGGED = false;

function setLeetifyKey(key) {
  if (key && !keys.includes(key)) keys.unshift(key);
}

function setLeetifyKey2(key) {
  if (key && !keys.includes(key)) keys.push(key);
}

// Sequential request queue with throttling so we don't burst on Leetify
const REQUEST_GAP_MS = 350;       // min delay between requests
const MAX_RETRIES = 3;            // exponential backoff retries on 429
let lastRequestAt = 0;
let queueChain = Promise.resolve();

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function rawGet(url, key) {
  return new Promise((resolve) => {
    const headers = { Accept: "application/json" };
    if (key) headers["Authorization"] = `Bearer ${key}`;
    const req = https.get(url, { headers }, (res) => {
      let data = "";
      let size = 0;
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > 5 * 1024 * 1024) {
          req.destroy(new Error("Response too large"));
          return;
        }
        data += chunk;
      });
      res.on("end", () => {
        if (res.statusCode === 429) return resolve({ status: 429 });
        if (res.statusCode !== 200) return resolve({ status: res.statusCode });
        try { resolve({ status: 200, data: JSON.parse(data) }); }
        catch { resolve({ status: 200, data: null }); }
      });
      res.on("error", () => resolve({ status: 0 }));
    });
    req.on("error", () => resolve({ status: 0 }));
    req.setTimeout(15000, () => req.destroy(new Error("timeout")));
  });
}

// Returns: data object on success, 'RATE_LIMITED' on persistent 429, null on 404/error
function leetifyGet(url) {
  // Chain requests so they run sequentially with a min gap between them
  const task = queueChain.then(async () => {
    const wait = lastRequestAt + REQUEST_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);

    let keyAttempts = 0;
    let backoff = 800;
    for (let retry = 0; retry <= MAX_RETRIES; retry++) {
      const key = keys[currentKeyIndex] || '';
      const result = await rawGet(url, key);
      lastRequestAt = Date.now();

      if (result.status === 200) { reportStatus('ok'); return result.data; }
      if (result.status === 502 || result.status === 503 || result.status === 504 || result.status === 0) { reportStatus('down'); return null; }
      if (result.status === 404) { reportStatus('ok'); return null; }
      if (result.status === 429) {
        // Try rotating keys first
        if (keys.length > 1 && keyAttempts < keys.length - 1) {
          currentKeyIndex = (currentKeyIndex + 1) % keys.length;
          keyAttempts++;
          console.log(`[Leetify] 429 — rotating to key ${currentKeyIndex + 1}`);
          continue;
        }
        // All keys exhausted (or none) → exponential backoff
        if (retry < MAX_RETRIES) {
          console.log(`[Leetify] 429 — backing off ${backoff}ms (retry ${retry + 1}/${MAX_RETRIES})`);
          await sleep(backoff);
          backoff *= 2;
          continue;
        }
        reportStatus('rate_limited');
        return 'RATE_LIMITED';
      }
      return null;
    }
    reportStatus('rate_limited');
    return 'RATE_LIMITED';
  });
  queueChain = task.catch(() => {});
  return task;
}

async function getLeetifyData(steamId) {
  // v3 is public — works with or without an API key. Key is attached if
  // available so we get higher rate limits, but absence isn't fatal.
  const key = keys[currentKeyIndex] || '';
  let data = null;
  const raw = await rawGet(`${BASE_URL}?steam64_id=${encodeURIComponent(steamId)}`, key);
  if (raw.status === 200) data = raw.data;
  else if (raw.status === 429) return 'RATE_LIMITED';
  if (!data) {
    const mini = await leetifyGet(`https://api.leetify.com/api/mini-profiles/${encodeURIComponent(steamId)}`);
    if (mini === 'RATE_LIMITED') return 'RATE_LIMITED';
    if (mini && typeof mini === 'object') return mapMiniProfile(mini);
    return null;
  }

  const r = data.rating || {};
  const s = data.stats || {};
  const ranks = data.ranks || {};

  // Extract per-map stats + peak premier/comp from recent_matches
  let peakPremier = ranks.premier || null;
  let lastPremier = ranks.premier || null;
  let peakCompRank = null;
  let lastCompRank = null;
  const mapAgg = {};
  // Recent winrate: matches Leetify's profile display of "Data from last 30
  // matches". We sort recent_matches by finished_at descending and take the
  // first 30 — same slice the UI uses — then count W/L (ties/unknown skipped).
  let rWins = 0, rTotal = 0;
  let rRatingSum = 0, rRatingCount = 0;
  const rmRaw = Array.isArray(data.recent_matches) ? data.recent_matches : [];

  // Still process the full list for map stats + rank peaks (unchanged behavior).
  for (const m of rmRaw) {
    if (m.rank != null && m.rank >= 1000) {
      if (!lastPremier) lastPremier = m.rank;
      if (m.rank > (peakPremier || 0)) peakPremier = m.rank;
    } else if (m.rank != null && m.rank > 0) {
      if (!lastCompRank) lastCompRank = m.rank;
      if (m.rank > (peakCompRank || 0)) peakCompRank = m.rank;
    }
    if (m.leetify_rating != null) { rRatingSum += m.leetify_rating; rRatingCount++; }
    if (m.map_name) {
      const key = m.map_name.toLowerCase().replace(/^de_/, '');
      if (!mapAgg[key]) mapAgg[key] = { map: m.map_name, matches: 0, wins: 0, totalRating: 0, ratingCount: 0 };
      mapAgg[key].matches++;
      const o = typeof m.outcome === 'string' ? m.outcome.toLowerCase().trim() : '';
      if (/^(win|won|victory|w)$/.test(o)) mapAgg[key].wins++;
      if (m.leetify_rating != null) {
        mapAgg[key].totalRating += m.leetify_rating;
        mapAgg[key].ratingCount++;
      }
    }
  }

  // Sort a copy by finished_at descending (newest first), slice to 30, count.
  const rmSorted = rmRaw.slice().sort((a, b) => {
    const ta = Date.parse(a?.finished_at) || 0;
    const tb = Date.parse(b?.finished_at) || 0;
    return tb - ta;
  });
  const last30 = rmSorted.slice(0, 30);

  // Debug: write the full last-30 slice to a file in userData once per process
  // so we can compare it directly against the Leetify profile page.
  // Electron GUI apps don't have attached stdout on Windows, so console.log
  // from the forked worker isn't visible — a file is the only reliable way.
  if (!LEETIFY_SAMPLE_LOGGED && last30.length > 0) {
    LEETIFY_SAMPLE_LOGGED = true;
    try {
      const outcomes = {};
      const dataSources = {};
      const rankTypes = {};
      const lines = [];
      lines.push(`[Leetify] steamId=${steamId}`);
      lines.push(`[Leetify] raw recent_matches length=${rmRaw.length}, last30 length=${last30.length}`);
      lines.push(`[Leetify] top-level winrate=${data.winrate}, total_matches=${data.total_matches}`);
      lines.push(`[Leetify] sample recent_match: ${JSON.stringify(last30[0]).slice(0, 800)}`);
      last30.forEach((m, i) => {
        const k = String(m?.outcome);
        outcomes[k] = (outcomes[k] || 0) + 1;
        const ds = String(m?.data_source);
        dataSources[ds] = (dataSources[ds] || 0) + 1;
        const rt = String(m?.rank_type);
        rankTypes[rt] = (rankTypes[rt] || 0) + 1;
        lines.push(`m${(i + 1).toString().padStart(2, '0')}: out=${m?.outcome} src=${m?.data_source} rankType=${m?.rank_type} score=${JSON.stringify(m?.score)} map=${m?.map_name} finished=${m?.finished_at}`);
      });
      lines.push(`outcome histogram: ${JSON.stringify(outcomes)}`);
      lines.push(`data_source histogram: ${JSON.stringify(dataSources)}`);
      lines.push(`rank_type histogram: ${JSON.stringify(rankTypes)}`);
      // Compute our winrate from last30 using the same formula as below
      let dWins = 0, dLoss = 0;
      for (const m of last30) {
        const o = typeof m.outcome === 'string' ? m.outcome.toLowerCase().trim() : '';
        if (/^(win|won|victory|w)$/.test(o)) dWins++;
        else if (/^(loss|lost|lose|defeat|l)$/.test(o)) dLoss++;
      }
      const dRate = (dWins + dLoss) > 0 ? Math.round((dWins / (dWins + dLoss)) * 100) : null;
      lines.push(`computed: wins=${dWins} losses=${dLoss} winrate=${dRate}%`);

      const dir = process.env.USER_DATA_DIR || os.tmpdir();
      const filePath = path.join(dir, process.env.LEETIFY_DEBUG_FILE || 'leetify-live.log');
      fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
      console.log('[Leetify] debug written to', filePath);
    } catch (e) {
      console.log('[Leetify] debug dump failed:', e.message);
    }
  }

  for (const m of last30) {
    const outcome = typeof m.outcome === 'string' ? m.outcome.toLowerCase().trim() : '';
    if (/^(win|won|victory|w)$/.test(outcome)) {
      rWins++; rTotal++;
    } else if (/^(loss|lost|lose|defeat|l)$/.test(outcome)) {
      rTotal++;
    }
    // tie/draw/unknown → skipped from both numerator and denominator
  }

  const recentWinRate = rTotal > 0 ? Math.round((rWins / rTotal) * 100) : null;
  const recentRating = rRatingCount > 0 ? +(rRatingSum / rRatingCount).toFixed(2) : null;
  const leetifyMapStats = {};
  for (const [key, val] of Object.entries(mapAgg)) {
    leetifyMapStats[key] = {
      map: val.map,
      matches: val.matches,
      wins: val.wins,
      winRate: val.matches > 0 ? Math.round((val.wins / val.matches) * 100) : 0,
      avgRating: val.ratingCount > 0 ? (val.totalRating / val.ratingCount) : null,
    };
  }

  return {
    aim: round(r.aim),
    positioning: round(r.positioning),
    utility: round(r.utility),
    opening: round(r.opening ? r.opening * 100 : null),
    clutch: round(r.clutch ? r.clutch * 100 : null),
    ctLeetify: round(r.ct_leetify ? r.ct_leetify * 100 : null),
    tLeetify: round(r.t_leetify ? r.t_leetify * 100 : null),
    accuracy: round(s.accuracy_enemy_spotted),
    headAccuracy: round(s.accuracy_head),
    sprayAccuracy: round(s.spray_accuracy),
    reactionTime: round(s.reaction_time_ms),
    counterStrafing: round(s.counter_strafing_good_shots_ratio),
    preaim: round(s.preaim),
    ctOpeningSuccess: round(s.ct_opening_duel_success_percentage),
    tOpeningSuccess: round(s.t_opening_duel_success_percentage),
    tradeKillSuccess: round(s.trade_kills_success_percentage),
    tradedDeathSuccess: round(s.traded_deaths_success_percentage),
    flashHitPerFlash: round(s.flashbang_hit_foe_per_flashbang),
    flashAvgDuration: round(s.flashbang_hit_foe_avg_duration),
    flashLeadingToKill: round(s.flashbang_leading_to_kill),
    heDamageAvg: round(s.he_foes_damage_avg),
    utilityOnDeath: round(s.utility_on_death_avg),
    leetifyRating: ranks.leetify != null ? round(ranks.leetify) : null,
    premier: ranks.premier,
    peakPremier,
    lastPremier,
    compRank: lastCompRank,
    peakCompRank,
    bestCompRank: Array.isArray(ranks.competitive) ? Math.max(...ranks.competitive.map(c => c.rank || 0)) : null,
    faceitLevel: ranks.faceit,
    faceitElo: ranks.faceit_elo,
    wingman: ranks.wingman,
    winRate: data.winrate ? round(data.winrate * 100) : null,
    totalMatches: data.total_matches,
    recentWinRate,
    recentRating,
    recentMatches: rTotal || null,
    name: data.name,
    mapStats: leetifyMapStats,
  };
}

function round(n) {
  return n != null ? parseFloat(Number(n).toFixed(2)) : null;
}

function mapMiniProfile(m) {
  const r = m.ratings || {};
  const ranks = Array.isArray(m.ranks) ? m.ranks : [];
  const findRank = (type) => {
    const found = ranks.find(x => x.type === type);
    return found ? found.skillLevel : null;
  };
  const wingmanEntry = ranks.find(x => x.dataSource === 'matchmaking_wingman');
  const compRanks = ranks.filter(x => x.dataSource === 'matchmaking' && x.type && x.type !== 'premier');
  const bestComp = compRanks.length > 0 ? Math.max(...compRanks.map(c => c.skillLevel || 0)) : null;
  // Sort recent matches by date desc, take last 30 (matches Leetify UI exactly).
  const recentRaw = Array.isArray(m.recentMatches) ? m.recentMatches : [];
  const recent = recentRaw.slice().sort((a, b) => {
    const ta = Date.parse(a?.finishedAt || a?.finished_at) || 0;
    const tb = Date.parse(b?.finishedAt || b?.finished_at) || 0;
    return tb - ta;
  }).slice(0, 30);
  // Count wins/losses only (ties and unknown results are excluded from BOTH
  // numerator and denominator — same convention Leetify's UI uses).
  let miniWins = 0, miniLosses = 0;
  for (const x of recent) {
    const res = typeof x.result === 'string' ? x.result.toLowerCase().trim() : '';
    if (/^(win|won|victory|w)$/.test(res)) miniWins++;
    else if (/^(loss|lost|lose|defeat|l)$/.test(res)) miniLosses++;
  }
  const miniDecided = miniWins + miniLosses;
  const miniRecentWinRate = miniDecided > 0 ? Math.round((miniWins / miniDecided) * 100) : null;
  // Debug: dump the mini-profile recent matches once per process for parity
  // with the v3 dump. Lets us see which result values actually come back.
  if (!LEETIFY_SAMPLE_LOGGED && recent.length > 0) {
    LEETIFY_SAMPLE_LOGGED = true;
    try {
      const lines = [];
      lines.push(`[Leetify/mini] name=${m.name}`);
      lines.push(`[Leetify/mini] raw recentMatches=${recentRaw.length}, last30=${recent.length}`);
      lines.push(`[Leetify/mini] sample: ${JSON.stringify(recent[0]).slice(0, 800)}`);
      recent.forEach((x, i) => {
        lines.push(`m${(i + 1).toString().padStart(2, '0')}: ${JSON.stringify(x).slice(0, 400)}`);
      });
      lines.push(`computed: wins=${miniWins} losses=${miniLosses} winrate=${miniRecentWinRate}%`);
      const dir = process.env.USER_DATA_DIR || os.tmpdir();
      fs.writeFileSync(path.join(dir, process.env.LEETIFY_DEBUG_FILE || 'leetify-live.log'), lines.join('\n') + '\n', 'utf8');
      console.log('[Leetify/mini] debug written');
    } catch (e) {
      console.log('[Leetify/mini] debug dump failed:', e.message);
    }
  }
  return {
    aim: round(r.aim),
    positioning: round(r.positioning),
    utility: round(r.utility),
    opening: round(r.opening != null ? r.opening * 100 : null),
    clutch: round(r.clutch != null ? r.clutch * 100 : null),
    ctLeetify: round(r.ctLeetify != null ? r.ctLeetify * 100 : null),
    tLeetify: round(r.tLeetify != null ? r.tLeetify * 100 : null),
    leetifyRating: r.leetify != null ? round(r.leetify * 100) : null,
    premier: findRank('premier'),
    peakPremier: findRank('premier'),
    lastPremier: findRank('premier'),
    compRank: bestComp,
    peakCompRank: bestComp,
    bestCompRank: bestComp,
    wingman: wingmanEntry ? wingmanEntry.skillLevel : null,
    totalMatches: r.gamesPlayed || null,
    // Lifetime winrate isn't in the mini-profile response, so we surface the
    // last-30 number as both lifetime and recent — it's the best we have.
    winRate: miniRecentWinRate,
    recentWinRate: miniRecentWinRate,
    recentMatches: miniDecided || null,
    name: m.name,
    mapStats: {},
    _source: 'mini-profile',
  };
}

module.exports = { getLeetifyData, setLeetifyKey, setLeetifyKey2, setStatusReporter };
