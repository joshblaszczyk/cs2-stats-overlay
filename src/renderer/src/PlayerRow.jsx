import React from 'react';

// --- Helpers ---

function getDataQuality(player) {
  const hasLeetify = player.leetify && player.leetify.premier != null;
  const hasFaceit = player.faceit && player.faceit.level != null;
  if (hasLeetify && hasFaceit) return 'full';
  if (hasLeetify || hasFaceit) return 'partial';
  return 'basic';
}

function getMostSevereFlag(player) {
  if (!player.flags || player.flags.length === 0) return null;
  // Flags are strings like "SMURF? (aim)", "VAC BAN (15d ago)", "NEW ACCT"
  const flag = player.flags[0];
  const type = flag.includes('VAC') || flag.includes('GAME BAN') || flag.includes('LIKELY')
    ? 'danger'
    : flag.includes('SMURF') || flag.includes('SUS')
    ? 'smurf'
    : 'info';
  return { label: flag, type };
}

function formatNumber(n) {
  if (n == null) return '--';
  return n.toLocaleString();
}

function formatPremier(player) {
  const rating = player.leetify?.premier;
  if (rating == null) return '--';
  return formatNumber(rating);
}

function formatFaceitLevel(player) {
  const level = player.faceit?.level;
  if (level == null) return '--';
  return `Lv ${level}`;
}

function getFaceitClass(player) {
  const level = player.faceit?.level;
  if (level == null) return 'neutral';
  if (level >= 9) return 'positive';
  if (level >= 7) return 'warning';
  if (level <= 3) return 'neutral';
  return '';
}

function formatKD(player) {
  const kd = player.kd;
  if (kd == null || kd === '--') return '--';
  const n = parseFloat(kd);
  return isNaN(n) ? kd : n.toFixed(2);
}

function getKDClass(player) {
  const kd = parseFloat(player.kd);
  if (isNaN(kd)) return 'neutral';
  if (kd > 1.2) return 'positive';
  if (kd < 0.8) return 'danger';
  return '';
}

function formatHS(player) {
  const hs = player.hsPct;
  if (hs == null || hs === '--') return '--';
  const n = parseFloat(hs);
  return isNaN(n) ? '--' : `${Math.round(n)}%`;
}

function getHSClass(player) {
  const hs = parseFloat(player.hsPct);
  if (isNaN(hs)) return 'neutral';
  if (hs > 50) return 'positive';
  if (hs < 30) return 'danger';
  return '';
}

function formatHours(player) {
  // player.hours is "1436h" or "Private"
  if (!player.hours || player.hours === 'Private') return '--';
  return player.hours;
}

function getHoursClass(player) {
  const h = parseInt(player.hours);
  if (isNaN(h)) return 'neutral';
  if (h < 200) return 'danger';
  return '';
}

function getStatValue(col, player) {
  switch (col.key) {
    case 'premier': return formatPremier(player);
    case 'faceit': return formatFaceitLevel(player);
    case 'kd': return formatKD(player);
    case 'hs': return formatHS(player);
    case 'hours': return formatHours(player);
    default: return '--';
  }
}

function getStatClass(col, player) {
  switch (col.key) {
    case 'faceit': return getFaceitClass(player);
    case 'kd': return getKDClass(player);
    case 'hs': return getHSClass(player);
    case 'hours': return getHoursClass(player);
    default: return '';
  }
}


// --- Main Component ---

export default function PlayerRow({ player, isLocalPlayer, settings, columns, onHover, isSelected }) {
  const quality = getDataQuality(player);
  const flag = getMostSevereFlag(player);
  const displayName = isLocalPlayer ? `You` : (player.name || 'Unknown');

  return (
    <div
      className={`player-row-wrapper ${isSelected ? 'selected' : ''}`}
      data-steamid={player.steamId}
    >
      <div className={`player-row ${isLocalPlayer ? 'local-player' : ''} ${isSelected ? 'highlighted' : ''}`}>
        <div className="col-name player-name-cell">
          <span className={`data-dot ${quality}`} />
          <span className="player-name">{displayName}</span>
          {flag && (
            <span className={`flag-pill ${flag.type}`}>{flag.label}</span>
          )}
        </div>

        {columns.map((col) => (
          <div
            key={col.key}
            className={`stat ${getStatClass(col, player)}`}
            style={{ width: col.width, minWidth: col.width }}
          >
            {getStatValue(col, player)}
          </div>
        ))}
      </div>
    </div>
  );
}
