const https = require("https");

let API_KEY = process.env.FACEIT_API_KEY || "";

function setFaceitKey(key) {
  API_KEY = key;
}

function faceitGet(url, { useKey = true } = {}) {
  return new Promise((resolve) => {
    const headers = { "User-Agent": "Mozilla/5.0" };
    if (useKey && API_KEY) headers.Authorization = `Bearer ${API_KEY}`;
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
        try {
          resolve(res.statusCode === 200 ? JSON.parse(data) : null);
        } catch {
          resolve(null);
        }
      });
      res.on("error", () => resolve(null));
    });
    req.on("error", () => resolve(null));
    req.setTimeout(15000, () => req.destroy(new Error("timeout")));
  });
}

// Public no-auth endpoint: faceit.com/api/users/v1/nicknames/{nickname}
// Returns level + elo + region for active FACEIT CS2 players.
// Caller must supply the nickname — Steam ID → nickname lookup requires the paid API.
async function getFaceitPublicByNickname(nickname) {
  if (!nickname) return null;
  const detail = await faceitGet(
    `https://www.faceit.com/api/users/v1/nicknames/${encodeURIComponent(nickname)}`,
    { useKey: false }
  );
  const p = detail?.payload;
  if (!p) return null;
  const cs = p.games?.cs2 || p.games?.csgo || {};
  return {
    faceitId: p.id || null,
    nickname: p.nickname || nickname,
    country: p.country || null,
    level: cs.skill_level || null,
    elo: cs.faceit_elo || null,
    region: cs.region || null,
    faceitUrl: `https://www.faceit.com/en/players/${encodeURIComponent(p.nickname || nickname)}`,
  };
}

async function getFaceitPlayer(steamId) {
  let data = await faceitGet(
    `https://open.faceit.com/data/v4/players?game=cs2&game_player_id=${encodeURIComponent(steamId)}`
  );
  if (!data || !data.player_id) {
    data = await faceitGet(
      `https://open.faceit.com/data/v4/players?game=csgo&game_player_id=${encodeURIComponent(steamId)}`
    );
  }
  if (!data || !data.player_id) return null;

  const csGame = data.games?.cs2 || data.games?.csgo || {};

  return {
    faceitId: data.player_id,
    nickname: data.nickname,
    country: data.country,
    level: csGame.skill_level || null,
    elo: csGame.faceit_elo || null,
    region: csGame.region || null,
    faceitUrl: data.faceit_url?.replace("{lang}", "en") || null,
  };
}

async function getFaceitStats(faceitId) {
  let data = await faceitGet(
    `https://open.faceit.com/data/v4/players/${encodeURIComponent(faceitId)}/stats/cs2`
  );
  if (!data || !data.lifetime) {
    data = await faceitGet(
      `https://open.faceit.com/data/v4/players/${encodeURIComponent(faceitId)}/stats/csgo`
    );
  }
  if (!data || !data.lifetime) return null;

  const lt = data.lifetime;

  // Parse per-map stats from segments
  const mapStats = {};
  if (data.segments && Array.isArray(data.segments)) {
    for (const seg of data.segments) {
      if (seg.type === 'Map' && seg.label && seg.stats) {
        const s = seg.stats;
        mapStats[seg.label.toLowerCase().replace('de_', '')] = {
          map: seg.label,
          matches: parseInt(s["Matches"] || "0"),
          wins: parseInt(s["Wins"] || "0"),
          winRate: s["Win Rate %"] || "0",
          kd: s["Average K/D Ratio"] || "0",
          headshots: s["Average Headshots %"] || "0",
          adr: s["ADR"] || null,
        };
      }
    }
  }

  return {
    matches: parseInt(lt["Matches"] || "0"),
    wins: parseInt(lt["Wins"] || "0"),
    winRate: lt["Win Rate %"] || "0",
    kd: lt["Average K/D Ratio"] || "0",
    headshots: lt["Average Headshots %"] || "0",
    adr: lt["ADR"] || null,
    longestWinStreak: lt["Longest Win Streak"] || "0",
    entryRate: lt["Entry Rate"] || null,
    entrySuccessRate: lt["Entry Success Rate"] || null,
    flashSuccessRate: lt["Flash Success Rate"] || null,
    utilDmgPerRound: lt["Utility Damage per Round"] || null,
    sniperKillRate: lt["Sniper Kill Rate"] || null,
    clutch1v1: lt["1v1 Win Rate"] || null,
    clutch1v2: lt["1v2 Win Rate"] || null,
    mapStats,
  };
}

async function getFaceitEloHistory(faceitId) {
  // Get last 20 matches to find peak ELO
  const data = await faceitGet(
    `https://open.faceit.com/data/v4/players/${encodeURIComponent(faceitId)}/history?game=cs2&offset=0&limit=20`
  );
  if (!data || !data.items) return null;

  let peakElo = 0;
  // Each match has teams with players - find our player's elo per match
  for (const match of data.items) {
    for (const team of ['faction1', 'faction2']) {
      const faction = match.teams?.[team];
      if (!faction?.players) continue;
      const me = faction.players.find(p => p.player_id === faceitId);
      if (me && me.faceit_elo > peakElo) {
        peakElo = me.faceit_elo;
      }
    }
  }
  return peakElo > 0 ? peakElo : null;
}

// Main entry. If no API key is set, uses the public nickname endpoint when
// a nickname is known (typically scraped from csstats.gg). Otherwise returns
// null — without a key there's no way to resolve steamid → faceit identity.
async function getFaceitData(steamId, { nickname } = {}) {
  if (!API_KEY) {
    try {
      return await getFaceitPublicByNickname(nickname);
    } catch (err) {
      console.error(`[FACEIT-public] Error for ${nickname || steamId}:`, err.message);
      return null;
    }
  }

  // With an API key: full pipeline (steamid → player → stats + peak elo).
  try {
    const player = await getFaceitPlayer(steamId);
    if (!player) {
      return nickname ? await getFaceitPublicByNickname(nickname) : null;
    }
    const [stats, peakElo] = await Promise.all([
      getFaceitStats(player.faceitId),
      getFaceitEloHistory(player.faceitId),
    ]);
    return { ...player, stats, peakElo };
  } catch (err) {
    console.error(`[FACEIT] Error for ${steamId}:`, err.message);
    if (nickname) {
      try { return await getFaceitPublicByNickname(nickname); } catch {}
    }
    return null;
  }
}

module.exports = { setFaceitKey, getFaceitData, getFaceitPublicByNickname };
