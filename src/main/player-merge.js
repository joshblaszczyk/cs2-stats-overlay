// Merge one scrapedData entry into one player object. Extracted from index.js
// where the same logic appeared twice: once after a csstats scrape completes
// (to patch live cachedPlayers), and again when the worker process sends a
// fresh player batch (to re-apply cached scrape results to the new objects).
//
// The scraper only produces partial data (fast paths first: steam/faceit/
// leetify) — csstats fills in premier, trust ratings, FACEIT nickname, and
// live FACEIT level/elo as fallbacks. This helper mutates `player` in place.

function mergeScrapedIntoPlayer(player, sd) {
  if (!player || !sd) return;

  // Premier rank: prefer leetify, fall back to the csstats scrape. gcPremier
  // is the display field the renderer reads (legacy name, kept for
  // compatibility with existing columns).
  if (!player.gcPremier && !player.leetify?.premier && sd.premier) {
    player.gcPremier = sd.premier;
  }
  if (sd.peakPremier) player.csstatsPeakPremier = sd.peakPremier;
  if (sd.csstats) player.csstats = sd.csstats;

  // csrep.gg trust rating + metrics + account block. Only apply if the
  // scraper actually got a response — otherwise leaving the field undefined
  // lets the UI decide whether to show "--" vs hide the row.
  if (sd.csrepTrust != null || sd.csrepAnomalies != null) {
    player.csrep = {
      trust: sd.csrepTrust,
      anomalies: sd.csrepAnomalies,
      sba: sd.csrepSba,
      metrics: sd.csrepMetrics || null,
      account: sd.csrepAccount || null,
    };
  }

  // csstats scrapes the FACEIT nickname + level off the public profile page.
  // Apply as a fallback only — if the FACEIT API already gave us richer data
  // we don't want to overwrite it with the scrape's minimal fields.
  if (sd.faceitNickname || sd.faceitLevel != null) {
    player.faceit = player.faceit || {};
    if (!player.faceit.nickname && sd.faceitNickname) {
      player.faceit.nickname = sd.faceitNickname;
    }
    if (player.faceit.level == null && sd.faceitLevel != null) {
      player.faceit.level = sd.faceitLevel;
    }
    if (!player.faceit.faceitUrl && sd.faceitNickname) {
      player.faceit.faceitUrl = `https://www.faceit.com/en/players/${sd.faceitNickname}`;
    }
  }

  // FACEIT public-endpoint lookup (elo + rank). Runs unconditionally when
  // present since it's keyless and can supplement either API or scrape data.
  if (sd.faceitPublic) {
    player.faceit = { ...(player.faceit || {}), ...sd.faceitPublic };
  }
}

module.exports = { mergeScrapedIntoPlayer };
