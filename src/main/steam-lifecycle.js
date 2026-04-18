// Steam SDK lifecycle. Owns the steamworks.js + coplay module handles and
// exposes start/stop/accessor functions so index.js doesn't have to manage
// mutable Steam references directly.
//
// Why lifecycle matters: steamworks.js writes steam_appid.txt and loads the
// native steam_api64.dll, which holds a handle to the running Steam client.
// If we don't release it cleanly when CS2 closes, Steam itself can hang on
// exit waiting for the lock. So: init only when CS2 is detected, cleanup
// as soon as CS2 is gone. The callback interval it schedules also burns
// CPU if left running — see brute-force clearInterval sweep below.

// Module-private state. Exposed only through the API at the bottom.
let initialized = false;
let sw = null;
let coplay = null;
let callbackIntervalStart = 0;

const CS2_APP_ID = 730;
// The steamworks.js runCallbacks interval is scheduled with setInterval
// right after init. We don't get its ID back, so we capture the "next ID"
// before and after and sweep the range to clear it on shutdown. 50 is a
// generous upper bound — no code in this project allocates that many
// intervals during Steam init, so the sweep only catches steamworks.js.
const CALLBACK_ID_SWEEP_RANGE = 50;

// Initialize the Steam SDK and load the coplay helper module that depends on
// it. Idempotent. Safe to call repeatedly from the CS2-detected polling path.
function initSteam() {
  if (initialized) return;
  try {
    // Sample the next setInterval ID so we know where steamworks.js will
    // allocate its callback-pump interval in the sweep window below.
    const probe = setInterval(() => {}, 99999);
    clearInterval(probe);
    callbackIntervalStart = probe;

    sw = require('steamworks.js');
    sw.init(CS2_APP_ID);
    coplay = require('./coplay');
    coplay.initCoplay();
    initialized = true;
    console.log('[Steam] Initialized (CS2 detected running)');
  } catch (err) {
    console.log('[Steam] Init failed:', err.message);
  }
}

// Release everything Steam owns. Called on CS2-close so the Steam client
// can shut down without waiting on our DLL handle.
function cleanupSteam() {
  if (!initialized) return;
  console.log('[Steam] Cleaning up all references...');

  // 1. Clear the steamworks.js runCallbacks interval. Its ID lives in a
  //    window starting at callbackIntervalStart (sampled in initSteam).
  for (let i = callbackIntervalStart; i < callbackIntervalStart + CALLBACK_ID_SWEEP_RANGE; i++) {
    clearInterval(i);
  }

  // 2. Release koffi's handle to steam_api64.dll via the coplay module.
  if (coplay && coplay.shutdownCoplay) {
    try { coplay.shutdownCoplay(); }
    catch (err) { console.log('[Steam] Coplay shutdown error:', err.message); }
  }

  sw = null;
  coplay = null;
  initialized = false;

  if (global.gc) { try { global.gc(); } catch {} }
  console.log('[Steam] All references released');
}

// Accessors return null when Steam isn't initialized so callers don't need
// to check initialized separately — they can just `?.` their way through.
function getRecentPlayers(flags) {
  return coplay?.getRecentPlayers ? coplay.getRecentPlayers(flags) : null;
}

function getFriendsInGame(map) {
  return coplay?.getFriendsInGame ? coplay.getFriendsInGame(map) : null;
}

function isInitialized() {
  return initialized;
}

module.exports = { initSteam, cleanupSteam, getRecentPlayers, getFriendsInGame, isInitialized };
