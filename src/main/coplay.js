const path = require("path");
const koffi = require("koffi");

// In packaged builds, __dirname points inside app.asar, but native DLLs must be
// loaded from app.asar.unpacked. Swap the path segment when we detect we're in asar.
const RAW_DLL_PATH = path.join(__dirname, "../../node_modules/steamworks.js/dist/win64/steam_api64.dll");
const DLL_PATH = RAW_DLL_PATH.includes('app.asar' + path.sep)
  ? RAW_DLL_PATH.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep)
  : RAW_DLL_PATH;

let iface = null;
let dll = null;

// Coplay functions
let GetCoplayFriendCount = null;
let GetCoplayFriend = null;
let GetFriendCoplayTime = null;
let GetFriendCoplayGame = null;
let GetFriendPersonaName = null;

// Friends-in-game functions
let GetFriendCount = null;
let GetFriendByIndex = null;
let GetFriendGamePlayed = null;

function initCoplay() {
  dll = koffi.load(DLL_PATH);

  const SteamAPI_SteamFriends = dll.func("void* SteamAPI_SteamFriends_v017()");
  iface = SteamAPI_SteamFriends();

  // Coplay
  GetCoplayFriendCount = dll.func("int SteamAPI_ISteamFriends_GetCoplayFriendCount(void*)");
  GetCoplayFriend = dll.func("uint64_t SteamAPI_ISteamFriends_GetCoplayFriend(void*, int)");
  GetFriendCoplayTime = dll.func("int SteamAPI_ISteamFriends_GetFriendCoplayTime(void*, uint64_t)");
  GetFriendCoplayGame = dll.func("int SteamAPI_ISteamFriends_GetFriendCoplayGame(void*, uint64_t)");
  GetFriendPersonaName = dll.func("const char* SteamAPI_ISteamFriends_GetFriendPersonaName(void*, uint64_t)");

  // Friends in game
  GetFriendCount = dll.func("int SteamAPI_ISteamFriends_GetFriendCount(void*, int)");
  GetFriendByIndex = dll.func("uint64_t SteamAPI_ISteamFriends_GetFriendByIndex(void*, int, int)");
  GetFriendGamePlayed = dll.func("bool SteamAPI_ISteamFriends_GetFriendGamePlayed(void*, uint64_t, _Out_ uint8_t*)");

  console.log("[Coplay] Initialized Steam Friends API");
}

// Get recent CS2 coplay friends (strangers), filtered to a recent time window
function getRecentPlayers(withinSeconds = 300) {
  if (!iface) return [];

  const now = Math.floor(Date.now() / 1000);
  const count = GetCoplayFriendCount(iface);
  const players = [];
  let filtered = 0;

  for (let i = 0; i < count; i++) {
    const steamId64 = GetCoplayFriend(iface, i);
    const coplayTime = GetFriendCoplayTime(iface, steamId64);
    const appId = GetFriendCoplayGame(iface, steamId64);

    // Only CS2 (730)
    if (appId !== 730) continue;

    const name = GetFriendPersonaName(iface, steamId64);
    players.push({
      steamId: steamId64.toString(),
      name,
      coplayTime,
    });
  }

  // Sort by most recent coplay time
  players.sort((a, b) => b.coplayTime - a.coplayTime);

  // Filter by time if specified (0 = no filter)
  let recent = players;
  if (withinSeconds > 0) {
    recent = players.filter(p => (now - p.coplayTime) <= withinSeconds);
  }

  // Return up to 15 — the GSI server caps at maxPlayers and dedupes
  // against the local player and any partial allplayers payload, so we
  // want headroom. A hard cap of 9 here caused matches to stick at 9
  // whenever any coplay entry overlapped with an existing ID.
  recent = recent.slice(0, 15);
  if (count > 0) console.log(`[Coplay] ${recent.length} CS2 coplay (${players.length} total CS2, ${count} all games)`);
  return recent;
}

// Get friends currently playing CS2, filtered by up to 3 checks:
//   1. Same server IP+port (from FriendGameInfo_t)
//   2. Same map (from Steam rich presence game:map)
//   3. Same match group (from Steam rich presence steam_player_group)
// Each check only applies when data is available on BOTH sides. A friend
// is excluded if ANY available check fails.
function getFriendsInGame(currentMap) {
  if (!iface || !GetFriendCount) return [];

  // Bind rich presence + local server info
  let GetFriendRP = null;
  if (dll) {
    try {
      GetFriendRP = dll.func('const char* SteamAPI_ISteamFriends_GetFriendRichPresence(void*, uint64_t, const char*)');
    } catch {}
  }

  // Get local player's server IP+port and rich presence
  let localServerKey = null;
  let localGroup = null;
  try {
    const SteamAPI_SteamUser = dll.func('void* SteamAPI_SteamUser_v023()');
    const user = SteamAPI_SteamUser();
    if (user) {
      const GetSteamID = dll.func('uint64_t SteamAPI_ISteamUser_GetSteamID(void*)');
      const localId = GetSteamID(user);
      const localGameInfo = Buffer.alloc(24);
      const localPlaying = GetFriendGamePlayed(iface, localId, localGameInfo);
      if (localPlaying) {
        const ip = localGameInfo.readUInt32LE(8);
        const port = localGameInfo.readUInt16LE(12);
        if (ip !== 0 || port !== 0) localServerKey = `${ip}:${port}`;
      }
      if (GetFriendRP) {
        localGroup = GetFriendRP(iface, localId, 'steam_player_group') || null;
      }
    }
  } catch {}

  // If we have no data to validate against, don't guess — return empty.
  if (!localServerKey && !currentMap && !localGroup) return [];

  const players = [];
  const friendFlags = 0x04;
  const count = GetFriendCount(iface, friendFlags);
  let inCS2 = 0;
  let passed = 0;

  for (let i = 0; i < count; i++) {
    const steamId64 = GetFriendByIndex(iface, i, friendFlags);
    const gameInfo = Buffer.alloc(24);
    const playing = GetFriendGamePlayed(iface, steamId64, gameInfo);
    if (!playing) continue;
    const gameId = gameInfo.readBigUInt64LE(0);
    if (gameId !== 730n) continue;
    inCS2++;

    const name = GetFriendPersonaName(iface, steamId64);
    let checksRun = 0;
    let checksPassed = 0;

    // Check 1: server IP+port
    if (localServerKey) {
      const fIP = gameInfo.readUInt32LE(8);
      const fPort = gameInfo.readUInt16LE(12);
      if (fIP !== 0 || fPort !== 0) {
        checksRun++;
        if (`${fIP}:${fPort}` === localServerKey) checksPassed++;
      }
    }

    // Check 2: same map via rich presence
    if (GetFriendRP && currentMap) {
      try {
        const fMap = GetFriendRP(iface, steamId64, 'game:map') || '';
        if (fMap) {
          checksRun++;
          if (fMap === currentMap) checksPassed++;
        }
      } catch {}
    }

    // Check 3: same match group via rich presence
    if (GetFriendRP && localGroup) {
      try {
        const fGroup = GetFriendRP(iface, steamId64, 'steam_player_group') || null;
        if (fGroup) {
          checksRun++;
          if (fGroup === localGroup) checksPassed++;
        }
      } catch {}
    }

    // Require at least 2 checks to pass, OR all checks to pass if fewer
    // than 2 ran. A single map-match alone is too ambiguous (common maps).
    const accepted = checksRun >= 2
      ? checksPassed >= 2
      : (checksRun > 0 && checksPassed === checksRun);
    if (accepted) {
      passed++;
      players.push({ steamId: steamId64.toString(), name });
    }
  }

  if (inCS2 > 0) console.log(`[Coplay] ${passed}/${inCS2} friends passed checks (map=${currentMap || '?'}) (of ${count} total)`);
  return players;
}

// Try to get lobby members and their teams
function getLobbyTeams() {
  if (!dll) return null;
  try {
    const SteamAPI_SteamMatchmaking = dll.func('void* SteamAPI_SteamMatchmaking_v009()');
    const matchmaking = SteamAPI_SteamMatchmaking();
    if (!matchmaking) return null;

    // RequestLobbyList + get current lobby
    const GetFavoriteLobby = dll.func('uint64_t SteamAPI_ISteamMatchmaking_GetLobbyByIndex(void*, int)');

    // We need to find the lobby we're in — try using ISteamUser to get our lobby
    const SteamAPI_SteamUser = dll.func('void* SteamAPI_SteamUser_v023()');
    const user = SteamAPI_SteamUser();
    if (!user) return null;

    // GetGameConnectToken or similar won't help. Instead, try the friends API
    // to find lobby info from the local user
    const SteamAPI_SteamFriends = dll.func('void* SteamAPI_SteamFriends_v017()');
    const friends = SteamAPI_SteamFriends();
    if (!friends) return null;

    // Get local player's current game info (includes lobby ID)
    const GetSteamID = dll.func('uint64_t SteamAPI_ISteamUser_GetSteamID(void*)');
    const localId = GetSteamID(user);

    // Try to get lobby ID from the game server info
    const GetFriendGamePlayed = dll.func('bool SteamAPI_ISteamFriends_GetFriendGamePlayed(void*, uint64_t, _Out_ uint8_t*)');
    const gameInfo = Buffer.alloc(24);
    const playing = GetFriendGamePlayed(friends, localId, gameInfo);

    if (playing) {
      // FriendGameInfo_t layout: m_gameID (8), m_unGameIP (4), m_usGamePort (2), m_usQueryPort (2), m_steamIDLobby (8)
      const lobbyId = gameInfo.readBigUInt64LE(16);
      if (lobbyId && lobbyId !== 0n) {
        console.log(`[Lobby] Found lobby: ${lobbyId}`);

        const GetNumLobbyMembers = dll.func('int SteamAPI_ISteamMatchmaking_GetNumLobbyMembers(void*, uint64_t)');
        const GetLobbyMemberByIndex = dll.func('uint64_t SteamAPI_ISteamMatchmaking_GetLobbyMemberByIndex(void*, uint64_t, int)');
        const GetLobbyData = dll.func('const char* SteamAPI_ISteamMatchmaking_GetLobbyData(void*, uint64_t, const char*)');
        const GetLobbyMemberData = dll.func('const char* SteamAPI_ISteamMatchmaking_GetLobbyMemberData(void*, uint64_t, uint64_t, const char*)');

        const numMembers = GetNumLobbyMembers(matchmaking, lobbyId);
        console.log(`[Lobby] ${numMembers} members in lobby`);

        const members = [];
        for (let i = 0; i < numMembers; i++) {
          const memberId = GetLobbyMemberByIndex(matchmaking, lobbyId, i);
          // Try common keys for team data
          const team = GetLobbyMemberData(matchmaking, lobbyId, memberId, 'team') || '';
          const slot = GetLobbyMemberData(matchmaking, lobbyId, memberId, 'slot') || '';
          members.push({
            steamId: memberId.toString(),
            team: team || null,
            slot: slot || null,
          });
        }

        if (members.length > 0) {
          console.log(`[Lobby] Members:`, members.map(m => `${m.steamId} team=${m.team} slot=${m.slot}`).join(', '));
        }
        return { lobbyId: lobbyId.toString(), members };
      }
    }
  } catch (err) {
    console.log('[Lobby] Error:', err.message);
  }
  return null;
}

function shutdownCoplay() {
  // Call SteamAPI_Shutdown to properly release the Steam session
  // This tells Steam the "game" (our overlay) is no longer running
  if (dll) {
    try {
      const SteamAPI_Shutdown = dll.func('void SteamAPI_Shutdown()');
      SteamAPI_Shutdown();
      console.log('[Coplay] SteamAPI_Shutdown called');
    } catch (err) {
      console.log('[Coplay] SteamAPI_Shutdown failed:', err.message);
    }
  }

  iface = null;
  GetCoplayFriendCount = null;
  GetCoplayFriend = null;
  GetFriendCoplayTime = null;
  GetFriendCoplayGame = null;
  GetFriendPersonaName = null;
  GetFriendCount = null;
  GetFriendByIndex = null;
  GetFriendGamePlayed = null;
  dll = null;
  console.log('[Coplay] Shutdown complete');
}

module.exports = { initCoplay, getRecentPlayers, getFriendsInGame, getLobbyTeams, shutdownCoplay };
