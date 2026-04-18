// Dev-only UI preview. Triggered by TEST_OVERLAY=1 in the environment.
// Extracted from index.js to keep the production hot path free of dummy
// data. runTestMode() never returns — it takes over the window and keeps
// a setInterval alive to prevent Electron from quitting.

const path = require('path');
const fs = require('fs');

// Eight players covering the visual states the overlay renders: local,
// friends, enemies, smurf flag, VAC ban flag, plus varied stat ranges so
// color thresholds (good/sus/red) can be spot-checked at a glance.
const TEST_PLAYERS = [
  {
    steamId: '76561198378647405', name: 'You', isLocal: true, isFriend: true,
    hours: '2,847 hrs', accountAge: '8 yrs', steamLevel: 21, friendCount: 87,
    csstats: {
      kd: 1.66, hltvRating: 1.55, winRate: 51, hsPercent: 54, adr: 101,
      kills: 16248, deaths: 9802, assists: 2602, matches: 771, won: 391, lost: 310, rounds: 15508,
      clutch1v1: 70, clutch1v2: 27, clutchOverall: 23, entrySuccess: 69, entryPerRound: 9,
      recentKd: 2.44, recentAdr: 115, recentHs: 54, recentRating: 1.9, recentMatches: 30,
      mapStats: { dust2: { played: 232, winRate: 53 }, mirage: { played: 157 }, inferno: { played: 121, winRate: 52 } },
    },
    gcPremier: 22503, csstatsPeakPremier: 23339,
    faceit: { level: 7, elo: 1450 },
    leetify: {
      aim: 97.93, positioning: 71.23, utility: 39.02, leetifyRating: 10.54,
      clutch: 14.52, opening: 9.72, ctLeetify: 11.40, tLeetify: 8.91,
      reactionTime: 579.96, preaim: 9.06,
      sprayAccuracy: 0.312, headAccuracy: 0.287, counterStrafing: 0.684,
      ctOpeningSuccess: 58.3, tOpeningSuccess: 52.1,
      tradeKillSuccess: 68.5, tradedDeathSuccess: 62.2,
      flashHitPerFlash: 1.32, flashAvgDuration: 2.1, flashLeadingToKill: 0.11,
      heDamageAvg: 48, utilityOnDeath: 180,
      winRate: 75.86, totalMatches: 1259,
      mapStats: {
        dust2: { map: 'de_dust2', matches: 22, wins: 15, winRate: 68, avgRating: 0.103 },
        mirage: { map: 'de_mirage', matches: 13, wins: 9, winRate: 69, avgRating: 0.115 },
        inferno: { map: 'de_inferno', matches: 18, wins: 11, winRate: 61, avgRating: 0.088 },
        anubis: { map: 'de_anubis', matches: 9, wins: 6, winRate: 67, avgRating: 0.092 },
        nuke: { map: 'de_nuke', matches: 14, wins: 7, winRate: 50, avgRating: 0.064 },
      },
    },
  },
  {
    steamId: '76561198000000001', name: 'FriendA', isFriend: true,
    hours: '3,100 hrs', steamLevel: 35,
    csstats: { kd: 1.42, hltvRating: 1.38, winRate: 53, hsPercent: 48, adr: 95, matches: 620, won: 328, lost: 292, recentKd: 1.55, recentAdr: 102, recentHs: 50, recentRating: 1.45, recentMatches: 30 },
    gcPremier: 19800, csstatsPeakPremier: 21000,
    faceit: { level: 6, elo: 1280 },
  },
  {
    steamId: '76561198000000002', name: 'FriendB', isFriend: true,
    hours: '1,200 hrs', steamLevel: 15,
    csstats: { kd: 1.1, hltvRating: 1.05, winRate: 49, hsPercent: 42, adr: 78, matches: 340, won: 166, lost: 174, recentKd: 1.2, recentAdr: 85, recentHs: 44, recentRating: 1.1, recentMatches: 30 },
    gcPremier: 14500, csstatsPeakPremier: 16200,
  },
  {
    steamId: '76561198000000010', name: 'Enemy_Ace',
    hours: '5,400 hrs', steamLevel: 52,
    csstats: { kd: 1.78, hltvRating: 1.62, winRate: 57, hsPercent: 56, adr: 108, matches: 1100, won: 627, lost: 473, clutch1v1: 72, clutchOverall: 25, entrySuccess: 65, recentKd: 1.95, recentAdr: 118, recentHs: 58, recentRating: 1.75, recentMatches: 30 },
    gcPremier: 28500, csstatsPeakPremier: 30100,
    faceit: { level: 10, elo: 2450 },
    flags: ['LIKELY SMURF'],
  },
  {
    steamId: '76561198000000011', name: 'xXDestroyerXx',
    hours: '2,100 hrs', steamLevel: 28,
    csstats: { kd: 1.35, hltvRating: 1.28, winRate: 52, hsPercent: 51, adr: 92, matches: 580, won: 301, lost: 279, recentKd: 1.4, recentAdr: 96, recentHs: 49, recentRating: 1.32, recentMatches: 30 },
    gcPremier: 20100, csstatsPeakPremier: 22400,
    faceit: { level: 8, elo: 1680 },
  },
  {
    steamId: '76561198000000012', name: 'NoScope360',
    hours: '4,200 hrs', steamLevel: 40,
    csstats: { kd: 1.52, hltvRating: 1.45, winRate: 54, hsPercent: 60, adr: 97, matches: 890, won: 480, lost: 410, recentKd: 1.6, recentAdr: 100, recentHs: 62, recentRating: 1.5, recentMatches: 30 },
    gcPremier: 24000, csstatsPeakPremier: 25800,
    faceit: { level: 9, elo: 1950 },
  },
  {
    steamId: '76561198000000013', name: 'silv3r_bull3t',
    hours: '800 hrs', steamLevel: 8,
    csstats: { kd: 0.95, hltvRating: 0.88, winRate: 44, hsPercent: 38, adr: 68, matches: 210, won: 92, lost: 118, recentKd: 0.85, recentAdr: 62, recentHs: 35, recentRating: 0.8, recentMatches: 30 },
    gcPremier: 10200, csstatsPeakPremier: 12500,
  },
  {
    steamId: '76561198000000014', name: 'VACation_Soon',
    hours: '350 hrs', steamLevel: 3,
    csstats: { kd: 2.1, hltvRating: 1.85, winRate: 65, hsPercent: 68, adr: 120, matches: 45, won: 29, lost: 16, recentKd: 2.5, recentAdr: 130, recentHs: 70, recentRating: 2.0, recentMatches: 30 },
    gcPremier: 26000, csstatsPeakPremier: 26000,
    bans: { VACBanned: true, NumberOfGameBans: 1 },
    flags: ['VAC BAN'],
  },
];

const TEST_LIVE_STATS = {
  _performance: { kills: 18, deaths: 7, assists: 4, adr: 102, money: 7400, equipValue: 5200, buyAdvice: 'FULL BUY', round: 14 },
  _teamScores: { CT: 8, T: 6 },
  _localSteamId: '76561198378647405',
};

const LOCAL_STEAM_ID = '76561198378647405';

// Strip the overlay's click-through + no-activate flags so the window can be
// interacted with normally while previewing. Only runs if the koffi-loaded
// win32 functions were available — otherwise the setIgnoreMouseEvents call
// alone is enough on most systems.
function makeOverlayInteractive(win, hwnd, SetWindowLongPtrW, GetWindowLongPtrW) {
  if (SetWindowLongPtrW && GetWindowLongPtrW && hwnd) {
    const GWL_EXSTYLE = -20;
    const WS_EX_TRANSPARENT = 0x20;
    const WS_EX_NOACTIVATE = 0x8000000;
    const exStyle = Number(GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
    SetWindowLongPtrW(hwnd, GWL_EXSTYLE, (exStyle & ~WS_EX_TRANSPARENT) & ~WS_EX_NOACTIVATE);
  }
  win.setIgnoreMouseEvents(false);
  win.setAlwaysOnTop(true, 'normal');
  win.show();
  win.focus();
  win.setOpacity(1);
}

// Entry point: sets up the window for preview, sends fake players, auto-
// selects one so the detail panel is visible, and snapshots a screenshot.
function runTestMode({ win, overlayHwnd, SetWindowLongPtrW, GetWindowLongPtrW }) {
  console.log('[Test] Launching overlay in test mode...');

  const showTest = () => {
    if (!win) return;
    makeOverlayInteractive(win, overlayHwnd, SetWindowLongPtrW, GetWindowLongPtrW);

    // Dark background so the overlay is visible outside CS2 during preview.
    win.webContents.executeJavaScript(`document.body.style.background = '#0a0c10';`);
    win.webContents.send('overlay-toggle', true);
    win.webContents.send('players-update', { players: TEST_PLAYERS, map: 'de_dust2' });
    win.webContents.send('live-stats', TEST_LIVE_STATS);
    console.log('[Test] Overlay shown with test data');

    // Auto-hover + click the first non-local row so the detail panel renders.
    setTimeout(() => {
      win.webContents.executeJavaScript(`
        const rows = document.querySelectorAll('[data-steamid]');
        for (const row of rows) {
          if (row.getAttribute('data-steamid') !== '${LOCAL_STEAM_ID}') {
            row.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
            row.click();
            break;
          }
        }
      `);
    }, 500);

    // Screenshot after render — saved to repo root for regression checks.
    setTimeout(async () => {
      try {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(path.join(__dirname, '../../screenshot_overlay.png'), img.toPNG());
        console.log('[Test] Screenshot saved to screenshot_overlay.png');
      } catch (e) { console.log('[Test] Screenshot error:', e.message); }
    }, 1500);
  };

  // 3s delay lets the renderer load + hydrate before we inject test data.
  setTimeout(showTest, 3000);
  // Keep-alive so Electron doesn't quit with no active work. Noop interval.
  setInterval(() => {}, 60000);
}

module.exports = { runTestMode };
