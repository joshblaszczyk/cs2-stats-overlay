// CS2 Game State Integration (GSI) HTTP server.
//
// CS2 POSTs a JSON snapshot of the current match to http://localhost:3000
// roughly 10 times per second. This file owns the HTTP plumbing + auth +
// state machine; the heavy per-tick logic (roster assembly, buy advice,
// demo integration) lives in gsi-roster.js, gsi-buy-advisor.js, and
// demo-parser.js so this file stays focused on dispatch.
//
// Callbacks the caller wires up:
//   onPlayersReady — fired (debounced) when the roster set changes. The
//                    overlay uses this to kick off stat fetches.
//   getCoplayPlayers — returns the current Steam SDK coplay list; used as
//                    a fallback when GSI hands us entity slots with no
//                    steamids (casual / retakes / community modes).
//   onReset        — fired on map change, menu-exit, or same-map new match.
//   onLiveStats    — fired every tick (throttled) with fresh per-player
//                    state + local-player performance.

const http = require('http');
const crypto = require('crypto');
const { GSI_TOKEN } = require('./gsi-config');
const { parseLiveDemo, resetDemo } = require('./demo-parser');
const {
  isEntitySlotFormat, buildNameLookup, resolveSteamIds,
  topUpFromCoplay, buildLiveStatsBlock, applyTeamsFrom, sameIdSet,
} = require('./gsi-roster');
const { buyAdviceFor } = require('./gsi-buy-advisor');

// ── Protocol-level constants ──────────────────────────────────
const GSI_PORT = 3000;
const AUTH_TOKEN_BUF = Buffer.from(GSI_TOKEN, 'utf8');
const MAX_BODY_BYTES = 256 * 1024;  // GSI payloads are typically ~5-30KB

// ── Match-level constants ────────────────────────────────────
// Hard-cap the roster regardless of game mode — the scoreboard layout is
// sized for a 10-player comp match. Extra players (community servers, DM)
// are dropped in favour of the most relevant ones (local + coplay).
const MAX_PLAYERS = 10;

// Debounce: once we have most of the roster (80%), fire fast so the fetch
// pipeline can start early. Below that threshold wait longer for stragglers.
const READY_THRESHOLD = Math.max(2, Math.floor(MAX_PLAYERS * 0.8));
const READY_DEBOUNCE_FAST_MS = 200;
const READY_DEBOUNCE_SLOW_MS = 1000;

// Throttle live-stats emissions so the renderer doesn't thrash at 10Hz.
const LIVE_EMIT_MIN_MS = 500;

// Diagnostic log throttles
const DEBUG_EXTRACT_LOG_MS = 10000;
const DEBUG_KEYS_LOG_MS    = 30000;

// HTTP hardening
const HEADERS_TIMEOUT_MS   = 5000;

// ── Diagnostics counter ──────────────────────────────────────
let gsiMessageCount = 0;
function getGsiMessageCount() { return gsiMessageCount; }

// Constant-time auth check. Length mismatch returns false early so timing
// only varies across the fixed-length comparison.
function authCheck(incomingToken) {
  if (typeof incomingToken !== 'string') return false;
  const buf = Buffer.from(incomingToken, 'utf8');
  if (buf.length !== AUTH_TOKEN_BUF.length) return false;
  return crypto.timingSafeEqual(buf, AUTH_TOKEN_BUF);
}

// GSI exposes three possible sources for a player's team. Which one is
// authoritative depends on whether we're the observed player (playing) or
// spectating. Check allplayers first (most reliable), then data.player,
// then data.player_id. Never blindly trust data.player.team — while
// spectating it's the spectated player's team, not ours.
function resolveLocalTeam(data, localId) {
  if (!localId) return null;
  if (data.allplayers?.[localId]?.team) return data.allplayers[localId].team;
  if (data.player?.team && data.player?.steamid === localId) return data.player.team;
  if (data.player_id?.team && data.player_id?.steamid === localId) return data.player_id.team;
  return null;
}

// When the local team flips, re-label every coplay player. Lobby data
// (available when queuing with premades) is authoritative; otherwise fall
// back to the "friend = same team" heuristic, which works for most pubs
// but not mixed-queue parties.
function retagCoplayTeams({ collectedIds, playerTeams, localTeam, localId, getCoplayPlayers }) {
  try {
    const { getLobbyTeams } = require('./coplay');
    const lobby = getLobbyTeams ? getLobbyTeams() : null;
    if (lobby && lobby.members.length > 0) {
      let applied = false;
      for (const m of lobby.members) {
        if (m.team && collectedIds.has(m.steamId)) {
          playerTeams[m.steamId] = m.team;
          applied = true;
        }
      }
      if (applied) return true;
    }
  } catch {}

  const coplayPlayers = getCoplayPlayers ? getCoplayPlayers() : [];
  for (const p of coplayPlayers) {
    if (collectedIds.has(p.steamId) && p.steamId !== localId) {
      playerTeams[p.steamId] = p.isFriend ? localTeam : (localTeam === 'T' ? 'CT' : 'T');
    }
  }
  return false;
}

function createGSIServer(onPlayersReady, getCoplayPlayers, onReset, onLiveStats) {
  // ── Per-match state ─────────────────────────────────────────
  let currentMap = null;
  let collectedIds = new Set();
  let playerTeams = {};         // steamId → 'T' | 'CT'
  let localPlayerTeam = null;
  let lastLocalTeam = null;
  let lastKnownLocalId = null;
  let lastPhase = null;
  let sawGameover = false;
  let lastTeamLog = '';
  let lastDataLog = false;
  let lastKeysLog = 0;
  let lastExtractLog = 0;
  let lastLiveEmit = 0;
  let lastDemoRound = -1;

  // ADR tracking: GSI sends round_totaldmg as a cumulative-within-round
  // counter. We roll it into `totalDamage` each time the round number
  // advances, then display `(totalDamage + lastRoundDmg) / (roundsPlayed + 1)`
  // so the current partial round is still reflected live.
  let totalDamage = 0;
  let lastRoundDmg = 0;
  let roundsPlayed = 0;
  let lastRound = -1;

  let fetchTimeout = null;

  // Single reset entry — map change, menu exit, manual reset, same-map
  // rematch all funnel through here so per-match state can never leak
  // from a previous match into a new one.
  function doReset(reason, newMap) {
    currentMap = newMap || null;
    collectedIds = new Set();
    playerTeams = {};
    localPlayerTeam = null;
    lastLocalTeam = null;
    lastDataLog = false;
    lastPhase = null;
    sawGameover = false;
    lastKnownLocalId = null;
    if (fetchTimeout) { clearTimeout(fetchTimeout); fetchTimeout = null; }
    totalDamage = 0;
    lastRoundDmg = 0;
    roundsPlayed = 0;
    lastRound = -1;
    lastDemoRound = -1;
    try { resetDemo(); } catch {}
    if (onReset) onReset(reason, newMap);
  }

  // Returns 'stop' when the tick should not be processed further (menu
  // transition with no match data yet), 'continue' otherwise.
  function handleTransitions(map, phase, gameMode) {
    if (map && map !== currentMap) {
      doReset('map-change', map);
      console.log(`\n[GSI] New map: ${map} | mode: ${gameMode} | max players: ${MAX_PLAYERS}`);
    }
    if (!map && currentMap) {
      doReset('menu', null);
      return 'stop';
    }
    if (!map) return 'stop';

    // Same-map new-match detection — CS2 reloads the same map for back-to-back
    // queues, so we can't rely on a map change to reset. Instead track the
    // phase transition: once we've seen 'gameover', the next warmup/live
    // phase starts a fresh match.
    if (phase === 'gameover') {
      sawGameover = true;
    } else if (sawGameover && (phase === 'warmup' || phase === 'live') && phase !== lastPhase) {
      console.log(`[GSI] Same-map new match detected (phase ${lastPhase} → ${phase}) — resetting roster`);
      doReset('new-match-same-map', map);
      currentMap = map; // doReset nulled it since newMap=map
    }
    lastPhase = phase;
    return 'continue';
  }

  // Build (or rebuild) collectedIds from this tick's payload. Returns
  // whether the roster set changed and whether we had a usable allplayers
  // block (vs. falling back to coplay).
  function updateRoster(data, liveStats) {
    const allplayers = data.allplayers;

    if (allplayers && Object.keys(allplayers).length > 0) {
      const isSlots = isEntitySlotFormat(allplayers);
      const now = Date.now();
      if (now - lastExtractLog > DEBUG_EXTRACT_LOG_MS) {
        lastExtractLog = now;
        const rawKeys = Object.keys(allplayers);
        const sample = allplayers[rawKeys[0]];
        const sampleKeys = sample ? Object.keys(sample).join(',') : 'none';
        const sampleSteamId = sample?.steamid || 'none';
        console.log(`[GSI/dbg] allplayers rawKeys[0]="${rawKeys[0]}" isEntitySlots=${isSlots} innerKeys=${sampleKeys} innerSteamid=${sampleSteamId}`);
      }

      const nameToSteamId = (isSlots && getCoplayPlayers)
        ? buildNameLookup(getCoplayPlayers() || [])
        : {};
      const { gsiIds, slotToSteamId } = resolveSteamIds(allplayers, isSlots, nameToSteamId);

      if (gsiIds.size > 0) {
        if (lastKnownLocalId) gsiIds.add(lastKnownLocalId);
        if (gsiIds.size < MAX_PLAYERS && getCoplayPlayers) {
          try { topUpFromCoplay(gsiIds, getCoplayPlayers() || [], MAX_PLAYERS); } catch {}
        }

        const changed = !sameIdSet(gsiIds, collectedIds);
        if (changed) collectedIds = gsiIds;

        applyTeamsFrom(allplayers, slotToSteamId, playerTeams);
        Object.assign(liveStats, buildLiveStatsBlock(allplayers, slotToSteamId));

        if (!lastDataLog) {
          const firstId = Object.keys(allplayers)[0];
          console.log('[GSI] Player data keys:', Object.keys(allplayers[firstId]));
          lastDataLog = true;
        }

        return { changed, hasUsableAllplayers: true };
      }
    }

    // Coplay-only fallback — rebuild from scratch each tick so stale IDs
    // don't linger when the coplay list shrinks.
    const fresh = new Set();
    if (lastKnownLocalId) fresh.add(lastKnownLocalId);
    if (getCoplayPlayers) {
      for (const p of getCoplayPlayers() || []) {
        if (fresh.size >= MAX_PLAYERS) break;
        fresh.add(p.steamId);
      }
    }
    const changed = !sameIdSet(fresh, collectedIds);
    if (changed) collectedIds = fresh;
    return { changed, hasUsableAllplayers: false };
  }

  function updateDamageTracker(data) {
    const currentRound = data.map?.round ?? 0;
    const localState = data.player?.state || {};
    if (currentRound !== lastRound && currentRound > 0) {
      if (lastRound >= 0) {
        totalDamage += lastRoundDmg;
        roundsPlayed++;
      }
      lastRound = currentRound;
      lastRoundDmg = 0;
    }
    if (localState.round_totaldmg != null) {
      lastRoundDmg = localState.round_totaldmg;
    }
    return { currentRound, localState };
  }

  // Live-demo parsing is heavy (tens of megabytes of .dem replay). Only
  // run at round transitions (gameover / round-over phases) to avoid
  // stealing CPU mid-fight.
  function mergeDemoData(data, liveStats, currentRound, phase) {
    const roundChanged = currentRound !== lastDemoRound;
    const safeToParse = phase === 'gameover' || data.round?.phase === 'over';
    if (!roundChanged || !safeToParse) return;
    lastDemoRound = currentRound;
    try {
      const demoData = parseLiveDemo();
      if (!demoData?.players) return;
      for (const [steamId, dp] of Object.entries(demoData.players)) {
        liveStats[steamId] = {
          kills: dp.kills, deaths: dp.deaths, assists: dp.assists,
          mvps: 0, score: dp.kills * 2 + dp.assists,
          health: 100, armor: 0, money: 0,
          adr: dp.adr, hsPct: dp.hsPct, damage: dp.damage,
          openingKills: dp.openingKills, openingDeaths: dp.openingDeaths,
          multiKillRounds: dp.multiKillRounds,
          role: dp.role, weaponKills: dp.weaponKills, econStats: dp.econStats,
        };
        if (dp.team && !playerTeams[steamId]) playerTeams[steamId] = dp.team;
        if (!collectedIds.has(steamId) && collectedIds.size < MAX_PLAYERS) {
          collectedIds.add(steamId);
        }
      }
      if (demoData.roundData) liveStats._roundData = demoData.roundData;
      if (demoData.patterns)  liveStats._patterns  = demoData.patterns;
    } catch (err) {
      console.error('[Demo] Error:', err.message);
    }
  }

  function stampMatchMeta(liveStats, data) {
    if (data.map) {
      liveStats._teamScores = {
        CT: data.map.team_ct?.score ?? 0,
        T:  data.map.team_t?.score  ?? 0,
      };
      liveStats._round = data.map.round ?? 0;
    }
    liveStats._roundPhase = data.round?.phase || null;
    liveStats._teams = { ...playerTeams };
  }

  // Log team composition only when it changes so we don't spam the log on
  // every tick.
  function logTeamsIfChanged() {
    const teamVals = Object.values(playerTeams);
    const tCount  = teamVals.filter(t => t === 'T').length;
    const ctCount = teamVals.filter(t => t === 'CT').length;
    if (tCount === 0 && ctCount === 0) return;
    const key = `${tCount}/${ctCount}`;
    if (lastTeamLog !== key) {
      lastTeamLog = key;
      console.log(`[GSI] Teams: ${tCount}T / ${ctCount}CT`);
    }
  }

  // Throttled dump of top-level GSI keys — handy when a mode's payload
  // shape is unexpected.
  function logTopLevelKeysThrottled(data) {
    const now = Date.now();
    if (now - lastKeysLog <= DEBUG_KEYS_LOG_MS) return;
    lastKeysLog = now;
    const topKeys = Object.keys(data).filter(k => k !== 'auth');
    const ap      = data.allplayers       ? Object.keys(data.allplayers).length       : 0;
    const apId    = data.allplayers_id    ? Object.keys(data.allplayers_id).length    : 0;
    const apState = data.allplayers_state ? Object.keys(data.allplayers_state).length : 0;
    console.log(`[GSI] Data keys: ${topKeys.join(', ')} | allplayers:${ap} allplayers_id:${apId} allplayers_state:${apState}`);
  }

  // ── Main per-tick processor ─────────────────────────────────
  function processTick(data) {
    const map = data.map?.name || null;
    const phase = data.map?.phase || null;
    const gameMode = data.map?.mode || null;
    if (handleTransitions(map, phase, gameMode) === 'stop') return;

    logTopLevelKeysThrottled(data);

    if (data.provider?.steamid) lastKnownLocalId = data.provider.steamid;

    const liveStats = {};
    const { changed: rosterChanged, hasUsableAllplayers } = updateRoster(data, liveStats);

    // Early partial-tick emission (mid-round) so the scoreboard feels
    // responsive. We emit again at the end with _performance attached.
    if (hasUsableAllplayers) {
      stampMatchMeta(liveStats, data);
      if (onLiveStats && Object.keys(liveStats).length > 0) onLiveStats(liveStats);
    }

    liveStats._localSteamId = data.provider?.steamid || null;

    // ── Local player: damage, money, buy advice ──
    const { currentRound, localState } = updateDamageTracker(data);
    const localMatchStats = data.player?.match_stats || {};
    const money      = localState.money      ?? 0;
    const equipValue = localState.equip_value ?? 0;
    const tScore  = data.map?.team_t?.score  ?? 0;
    const ctScore = data.map?.team_ct?.score ?? 0;
    const myTeam  = localPlayerTeam;
    const myScore    = myTeam === 'T' ? tScore  : ctScore;
    const enemyScore = myTeam === 'T' ? ctScore : tScore;
    const localId = data.provider?.steamid || lastKnownLocalId;

    const { advice: buyAdvice, reason: buyAdviceReason, teamState } = buyAdviceFor({
      allplayers: data.allplayers, localId, myTeam,
      money, roundNum: currentRound, myScore, enemyScore,
    });

    const adr = roundsPlayed > 0
      ? Math.round((totalDamage + lastRoundDmg) / (roundsPlayed + 1))
      : (lastRoundDmg || 0);
    liveStats._performance = {
      adr,
      kills: localMatchStats.kills ?? 0,
      deaths: localMatchStats.deaths ?? 0,
      assists: localMatchStats.assists ?? 0,
      roundKills: localState.round_kills ?? 0,
      roundDmg: lastRoundDmg,
      money, equipValue,
      buyAdvice, buyAdviceReason, teamState,
      round: currentRound, myScore, enemyScore,
    };

    // ── Local-team resolution & coplay re-tagging on flip ──
    const resolvedTeam = resolveLocalTeam(data, localId);
    if (resolvedTeam && localId) {
      playerTeams[localId] = resolvedTeam;
      localPlayerTeam = resolvedTeam;
    }
    if (localPlayerTeam && localPlayerTeam !== lastLocalTeam) {
      lastLocalTeam = localPlayerTeam;
      const lobbyApplied = retagCoplayTeams({
        collectedIds, playerTeams,
        localTeam: localPlayerTeam, localId, getCoplayPlayers,
      });
      console.log(`[GSI] Re-tagged teams: local=${localPlayerTeam} lobby=${lobbyApplied}`);
    }

    logTeamsIfChanged();

    // Heavy, throttled: demo parsing at round end.
    mergeDemoData(data, liveStats, currentRound, phase);

    // Final live-stats emission — throttled so the renderer doesn't get
    // flooded at 10Hz.
    stampMatchMeta(liveStats, data);
    const now = Date.now();
    if (onLiveStats && (now - lastLiveEmit) >= LIVE_EMIT_MIN_MS) {
      lastLiveEmit = now;
      onLiveStats(liveStats);
    }

    if (rosterChanged) {
      const apCount = data.allplayers ? Object.keys(data.allplayers).length : '?';
      console.log(`[GSI] ${collectedIds.size} player(s) collected (server: ${apCount})`);
    }

    // Debounced fan-out to the fetch pipeline. Fast path once we have most
    // of the roster so stats start loading; slow path otherwise so we can
    // still pick up the last straggler.
    if (rosterChanged && collectedIds.size >= 1) {
      if (fetchTimeout) clearTimeout(fetchTimeout);
      const delay = collectedIds.size >= READY_THRESHOLD
        ? READY_DEBOUNCE_FAST_MS
        : READY_DEBOUNCE_SLOW_MS;
      fetchTimeout = setTimeout(() => {
        // Hard-cap — demo parsing / top-up can push us past MAX_PLAYERS.
        const capped = Array.from(collectedIds).slice(0, MAX_PLAYERS);
        onPlayersReady({
          steamIds: capped,
          map: currentMap,
          phase,
          roundPhase: data.round?.phase || null,
          teams: { ...playerTeams },
          localPlayerTeam,
          liveStats: { ...liveStats },
        });
      }, delay);
    }
  }

  // ── HTTP plumbing ───────────────────────────────────────────
  const server = http.createServer((req, res) => {
    // Kill keep-alive so CS2 doesn't hang on exit waiting for open sockets.
    res.setHeader('Connection', 'close');

    if (req.method !== 'POST') {
      res.writeHead(200);
      res.end('CS2 Stats GSI Server');
      return;
    }

    const declaredLen = parseInt(req.headers['content-length'], 10);
    if (!isNaN(declaredLen) && declaredLen > MAX_BODY_BYTES) {
      res.writeHead(413); res.end();
      req.destroy();
      return;
    }

    let body = '';
    let bodyBytes = 0;
    let bodyTooLarge = false;
    req.on('data', (chunk) => {
      if (bodyTooLarge) return;
      const chunkLen = Buffer.byteLength(chunk);
      if (bodyBytes + chunkLen > MAX_BODY_BYTES) {
        bodyTooLarge = true;
        try { res.writeHead(413); res.end(); } catch {}
        req.destroy();
        return;
      }
      bodyBytes += chunkLen;
      body += chunk;
    });
    req.on('end', () => {
      if (bodyTooLarge) return;
      res.writeHead(200); res.end();

      let data;
      try { data = JSON.parse(body); } catch { return; }
      if (!authCheck(data.auth?.token)) return;
      gsiMessageCount++;
      try { processTick(data); } catch { /* malformed payload */ }
    });
  });

  server.keepAliveTimeout = 0;
  server.headersTimeout = HEADERS_TIMEOUT_MS;

  // Track sockets so destroyAll() can force them shut — plain .close()
  // leaves half-open connections from a crashed CS2 dangling.
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  // Manual reset entry — wired to an IPC handler in index.js so the user
  // can force-clear state without closing CS2.
  server.resetState = (reason) => doReset(reason || 'manual', null);
  server.destroyAll = () => {
    console.log(`[GSI] Destroying ${sockets.size} open sockets`);
    for (const socket of sockets) socket.destroy();
    sockets.clear();
  };

  server.listen(GSI_PORT, '127.0.0.1', () => {
    console.log(`[GSI] Listening on http://localhost:${GSI_PORT}`);
    console.log('[GSI] Waiting for CS2 match data...\n');
  });

  return server;
}

module.exports = { createGSIServer, getGsiMessageCount };
