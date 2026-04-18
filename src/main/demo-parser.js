// Live demo parser — reads the auto-recorded demo file mid-match
// to extract all players' stats (K/D/A, damage, teams)

const path = require('path');
const fs = require('fs');
const { parseEvent, parseTicks } = require('@laihoe/demoparser2');

function sanitizeName(s) {
  if (s == null) return 'Unknown';
  let out = String(s).replace(/[\x00-\x1F\x7F]/g, '');
  if (out.length > 64) out = out.slice(0, 64);
  if (!out) return 'Unknown';
  return out;
}

const DEMO_NAME = 'cs2stats_live.dem';

// Find CS2 game directory
function findDemoPath() {
  const paths = [
    'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Counter-Strike Global Offensive\\game\\csgo',
    'D:\\Steam\\steamapps\\common\\Counter-Strike Global Offensive\\game\\csgo',
    'D:\\SteamLibrary\\steamapps\\common\\Counter-Strike Global Offensive\\game\\csgo',
    'E:\\Steam\\steamapps\\common\\Counter-Strike Global Offensive\\game\\csgo',
  ];

  for (const p of paths) {
    if (fs.existsSync(p)) return path.join(p, DEMO_NAME);
  }

  // Check libraryfolders.vdf
  for (const steamPath of ['C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam']) {
    const vdfPath = path.join(steamPath, 'steamapps', 'libraryfolders.vdf');
    try {
      const content = fs.readFileSync(vdfPath, 'utf8');
      const matches = content.match(/"path"\s+"([^"]+)"/g);
      if (matches) {
        const SYSTEM_BLOCKLIST = ['c:\\windows', 'c:\\program files\\windowsapps', 'c:\\$recycle.bin'];
        for (const m of matches) {
          const libPath = m.match(/"path"\s+"([^"]+)"/)[1];
          const normalized = libPath.replace(/\\\\/g, '\\');
          if (normalized.includes('..')) continue;
          const resolved = path.resolve(normalized);
          if (!path.isAbsolute(resolved)) continue;
          if (resolved.includes('..')) continue;
          if (!fs.existsSync(resolved)) continue;
          const lower = resolved.toLowerCase();
          if (SYSTEM_BLOCKLIST.some(b => lower === b || lower.startsWith(b + '\\'))) continue;
          const csPath = path.join(resolved, 'steamapps\\common\\Counter-Strike Global Offensive\\game\\csgo');
          if (fs.existsSync(csPath)) return path.join(csPath, DEMO_NAME);
        }
      }
    } catch {}
  }
  return null;
}

let cachedDemoPath = null;
let lastParseSize = 0;
let lastParseResult = null;

function parseLiveDemo() {
  if (!cachedDemoPath) cachedDemoPath = findDemoPath();
  if (!cachedDemoPath || !fs.existsSync(cachedDemoPath)) return null;

  // Only re-parse if file has grown
  const stat = fs.statSync(cachedDemoPath);
  if (stat.size === lastParseSize && lastParseResult) return lastParseResult;
  if (stat.size < 1024) return null; // Too small, not enough data

  try {
    const idleStat = fs.statSync(cachedDemoPath);
    if (Date.now() - idleStat.mtime.getTime() < 2000) {
      console.warn('[Demo] Skipping parse — file actively being written');
      return null;
    }
  } catch (err) {
    console.warn('[Demo] Idle check failed:', err.message);
    return null;
  }

  try {
    // Parse player_death events to get K/D/A
    const deaths = parseEvent(cachedDemoPath, 'player_death',
      ['attacker_name', 'attacker_steamid', 'user_name', 'user_steamid', 'user_last_place_name', 'assister_name', 'assister_steamid', 'headshot', 'weapon'],
      ['total_rounds_played', 'game_time', 'round_start_time']
    );

    // Parse round_end events to get team scores and round count
    const rounds = parseEvent(cachedDemoPath, 'round_end',
      ['winner', 'reason'],
      ['total_rounds_played']
    );

    // Parse bomb plants for site info
    let bombPlants = [];
    try {
      bombPlants = parseEvent(cachedDemoPath, 'bomb_planted',
        ['last_place_name'],
        ['total_rounds_played']
      );
    } catch {}

    // Aggregate player stats + per-round data
    const players = {};
    const roundData = {}; // round# -> { openingKill, site, playerKills: {id: count} }

    // Weapon classification
    const WEAPON_CLASSES = {
      awp: 'AWP',
      ssg08: 'SCOUT',
      ak47: 'RIFLE', m4a1: 'RIFLE', m4a1_silencer: 'RIFLE', m4a1_silencer_off: 'RIFLE',
      aug: 'RIFLE', sg556: 'RIFLE', famas: 'RIFLE', galilar: 'RIFLE',
      mp9: 'SMG', mac10: 'SMG', mp7: 'SMG', ump45: 'SMG', p90: 'SMG', mp5sd: 'SMG', bizon: 'SMG',
      nova: 'SHOTGUN', xm1014: 'SHOTGUN', sawedoff: 'SHOTGUN', mag7: 'SHOTGUN',
      negev: 'MG', m249: 'MG',
      deagle: 'PISTOL', elite: 'PISTOL', fiveseven: 'PISTOL', glock: 'PISTOL',
      hkp2000: 'PISTOL', p250: 'PISTOL', tec9: 'PISTOL', usp_silencer: 'PISTOL', cz75a: 'PISTOL', revolver: 'PISTOL',
      knife: 'KNIFE', knife_t: 'KNIFE',
    };

    function classifyWeapon(weapon) {
      if (!weapon) return 'OTHER';
      const w = weapon.replace('weapon_', '').toLowerCase();
      return WEAPON_CLASSES[w] || 'OTHER';
    }

    function ensurePlayer(id, name) {
      if (!players[id]) players[id] = {
        steamId: id, name: sanitizeName(name), kills: 0, deaths: 0, assists: 0, hs: 0, damage: 0,
        openingKills: 0, openingDeaths: 0, multiKillRounds: { '2k': 0, '3k': 0, '4k': 0, '5k': 0 },
        weaponKills: {},  // { RIFLE: 5, AWP: 3, ... }
        role: null,       // AWPer, Rifler, etc.
        econHistory: [],  // equip values per round
      };
      return players[id];
    }

    function ensureRound(r) {
      if (!roundData[r]) roundData[r] = { openingKill: null, site: null, playerKills: {} };
      return roundData[r];
    }

    for (const death of deaths) {
      const attackerId = death.attacker_steamid;
      const victimId = death.user_steamid;
      const assisterId = death.assister_steamid;
      const round = death.total_rounds_played ?? 0;
      const rd = ensureRound(round);

      // Track attacker kills + weapon usage
      if (attackerId && attackerId !== '0' && attackerId !== victimId) {
        const p = ensurePlayer(attackerId, death.attacker_name);
        p.kills++;
        if (death.headshot) p.hs++;
        rd.playerKills[attackerId] = (rd.playerKills[attackerId] || 0) + 1;

        const wClass = classifyWeapon(death.weapon);
        p.weaponKills[wClass] = (p.weaponKills[wClass] || 0) + 1;
      }

      // Track victim deaths
      if (victimId && victimId !== '0') {
        ensurePlayer(victimId, death.user_name).deaths++;
      }

      // Track assists
      if (assisterId && assisterId !== '0') {
        ensurePlayer(assisterId, death.assister_name).assists++;
      }

      // Opening kill — first death in each round
      if (!rd.openingKill) {
        const timeSinceRoundStart = (death.game_time != null && death.round_start_time != null)
          ? Math.round(death.game_time - death.round_start_time)
          : null;
        rd.openingKill = {
          attacker: attackerId, victim: victimId,
          attackerName: death.attacker_name, victimName: death.user_name,
          weapon: death.weapon, headshot: !!death.headshot,
          time: timeSinceRoundStart,
          location: death.user_last_place_name || null,
        };
        if (attackerId && attackerId !== '0' && attackerId !== victimId) {
          players[attackerId].openingKills++;
        }
        if (victimId && victimId !== '0') {
          players[victimId].openingDeaths++;
        }
      }
    }

    // Bomb site per round
    for (const plant of bombPlants) {
      const round = plant.total_rounds_played ?? 0;
      const rd = ensureRound(round);
      const place = plant.last_place_name || '';
      rd.site = place.includes('A') ? 'A' : place.includes('B') ? 'B' : place;
    }

    // Multi-kill rounds
    for (const [, rd] of Object.entries(roundData)) {
      for (const [id, killCount] of Object.entries(rd.playerKills)) {
        if (players[id] && killCount >= 2) {
          const key = killCount >= 5 ? '5k' : `${killCount}k`;
          players[id].multiKillRounds[key]++;
        }
      }
    }

    // Try to get damage data from player_hurt events
    try {
      const hurts = parseEvent(cachedDemoPath, 'player_hurt',
        ['attacker_steamid', 'dmg_health'],
        ['total_rounds_played']
      );
      for (const hurt of hurts) {
        const id = hurt.attacker_steamid;
        if (id && id !== '0' && players[id]) {
          players[id].damage += (hurt.dmg_health || 0);
        }
      }
    } catch {}

    // Try to get team info + player positions at key moments
    try {
      // Get round_freeze_end ticks — marks when players start moving
      const freezeEnds = parseEvent(cachedDemoPath, 'round_freeze_end', [], ['total_rounds_played']);
      const freezeEndTicks = freezeEnds.map(e => e.tick);

      // Sample positions: at freeze end, +10s (~640 ticks), +20s (~1280 ticks)
      const sampleTicks = [];
      for (const t of freezeEndTicks) {
        sampleTicks.push(t, t + 640, t + 1280);
      }

      const tickData = parseTicks(cachedDemoPath,
        ['team_num', 'steamid', 'player_name', 'last_place_name', 'is_alive', 'X', 'Y', 'current_equip_value', 'balance'],
        sampleTicks
      );

      // Build per-player per-round position timeline
      // Group tick data by round (using freeze end tick indices)
      const ticksByRound = {};
      for (const t of tickData) {
        const id = String(t.steamid);
        if (!id || id === '0') continue;

        // Assign team
        if (players[id]) {
          players[id].team = t.team_num === 2 ? 'T' : t.team_num === 3 ? 'CT' : players[id].team;
        }

        // Find which round this tick belongs to
        let roundNum = 0;
        for (let i = freezeEndTicks.length - 1; i >= 0; i--) {
          if (t.tick >= freezeEndTicks[i]) { roundNum = i; break; }
        }

        if (!ticksByRound[roundNum]) ticksByRound[roundNum] = {};
        if (!ticksByRound[roundNum][id]) ticksByRound[roundNum][id] = [];
        ticksByRound[roundNum][id].push({
          place: t.last_place_name || '',
          alive: t.is_alive,
          x: t.X, y: t.Y,
          tick: t.tick,
          equipValue: t.current_equip_value || 0,
          money: t.balance || 0,
        });
      }

      // Build position + economy data into roundData
      for (const [roundStr, playerTicks] of Object.entries(ticksByRound)) {
        const round = parseInt(roundStr);
        const rd = ensureRound(round);
        rd.positions = {};
        rd.economy = {};
        for (const [id, ticks] of Object.entries(playerTicks)) {
          const places = ticks.filter(t => t.place).map(t => t.place);
          rd.positions[id] = {
            route: places,
            startPos: places[0] || null,
            midPos: places[1] || null,
            latePos: places[2] || null,
          };
          // Economy from first tick (freeze end = after buying)
          const firstTick = ticks[0];
          if (firstTick) {
            rd.economy[id] = {
              equipValue: firstTick.equipValue,
              money: firstTick.money,
            };
            // Store in player's econ history
            if (players[id]) {
              players[id].econHistory.push({
                round, equipValue: firstTick.equipValue, money: firstTick.money,
              });
            }
          }
        }
      }
    } catch (err) {
      // Fallback — just get team from tick 0
      try {
        const ticks = parseTicks(cachedDemoPath, ['team_num', 'steamid', 'name'], [0]);
        if (ticks && ticks.length > 0) {
          for (const t of ticks) {
            const id = String(t.steamid);
            if (id && players[id]) {
              players[id].team = t.team_num === 2 ? 'T' : t.team_num === 3 ? 'CT' : null;
            }
          }
        }
      } catch {}
    }

    const totalRounds = rounds.length > 0 ? Math.max(...rounds.map(r => r.total_rounds_played || 0)) + 1 : 1;

    // Calculate ADR, HS%, weapon role, and economy stats
    for (const p of Object.values(players)) {
      p.adr = totalRounds > 0 ? Math.round(p.damage / totalRounds) : 0;
      p.hsPct = p.kills > 0 ? Math.round((p.hs / p.kills) * 100) : 0;

      // Classify player role from weapon kills
      if (p.kills >= 3) {
        const wk = p.weaponKills;
        const totalGunKills = (wk.AWP || 0) + (wk.RIFLE || 0) + (wk.SMG || 0) + (wk.SHOTGUN || 0) + (wk.SCOUT || 0) + (wk.MG || 0) + (wk.PISTOL || 0);
        if (totalGunKills > 0) {
          const awpPct = ((wk.AWP || 0) / totalGunKills) * 100;
          const riflePct = ((wk.RIFLE || 0) / totalGunKills) * 100;
          const smgPct = ((wk.SMG || 0) / totalGunKills) * 100;
          const shotgunPct = ((wk.SHOTGUN || 0) / totalGunKills) * 100;
          const pistolPct = ((wk.PISTOL || 0) / totalGunKills) * 100;

          if (awpPct >= 35) p.role = 'AWPer';
          else if (shotgunPct >= 30) p.role = 'Shotgunner';
          else if (smgPct >= 40) p.role = 'SMG Rush';
          else if (pistolPct >= 40) p.role = 'Eco Warrior';
          else if (riflePct >= 50) p.role = 'Rifler';
          else p.role = 'Hybrid';
        }
      }

      // Economy stats
      if (p.econHistory.length > 0) {
        const avgEquip = Math.round(p.econHistory.reduce((s, e) => s + e.equipValue, 0) / p.econHistory.length);
        const fullBuyRounds = p.econHistory.filter(e => e.equipValue >= 4000).length;
        const ecoRounds = p.econHistory.filter(e => e.equipValue < 1500).length;
        p.econStats = {
          avgEquipValue: avgEquip,
          fullBuyPct: Math.round((fullBuyRounds / p.econHistory.length) * 100),
          ecoPct: Math.round((ecoRounds / p.econHistory.length) * 100),
        };
      }
    }

    // ── Pattern Analysis ──
    // Analyze each player's tendencies across rounds
    const patterns = {};
    for (const [id, player] of Object.entries(players)) {
      const siteVisits = { A: 0, B: 0, Mid: 0, other: 0 };
      const earlyFights = { aggressive: 0, passive: 0 };
      const positions = [];
      let roundCount = 0;

      for (const [roundStr, rd] of Object.entries(roundData)) {
        if (!rd.positions?.[id]) continue;
        roundCount++;
        const pos = rd.positions[id];
        positions.push(pos);

        // Classify site tendency from late position
        const latePlace = (pos.latePos || pos.midPos || '').toLowerCase();
        if (latePlace.includes('bombsitea') || latePlace.includes('site_a') || latePlace.includes('ramp') || latePlace.includes('palace') || latePlace.includes('apartments')) {
          siteVisits.A++;
        } else if (latePlace.includes('bombsiteb') || latePlace.includes('site_b') || latePlace.includes('tunnel') || latePlace.includes('banana')) {
          siteVisits.B++;
        } else if (latePlace.includes('mid') || latePlace.includes('catwalk') || latePlace.includes('window') || latePlace.includes('connector')) {
          siteVisits.Mid++;
        } else {
          siteVisits.other++;
        }

        // Check if they took an early fight (died or killed in first 15s)
        if (rd.openingKill && (rd.openingKill.attacker === id || rd.openingKill.victim === id)) {
          if (rd.openingKill.time != null && rd.openingKill.time <= 20) {
            earlyFights.aggressive++;
          }
        }
      }

      if (roundCount < 2) continue;

      // Determine primary tendencies
      const totalSiteRounds = siteVisits.A + siteVisits.B + siteVisits.Mid + siteVisits.other;
      const sitePcts = {};
      if (totalSiteRounds > 0) {
        sitePcts.A = Math.round((siteVisits.A / totalSiteRounds) * 100);
        sitePcts.B = Math.round((siteVisits.B / totalSiteRounds) * 100);
        sitePcts.Mid = Math.round((siteVisits.Mid / totalSiteRounds) * 100);
      }

      // Find dominant site
      let favSite = null;
      const maxPct = Math.max(sitePcts.A || 0, sitePcts.B || 0, sitePcts.Mid || 0);
      if (maxPct >= 40) {
        if (sitePcts.A === maxPct) favSite = 'A';
        else if (sitePcts.B === maxPct) favSite = 'B';
        else favSite = 'Mid';
      }

      const aggressionRate = roundCount > 0 ? Math.round((earlyFights.aggressive / roundCount) * 100) : 0;

      // Build route history (last 5 rounds)
      const recentRoutes = positions.slice(-5).map(p => p.route.join(' > '));

      patterns[id] = {
        favSite,
        sitePcts,
        aggressionRate,
        earlyFights: earlyFights.aggressive,
        roundsTracked: roundCount,
        recentRoutes,
        tendency: aggressionRate >= 40 ? 'AGGRESSIVE' : aggressionRate <= 15 ? 'PASSIVE' : 'MIXED',
      };
    }

    lastParseSize = stat.size;
    lastParseResult = { players, totalRounds, deaths: deaths.length, roundData, patterns };
    console.log(`[Demo] Parsed: ${Object.keys(players).length} players, ${deaths.length} kills, ${totalRounds} rounds, ${Object.keys(patterns).length} patterns`);
    return lastParseResult;
  } catch (err) {
    console.error('[Demo] Parse error:', err.message);
    return null;
  }
}

function resetDemo() {
  lastParseSize = 0;
  lastParseResult = null;
  cachedDemoPath = null;
}

module.exports = { parseLiveDemo, resetDemo, findDemoPath };
