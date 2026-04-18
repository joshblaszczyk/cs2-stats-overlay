const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { app } = require("electron");

function getTokenPath() {
  return path.join(app.getPath("userData"), "gsi-token.txt");
}

function loadOrCreateToken() {
  try {
    const tokenPath = getTokenPath();
    if (fs.existsSync(tokenPath)) {
      const existing = fs.readFileSync(tokenPath, "utf8").trim();
      if (existing) return existing;
    }
    const token = crypto.randomBytes(32).toString("hex");
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
    fs.writeFileSync(tokenPath, token);
    return token;
  } catch {
    return crypto.randomBytes(32).toString("hex");
  }
}

const GSI_TOKEN = loadOrCreateToken();

// Standard Steam install locations on Windows
const STEAM_PATHS = [
  "C:\\Program Files (x86)\\Steam",
  "C:\\Program Files\\Steam",
  "D:\\Steam",
  "D:\\SteamLibrary",
  "E:\\Steam",
  "E:\\SteamLibrary",
];

const CS2_RELATIVE = "steamapps\\common\\Counter-Strike Global Offensive\\game\\csgo\\cfg";

const GSI_CONFIG_NAME = "gamestate_integration_cs2stats.cfg";

const GSI_CONFIG_CONTENT = `"CS2 Stats Overlay"
{
    "uri"           "http://localhost:3000"
    "timeout"       "2.0"
    "buffer"        "0.1"
    "throttle"      "0.5"
    "heartbeat"     "5.0"
    "auth"
    {
        "token"     "${GSI_TOKEN}"
    }
    "data"
    {
        "provider"              "1"
        "map"                   "1"
        "round"                 "1"
        "player_id"             "1"
        "player_state"          "1"
        "player_match_stats"    "1"
        "player_weapons"        "1"
        "allplayers_id"         "1"
        "allplayers_state"      "1"
        "allplayers_match_stats" "1"
        "allplayers_weapons"    "1"
        "allplayers_position"   "1"
    }
}
`;

function findCS2CfgPath() {
  for (const steamPath of STEAM_PATHS) {
    const cfgPath = path.join(steamPath, CS2_RELATIVE);
    if (fs.existsSync(cfgPath)) {
      return cfgPath;
    }
  }

  // Check Steam's libraryfolders.vdf for custom install locations
  for (const steamPath of STEAM_PATHS.slice(0, 2)) {
    const vdfPath = path.join(steamPath, "steamapps", "libraryfolders.vdf");
    if (fs.existsSync(vdfPath)) {
      const content = fs.readFileSync(vdfPath, "utf8");
      const pathMatches = content.match(/"path"\s+"([^"]+)"/g);
      if (pathMatches) {
        for (const match of pathMatches) {
          const libPath = match.match(/"path"\s+"([^"]+)"/)[1];
          const cfgPath = path.join(libPath, CS2_RELATIVE);
          if (fs.existsSync(cfgPath)) {
            return cfgPath;
          }
        }
      }
    }
  }

  return null;
}

function installGSIConfig() {
  const cfgPath = findCS2CfgPath();

  if (!cfgPath) {
    console.error("[GSI] Could not find CS2 cfg folder.");
    console.error("[GSI] Searched:", STEAM_PATHS.map((p) => path.join(p, CS2_RELATIVE)).join("\n  "));
    console.error("[GSI] Make sure CS2 is installed, then try again.");
    return false;
  }

  const destFile = path.join(cfgPath, GSI_CONFIG_NAME);

  try {
    const st = fs.lstatSync(destFile);
    if (st.isSymbolicLink()) {
      console.warn("[GSI] Destination is a symlink, removing:", destFile);
      fs.unlinkSync(destFile);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error("[GSI] lstat failed:", err.message);
      return false;
    }
  }

  fs.writeFileSync(destFile, GSI_CONFIG_CONTENT, { flag: 'w' });
  console.log("[GSI] Config installed to:", destFile);
  return true;
}

function installConsoleLogging() {
  // Previously installed an autoexec.cfg with `alias`+`bind TAB` to echo the
  // CS2 console `status` output. CS2 now blocks these commands as "disallowed
  // workshop commands" in some map types, flooding the console with errors.
  // We poll TAB via GetAsyncKeyState in the overlay instead, so the bind was
  // redundant. Strip any existing autoexec we planted in past installs.
  const cfgPath = findCS2CfgPath();
  if (!cfgPath) return true;
  const autoexecPath = path.join(cfgPath, 'autoexec.cfg');
  if (!fs.existsSync(autoexecPath)) return true;
  try {
    const content = fs.readFileSync(autoexecPath, 'utf8');
    const cleaned = content
      .replace(/alias\s+\+cs2stats_tab\s+"[^"]*"\s*\r?\n?/g, '')
      .replace(/alias\s+-cs2stats_tab\s+"[^"]*"\s*\r?\n?/g, '')
      .replace(/bind\s+TAB\s+\+cs2stats_tab\s*\r?\n?/g, '');
    if (cleaned !== content) {
      if (cleaned.trim()) fs.writeFileSync(autoexecPath, cleaned);
      else fs.unlinkSync(autoexecPath);
      console.log('[GSI] Removed legacy autoexec TAB bind');
    }
  } catch {}
  return true;
}

function installLaunchOptions() {
  const { execSync, spawn } = require('child_process');
  const steamPaths = ['C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam', 'D:\\Steam'];
  const needed = '-condebug +exec autoexec';

  for (const steamPath of steamPaths) {
    const userdataPath = path.join(steamPath, 'userdata');
    if (!fs.existsSync(userdataPath)) continue;

    const users = fs.readdirSync(userdataPath).filter(d => /^\d+$/.test(d));
    for (const userId of users) {
      const vdfPath = path.join(userdataPath, userId, 'config', 'localconfig.vdf');
      if (!fs.existsSync(vdfPath)) continue;

      let content = fs.readFileSync(vdfPath, 'utf8');
      if (content.includes('-condebug')) {
        console.log('[Setup] Launch options already configured');
        return true;
      }

      // Find CS2 (730) LaunchOptions
      const launchMatch = content.match(/(\"LaunchOptions\"\s*\")([^\"]*)(\")/);
      if (!launchMatch) continue;

      // Check if Steam is running — need to close it to edit safely
      let steamWasRunning = false;
      try {
        const out = execSync('tasklist /FI "IMAGENAME eq steam.exe" /NH', { encoding: 'utf8', timeout: 3000 });
        steamWasRunning = out.includes('steam.exe');
      } catch {}

      if (steamWasRunning) {
        console.log('[Setup] Closing Steam to set launch options...');
        try { execSync('taskkill /IM steam.exe /F', { timeout: 5000 }); } catch {}
        // Wait for Steam to fully close
        try { execSync('timeout /t 3 /nobreak', { timeout: 10000 }); } catch {}
        // Re-read file after Steam closes (it writes on exit)
        content = fs.readFileSync(vdfPath, 'utf8');
      }

      const currentOptions = content.match(/(\"LaunchOptions\"\s*\")([^\"]*)(\")/);
      if (!currentOptions) continue;
      if (currentOptions[2].includes('-condebug')) {
        console.log('[Setup] Launch options already configured');
        if (steamWasRunning) {
          try {
            const child = spawn(path.join(steamPath, 'steam.exe'), [], { detached: true, stdio: 'ignore' });
            child.unref();
          } catch {}
        }
        return true;
      }

      const newOptions = currentOptions[2] ? `${currentOptions[2]} ${needed}` : needed;
      content = content.replace(currentOptions[0], `${currentOptions[1]}${newOptions}${currentOptions[3]}`);
      fs.writeFileSync(vdfPath, content);
      console.log(`[Setup] CS2 launch options set: ${newOptions}`);

      // Reopen Steam
      if (steamWasRunning) {
        console.log('[Setup] Reopening Steam...');
        try {
          const child = spawn(path.join(steamPath, 'steam.exe'), [], { detached: true, stdio: 'ignore' });
          child.unref();
        } catch {}
      }
      return true;
    }
  }
  console.log('[Setup] Could not find localconfig.vdf');
  return false;
}

function uninstallGSIConfig() {
  const results = { gsi: false, autoexec: false, launchOptions: false };
  const cfgPath = findCS2CfgPath();
  if (cfgPath) {
    const destFile = path.join(cfgPath, GSI_CONFIG_NAME);
    try {
      if (fs.existsSync(destFile)) {
        fs.unlinkSync(destFile);
        console.log("[GSI] Removed config:", destFile);
      }
      results.gsi = true;
    } catch (err) {
      console.error("[GSI] Failed to remove config:", err.message);
    }

    const autoexecPath = path.join(cfgPath, 'autoexec.cfg');
    try {
      if (fs.existsSync(autoexecPath)) {
        const content = fs.readFileSync(autoexecPath, 'utf8');
        const cleaned = content
          .replace(/alias\s+\+cs2stats_tab\s+"[^"]*"\s*\r?\n?/g, '')
          .replace(/alias\s+-cs2stats_tab\s+"[^"]*"\s*\r?\n?/g, '')
          .replace(/bind\s+TAB\s+\+cs2stats_tab\s*\r?\n?/g, '')
          .replace(/\n{3,}/g, '\n\n');
        if (cleaned.trim()) fs.writeFileSync(autoexecPath, cleaned);
        else fs.unlinkSync(autoexecPath);
        console.log("[GSI] Cleaned autoexec.cfg");
      }
      results.autoexec = true;
    } catch (err) {
      console.error("[GSI] Failed to clean autoexec:", err.message);
    }
  }

  // Strip -condebug +exec autoexec from CS2 launch options
  try {
    const steamPaths = ['C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam', 'D:\\Steam'];
    for (const steamPath of steamPaths) {
      const userdataPath = path.join(steamPath, 'userdata');
      if (!fs.existsSync(userdataPath)) continue;
      const users = fs.readdirSync(userdataPath).filter(d => /^\d+$/.test(d));
      for (const userId of users) {
        const vdfPath = path.join(userdataPath, userId, 'config', 'localconfig.vdf');
        if (!fs.existsSync(vdfPath)) continue;
        let content = fs.readFileSync(vdfPath, 'utf8');
        const m = content.match(/(\"LaunchOptions\"\s*\")([^\"]*)(\")/);
        if (!m) continue;
        const stripped = m[2].replace(/\s*-condebug\s*/g, ' ').replace(/\s*\+exec\s+autoexec\s*/g, ' ').replace(/\s+/g, ' ').trim();
        if (stripped !== m[2]) {
          content = content.replace(m[0], `${m[1]}${stripped}${m[3]}`);
          try { fs.writeFileSync(vdfPath, content); } catch {}
        }
        results.launchOptions = true;
      }
    }
  } catch (err) {
    console.error("[GSI] Failed to strip launch options:", err.message);
  }
  return results;
}

module.exports = { installGSIConfig, uninstallGSIConfig, findCS2CfgPath, installConsoleLogging, installLaunchOptions, GSI_TOKEN };

// Run directly
if (require.main === module) {
  installGSIConfig();
}
