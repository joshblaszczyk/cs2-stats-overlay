const https = require("https");
const { getFaceitData } = require("./faceit-api");
const { getLeetifyData } = require("./leetify-api");

let API_KEY = process.env.STEAM_API_KEY || "";

function setApiKey(key) {
  API_KEY = key;
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
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
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error("Failed to parse Steam API response"));
        }
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(15000, () => req.destroy(new Error("timeout")));
  });
}

// ─── Steam API Endpoints ─────────────────────────────────────

async function getPlayerSummaries(steamIds) {
  const ids = steamIds.map(encodeURIComponent).join(",");
  const url = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${encodeURIComponent(API_KEY)}&steamids=${ids}`;
  const data = await httpGet(url);
  return data.response?.players || [];
}

// CS2 lifetime stats (kills, deaths, headshots, accuracy, damage, etc.)
async function getCS2Stats(steamId) {
  const url = `https://api.steampowered.com/ISteamUserStats/GetUserStatsForGame/v2/?key=${encodeURIComponent(API_KEY)}&steamid=${encodeURIComponent(steamId)}&appid=730`;
  try {
    const data = await httpGet(url);
    return parseCS2Stats(data.playerstats?.stats || []);
  } catch {
    return null;
  }
}

// One GetOwnedGames call gives us both CS2 hours and total game count.
// Previously two separate calls hit the same endpoint — wasted ~16% of the
// per-player budget.
async function getPlaytimeAndOwnedCount(steamId) {
  const url = `https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${encodeURIComponent(API_KEY)}&steamid=${encodeURIComponent(steamId)}&include_played_free_games=1`;
  try {
    const data = await httpGet(url);
    const games = data.response?.games || [];
    const cs2 = games.find(g => g.appid === 730);
    return {
      playtimeHours: cs2 ? Math.round(cs2.playtime_forever / 60) : null,
      ownedGamesCount: data.response?.game_count ?? null,
    };
  } catch {
    return { playtimeHours: null, ownedGamesCount: null };
  }
}

// Friend list count
async function getFriendCount(steamId) {
  const url = `https://api.steampowered.com/ISteamUser/GetFriendList/v1/?key=${encodeURIComponent(API_KEY)}&steamid=${encodeURIComponent(steamId)}`;
  try {
    const data = await httpGet(url);
    return data.friendslist?.friends?.length ?? null;
  } catch {
    return null; // Private friend list
  }
}

// Steam level
async function getSteamLevel(steamId) {
  const url = `https://api.steampowered.com/IPlayerService/GetSteamLevel/v1/?key=${encodeURIComponent(API_KEY)}&steamid=${encodeURIComponent(steamId)}`;
  try {
    const data = await httpGet(url);
    return data.response?.player_level ?? null;
  } catch {
    return null;
  }
}

// VAC bans, game bans, community bans
async function getPlayerBans(steamIds) {
  const ids = steamIds.map(encodeURIComponent).join(",");
  const url = `https://api.steampowered.com/ISteamUser/GetPlayerBans/v1/?key=${encodeURIComponent(API_KEY)}&steamids=${ids}`;
  try {
    const data = await httpGet(url);
    return data.players || [];
  } catch {
    return [];
  }
}

// ─── Stats Parser ────────────────────────────────────────────

function parseCS2Stats(stats) {
  const s = {};
  for (const stat of stats) s[stat.name] = stat.value;

  const kills = s["total_kills"] || 0;
  const deaths = s["total_deaths"] || 0;
  const headshots = s["total_kills_headshot"] || 0;

  return {
    kills,
    deaths,
    kd: deaths > 0 ? (kills / deaths).toFixed(2) : kills.toFixed(2),
    wins: s["total_wins"] || 0,
    rounds: s["total_rounds_played"] || 0,
    headshotPct: kills > 0 ? Math.round((headshots / kills) * 100) : 0,
    mvps: s["total_mvps"] || 0,
    damage: s["total_damage_done"] || 0,
    moneyEarned: s["total_money_earned"] || 0,
    shotsFired: s["total_shots_fired"] || 0,
    shotsHit: s["total_shots_hit"] || 0,
    accuracy: s["total_shots_fired"] > 0
      ? Math.round((s["total_shots_hit"] / s["total_shots_fired"]) * 100)
      : 0,
    bombsPlanted: s["total_planted_bombs"] || 0,
    bombsDefused: s["total_defused_bombs"] || 0,
    hostagesRescued: s["total_rescued_hostages"] || 0,
    knifeKills: s["total_kills_knife"] || 0,
    pistolRoundWins: s["total_wins_pistolround"] || 0,
  };
}

// ─── Smurf/Cheater Flags ─────────────────────────────────────

function detectFlags(player) {
  const flags = [];
  const l = player.leetify;
  const f = player.faceit;

  const accountAgeDays = player.accountCreated
    ? Math.floor((Date.now() - player.accountCreated.getTime()) / (1000 * 60 * 60 * 24))
    : null;
  const hoursNum = parseInt(player.hours);
  const kd = parseFloat(player.kd);
  const isNewAcct = accountAgeDays !== null && accountAgeDays < 180;
  const isLowHours = !isNaN(hoursNum) && hoursNum < 500;

  // ── Account flags ──────────────────────────────────────────
  if (isNewAcct) flags.push("NEW ACCT");
  if (player.steamLevel !== null && player.steamLevel <= 5) flags.push("LOW LVL");
  if (player.friendCount !== null && player.friendCount < 5) flags.push("FEW FRIENDS");
  if (player.ownedGames !== null && player.ownedGames <= 3) flags.push("FEW GAMES");

  // Everything private
  const privateCount = [
    player.friendCount === null,
    player.ownedGames === null,
    player.stats === null,
    player.hours === "Private",
  ].filter(Boolean).length;
  if (privateCount >= 3) flags.push("ALL PRIVATE");

  // ── Smurf detection (mechanical skill vs account age/hours) ──
  // Counter-strafe is the #1 smurf indicator — takes 1000+ hours of muscle memory
  if (l?.counterStrafing > 65 && isLowHours) {
    flags.push("SMURF? (counter-strafe)");
  }

  // High aim rating with low hours
  if (l?.aim > 70 && isLowHours) {
    flags.push("SMURF? (aim)");
  }

  // Fast reaction time with new account (legit avg is 200-300ms)
  if (l?.reactionTime && l.reactionTime < 250 && isNewAcct) {
    flags.push("SMURF? (reaction)");
  }

  // High K/D with low hours
  if (!isNaN(kd) && kd > 1.5 && !isNaN(hoursNum) && hoursNum < 300) {
    flags.push("SMURF? (K/D)");
  }

  // High FACEIT level with new/low-hour account
  if (f?.level >= 8 && isLowHours) {
    flags.push("SMURF? (FACEIT)");
  }

  // ── Rank-based smurf signals ───────────────────────────────
  const premier = l?.premier || l?.lastPremier || 0;
  const peakPrem = l?.peakPremier || premier;
  const compRank = l?.compRank || l?.bestCompRank || 0;

  // High Premier rank with low hours
  if (premier >= 18000 && isLowHours) {
    flags.push("SMURF? (premier rank)");
  }
  // Very high Premier on a young account regardless of hours
  if (premier >= 15000 && isNewAcct) {
    flags.push("SMURF? (premier/age)");
  }
  // Peak Comp rank at ceiling (17-18 = Global) on new/low-hour acct
  if (compRank >= 17 && (isNewAcct || isLowHours)) {
    flags.push("SMURF? (comp rank)");
  }
  // Huge gap between peak and current premier (decayed smurf or rank-boosted)
  if (peakPrem > 0 && premier > 0 && peakPrem - premier >= 4000) {
    flags.push("RANK DECAY");
  }
  // Aim too high for the rank (likely smurf OR cheating at lower MMR)
  if (l?.aim > 88 && premier > 0 && premier < 13000 && l?.totalMatches > 20) {
    flags.push("SMURF? (aim vs rank)");
  }
  // FACEIT level 9+ while Premier is under 15k = plays FACEIT, smurfs Valve MM
  if (f?.level >= 9 && premier > 0 && premier < 15000) {
    flags.push("SMURF? (FACEIT vs MM)");
  }

  // ── Cheat detection ────────────────────────────────────────
  // Based on pro benchmarks: even NiKo/donk rarely exceed 55% HS sustained.
  // s1mple: 38-42% HS, 1.25-1.30 K/D, 85-90 ADR
  // Thresholds set above what any pro sustains over many matches.

  // HS% over 60% sustained is beyond pro level (NiKo peaks ~55%)
  if (l?.headAccuracy > 60 && l?.totalMatches > 30) {
    flags.push("SUS HS%");
  }

  // Reaction time under 150ms is inhuman (aimbot snap)
  if (l?.reactionTime && l.reactionTime < 150) {
    flags.push("SUS REACTION");
  }

  // ── Composite suspicion score ──────────────────────────────
  // No single stat is proof. Flag when MULTIPLE red flags combine.
  // This catches the "too good across the board" pattern.
  let suspicionScore = 0;
  if (l?.headAccuracy > 50 && l?.totalMatches > 20) suspicionScore++;
  if (l?.accuracy > 45 && l?.totalMatches > 20) suspicionScore++;
  if (!isNaN(kd) && kd > 2.0) suspicionScore++;
  if (l?.reactionTime && l.reactionTime < 200) suspicionScore++;
  if (isNewAcct) suspicionScore++;
  if (isLowHours) suspicionScore++;
  if (privateCount >= 3) suspicionScore++;
  if (premier >= 18000 && isLowHours) suspicionScore++;
  if (f?.level >= 9 && isLowHours) suspicionScore++;
  if (l?.aim > 88 && premier > 0 && premier < 13000) suspicionScore++;

  if (suspicionScore >= 4) {
    flags.push("LIKELY CHEATING");
  } else if (suspicionScore >= 3 && (isNewAcct || isLowHours)) {
    flags.push("SUS (multiple flags)");
  }

  // ── Ban flags ──────────────────────────────────────────────
  if (player.bans?.VACBanned) {
    flags.push(`VAC BAN (${player.bans.DaysSinceLastBan}d ago)`);
  }
  if (player.bans?.NumberOfGameBans > 0) {
    flags.push(`GAME BAN x${player.bans.NumberOfGameBans}`);
  }

  return [...new Set(flags)];
}

// ─── Player Cache ────────────────────────────────────────────
// In-memory cache (fast, per-session) + file cache (persistent, for Leetify/FACEIT)
// In-memory cache only — wiped between matches. Leetify TOS prohibits
// persistent storage of their data, so there's no disk cache here.
const playerCache = new Map();
function getCached(steamId) { return playerCache.get(steamId) || null; }
function setCache(steamId, data) { playerCache.set(steamId, data); }
function clearCache() { playerCache.clear(); }

// ─── Main Fetch ──────────────────────────────────────────────

async function fetchAllPlayerStats(steamIds) {
  const players = [];

  // Split into cached and uncached
  const uncachedIds = steamIds.filter(id => !getCached(id));
  const cachedResults = steamIds.filter(id => getCached(id)).map(id => getCached(id));

  // Only fetch summaries/bans for uncached players
  let summaryMap = {};
  let banMap = {};

  if (uncachedIds.length > 0) {
    const [summaries, bans] = await Promise.all([
      getPlayerSummaries(uncachedIds).catch(() => []),
      getPlayerBans(uncachedIds).catch(() => []),
    ]);
    for (const s of summaries) summaryMap[s.steamid] = s;
    for (const b of bans) banMap[b.SteamId] = b;
  }

  // Phase 1: Fetch Steam + FACEIT — cap at 4 concurrent players to avoid rate limits
  const PLAYER_CONCURRENCY = 4;
  const results = [];
  for (let i = 0; i < uncachedIds.length; i += PLAYER_CONCURRENCY) {
    const chunk = uncachedIds.slice(i, i + PLAYER_CONCURRENCY);
    const chunkResults = await Promise.allSettled(chunk.map(async (id) => {
      const [cs2Stats, playtime, faceit, friendCount, steamLevel] = await Promise.all([
        getCS2Stats(id).catch(() => null),
        getPlaytimeAndOwnedCount(id).catch(() => ({ playtimeHours: null, ownedGamesCount: null })),
        getFaceitData(id).catch(() => null),
        getFriendCount(id).catch(() => null),
        getSteamLevel(id).catch(() => null),
      ]);
      const hours = playtime.playtimeHours;
      const ownedGames = playtime.ownedGamesCount;

      const summary = summaryMap[id];
      const accountCreated = summary?.timecreated
        ? new Date(summary.timecreated * 1000)
        : null;

      const mergedStats = cs2Stats || {};
      const kd = faceit?.stats?.kd || mergedStats.kd || "--";
      const hsPct = mergedStats.headshotPct ?? faceit?.stats?.headshots ?? "--";

      const player = {
        steamId: id,
        name: summary?.personaname || "Unknown",
        avatar: summary?.avatarmedium || "",
        profileUrl: summary?.profileurl || "",
        accountAge: accountCreated
          ? `${Math.floor((Date.now() - accountCreated.getTime()) / (1000 * 60 * 60 * 24 * 365))}y`
          : "?",
        accountCreated,
        hours: hours !== null ? `${hours}h` : "Private",
        friendCount,
        ownedGames,
        steamLevel,
        bans: banMap[id] || null,
        stats: cs2Stats,
        faceit,
        leetify: null, // filled in Phase 2 (not persisted per Leetify TOS)
        kd,
        hsPct,
        private: cs2Stats === null && !faceit,
      };

      player.flags = detectFlags(player);
      setCache(id, player);
      return player;
    }));
    for (const r of chunkResults) results.push(r);
  }

  // Add newly fetched players
  for (const r of results) {
    if (r.status === "fulfilled") {
      players.push(r.value);
    }
  }

  // Add cached players
  for (const p of cachedResults) {
    players.push(p);
  }

  // Sort: put players with more data first
  players.sort((a, b) => {
    const scoreA = (a.leetify ? 2 : 0) + (a.faceit ? 1 : 0);
    const scoreB = (b.leetify ? 2 : 0) + (b.faceit ? 1 : 0);
    return scoreB - scoreA;
  });

  return players;
}

// Phase 2: Fetch Leetify data in batches, returns updated players
// noLeetify tracks IDs we already know have no profile (avoid re-querying)
const noLeetify = new Set();

async function fetchLeetifyForPlayers(steamIds) {
  const toFetch = steamIds.filter(id => {
    const cached = getCached(id);
    // Fetch if: not yet cached (clear-cache arrived mid-fetch), or cached
    // but doesn't have leetify data yet, and not known to lack a profile.
    if (noLeetify.has(id)) return false;
    if (!cached) return true; // cache was cleared mid-fetch, still try
    return !cached.leetify;
  });

  console.log(`[Leetify] toFetch=${toFetch.length}/${steamIds.length} (noLeetify=${noLeetify.size}, cached=${steamIds.filter(id => getCached(id)).length})`);
  if (toFetch.length === 0) return [];

  const updated = [];
  for (let i = 0; i < toFetch.length; i += 5) {
    const batch = toFetch.slice(i, i + 5);
    const results = await Promise.allSettled(
      batch.map(id => getLeetifyData(id).catch(() => null))
    );
    let hitRateLimit = false;
    for (let j = 0; j < batch.length; j++) {
      const id = batch[j];
      const leetify = results[j].status === 'fulfilled' ? results[j].value : null;
      if (leetify === 'RATE_LIMITED') {
        hitRateLimit = true;
        // Don't add to noLeetify — we'll retry next time
      } else if (leetify && typeof leetify === 'object') {
        let player = getCached(id);
        if (!player) {
          // Cache was cleared mid-fetch — create minimal entry
          player = { steamId: id, name: leetify.name || 'Unknown', leetify: null };
        }
        player.leetify = leetify;
        player.flags = detectFlags(player);
        player.private = false;
        setCache(id, player);
        updated.push(player);
      } else {
        noLeetify.add(id); // Genuinely no profile
      }
    }
    // If rate limited, stop fetching more batches — wait for next cycle
    if (hitRateLimit) break;
    if (i + 5 < toFetch.length) await new Promise(r => setTimeout(r, 1000));
  }

  return updated;
}

function clearNoLeetify() { noLeetify.clear(); }

module.exports = { setApiKey, fetchAllPlayerStats, fetchLeetifyForPlayers, clearCache, clearNoLeetify };
