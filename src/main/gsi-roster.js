// Roster assembly from CS2's GSI `allplayers` block.
//
// In competitive / premier matches GSI returns a clean object keyed by the
// 17-digit SteamID64 for each of the 10 players. In casual, retakes, DM,
// and most community modes it returns entity-slot indices instead (0, 1,
// 2, ...) and the inner player objects don't carry `steamid` either — just
// a display name. The code here resolves those slot indices back to canonical
// SteamIDs by cross-referencing the Steam SDK coplay list (name → SteamID),
// which is what makes the overlay usable outside of comp.

const ENTITY_SLOT_RE = /^\d+$/;

// Detect whether `allplayers` keys are entity slots or SteamIDs. Sloppy on
// purpose — the real check is "any key shorter than 10 chars that's an
// integer"; steamids are always 17 digits.
function isEntitySlotFormat(allplayers) {
  const keys = Object.keys(allplayers || {});
  return keys.some(k => k.length < 10 && ENTITY_SLOT_RE.test(k));
}

// Build a lowercase, trimmed name → SteamID lookup from the coplay list so
// entity-slot player objects (which only carry `name`) can be resolved.
function buildNameLookup(coplayPlayers) {
  const map = {};
  for (const p of coplayPlayers || []) {
    if (p && p.steamId && p.name) {
      map[p.name.toLowerCase().trim()] = p.steamId;
    }
  }
  return map;
}

// Returns:
//   gsiIds        — Set of canonical SteamID64 strings
//   slotToSteamId — raw-key → SteamID so later passes (livestats, team
//                   assignment) can continue using the original `allplayers`
//                   keys without re-resolving each time.
function resolveSteamIds(allplayers, isEntitySlots, nameToSteamId) {
  const gsiIds = new Set();
  const slotToSteamId = {};
  for (const [key, info] of Object.entries(allplayers)) {
    let steamId = info.steamid || (isEntitySlots ? null : key);
    if (!steamId && isEntitySlots && info.name) {
      steamId = nameToSteamId[info.name.toLowerCase().trim()] || null;
    }
    if (steamId && steamId.length >= 10) {
      gsiIds.add(steamId);
      slotToSteamId[key] = steamId;
    }
  }
  return { gsiIds, slotToSteamId };
}

// Fill any remaining seats up to `maxPlayers` using recent coplay players.
// GSI sometimes omits a player who just connected / hasn't finished
// spawning — seeding the roster from coplay gets their stat fetch started
// before they're officially in the match.
function topUpFromCoplay(gsiIds, coplayPlayers, maxPlayers) {
  for (const p of coplayPlayers || []) {
    if (gsiIds.size >= maxPlayers) break;
    if (p && p.steamId && p.steamId.length >= 10) gsiIds.add(p.steamId);
  }
}

// Build the per-player live stats payload (K/D/A, HP, money, ...) keyed by
// canonical SteamID. Inputs are GSI's nested `match_stats` / `state` blocks
// with sensible fallbacks so the renderer never sees `undefined`.
function buildLiveStatsBlock(allplayers, slotToSteamId) {
  const out = {};
  for (const [id, info] of Object.entries(allplayers)) {
    const steamId = slotToSteamId[id] || id;
    const ms = info.match_stats || {};
    const st = info.state || {};
    out[steamId] = {
      kills: ms.kills ?? 0,
      deaths: ms.deaths ?? 0,
      assists: ms.assists ?? 0,
      mvps: ms.mvps ?? 0,
      score: ms.score ?? 0,
      health: st.health ?? 100,
      armor: st.armor ?? 0,
      money: st.money ?? info.money ?? 0,
    };
  }
  return out;
}

// Copy GSI's team assignments into the persistent playerTeams map.
// Mutates `teamsOut` in place (intentional — the caller owns the map).
function applyTeamsFrom(allplayers, slotToSteamId, teamsOut) {
  for (const [id, info] of Object.entries(allplayers)) {
    const steamId = slotToSteamId[id] || id;
    if (info.team) teamsOut[steamId] = info.team;
  }
}

// Detect whether two sets contain the same IDs. Cheaper than serializing
// both to arrays on every tick.
function sameIdSet(a, b) {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

module.exports = {
  ENTITY_SLOT_RE,
  isEntitySlotFormat,
  buildNameLookup,
  resolveSteamIds,
  topUpFromCoplay,
  buildLiveStatsBlock,
  applyTeamsFrom,
  sameIdSet,
};
