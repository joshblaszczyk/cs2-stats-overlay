import React, { useRef, useState, useLayoutEffect } from 'react';
import leetifyBadge from './assets/leetify-badge.png';

function fmt(n) {
  if (n == null) return '--';
  return typeof n === 'number' ? n.toLocaleString() : String(n);
}

function flagType(f) {
  if (f.includes('VAC') || f.includes('GAME BAN') || f.includes('LIKELY')) return 'danger';
  if (f.includes('SMURF') || f.includes('SUS')) return 'smurf';
  return 'info';
}

function RatingBar({ label, value, color, max = 100 }) {
  const pct = value != null ? Math.min((value / max) * 100, 100) : 0;
  return (
    <div className="dp-bar">
      <span className="dp-bar-l">{label}</span>
      <div className="dp-bar-track">
        <div className="dp-bar-fill" style={{ width: `${pct}%`, background: color || '#4eac87' }} />
      </div>
      <span className="dp-bar-v">{value != null ? (Number.isInteger(value) ? value : value.toFixed(1)) : '--'}</span>
    </div>
  );
}

function analyzeLegitimacy(player) {
  const l = player.leetify || {};
  let totalWeight = 0, suspicionPoints = 0;
  const hasMatches = l.totalMatches != null && l.totalMatches >= 15;
  if (!hasMatches && l.aim == null) return null;

  if (l.preaim != null) { const w = 50; totalWeight += w; if (l.preaim < 3) suspicionPoints += w * 0.8; else if (l.preaim < 5) suspicionPoints += w * 0.5; }
  if (l.reactionTime != null) { const w = 45; totalWeight += w; if (l.reactionTime < 300) suspicionPoints += w * 0.7; else if (l.reactionTime < 380) suspicionPoints += w * 0.4; }
  if (l.aim != null) { const w = 35; totalWeight += w; if (l.aim > 96) suspicionPoints += w * 0.7; else if (l.aim > 90) suspicionPoints += w * 0.3; }
  if (l.headAccuracy != null && hasMatches) { const w = 25; totalWeight += w; if (l.headAccuracy > 55) suspicionPoints += w * 0.6; }
  if (player.bans?.VACBanned || player.bans?.NumberOfGameBans > 0) { totalWeight += 20; suspicionPoints += 20; }
  const hoursRaw = player.hours ? parseInt(String(player.hours).replace(/[^0-9]/g, ''), 10) : null;
  const isNew = player.accountAge && /^[0-2]\s?(yr|year)/i.test(player.accountAge);
  const isLowHrs = hoursRaw != null && hoursRaw < 500;
  if (isNew || isLowHrs) { totalWeight += 10; suspicionPoints += 10 * (isNew && isLowHrs ? 1 : 0.5); }

  // Rank vs account history
  const premier = l.premier || l.lastPremier || 0;
  const faceitLvl = player.faceit?.level || 0;
  if (premier >= 15000 && (isNew || isLowHrs)) {
    const w = 30; totalWeight += w;
    suspicionPoints += w * (premier >= 20000 ? 0.9 : 0.6);
  }
  if (faceitLvl >= 9 && (isNew || isLowHrs)) {
    const w = 25; totalWeight += w;
    suspicionPoints += w * (faceitLvl === 10 ? 0.8 : 0.5);
  }
  if (l.aim != null && l.aim > 88 && premier > 0 && premier < 13000 && hasMatches) {
    const w = 20; totalWeight += w;
    suspicionPoints += w * 0.6;
  }
  if (totalWeight === 0) return null;
  const pct = 100 - Math.round((suspicionPoints / totalWeight) * 100);
  const color = pct < 30 ? '#de4848' : pct < 60 ? '#d4a24e' : '#4eac87';
  const label = pct < 30 ? 'HIGH RISK' : pct < 60 ? 'SUS' : pct < 80 ? 'CAUTION' : 'CLEAN';
  return { pct, color, label };
}

export default function DetailPanel({ player, settings, currentMap, pattern, liveData, sbPos, dpPos }) {
  const l = player.leetify || {};
  const f = player.faceit || {};
  const fs = f.stats || {};
  const s = player.stats || {};
  const cs = player.csstats || {};
  const panelRef = useRef(null);
  // The position comes directly from App state (dpPos). If dpPos is null
  // (user has never dragged / first hover), fall back to an anchor next to
  // the scoreboard. App translates dpPos whenever the scoreboard moves,
  // so this component just renders whatever position it's given.
  const computeAnchor = () => {
    const board = document.querySelector('.sb-board');
    const panelApproxWidth = 340;
    const panelEl = panelRef.current;
    const panelApproxHeight = panelEl?.getBoundingClientRect?.().height || 520;
    const gap = 12;
    if (board) {
      const r = board.getBoundingClientRect();
      let anchorLeft = r.right + gap;
      if (anchorLeft + panelApproxWidth > window.innerWidth - 8) {
        anchorLeft = Math.max(8, r.left - panelApproxWidth - gap);
      }
      let anchorTop = Math.max(8, r.top + r.height / 2 - panelApproxHeight / 2);
      anchorTop = Math.min(anchorTop, Math.max(8, window.innerHeight - panelApproxHeight - 8));
      return { left: anchorLeft, top: anchorTop };
    }
    return { left: Math.max(8, window.innerWidth - panelApproxWidth - 16), top: 16 };
  };
  const [fallbackAnchor, setFallbackAnchor] = useState(computeAnchor);
  useLayoutEffect(() => {
    // Only recompute the fallback when there's no user-chosen position.
    if (!dpPos) setFallbackAnchor(computeAnchor());
  }, [sbPos?.x, sbPos?.y, dpPos]);
  const pos = dpPos || fallbackAnchor;

  // Color a stat by threshold. Gray = default / not remarkable (most values
  // land here, including bad performance — not a cheater tell). Green = good
  // but plausibly legit. Orange = sus. Red = high sus.
  // invertHigh flips the direction (LOW values alarm — e.g. reaction time).
  // badAt/goodAt kept as separate params for threshold clarity, but bad and
  // default both render gray so underperformers just recede.
  const sus = (val, badAt, goodAt, susAt, highSusAt, invertHigh = false) => {
    if (val == null) return '#6b7180';
    if (invertHigh) {
      if (val <= highSusAt) return '#de4848';
      if (val <= susAt) return '#e08b3c';
      if (val <= goodAt) return '#4eac87';
    } else {
      if (val >= highSusAt) return '#de4848';
      if (val >= susAt) return '#e08b3c';
      if (val >= goodAt) return '#4eac87';
    }
    return '#6b7180';
  };

  // Prefer csrep.gg's own trust rating when available — it's their authoritative
  // number, not our locally-computed heuristic. Fall back to our analysis otherwise.
  const cr = player.csrep || {};
  const legit = (cr.trust != null)
    ? (() => {
        const pct = Math.round(cr.trust);
        const color = pct < 30 ? '#de4848' : pct < 60 ? '#d4a24e' : pct < 80 ? '#c8d0dc' : '#4eac87';
        const label = pct < 30 ? 'HIGH RISK' : pct < 60 ? 'SUS' : pct < 80 ? 'CAUTION' : 'CLEAN';
        return { pct, color, label, source: 'csrep' };
      })()
    : analyzeLegitimacy(player);

  // Current map stats
  const norm = (k) => k.toLowerCase().replace(/^(de|cs)_/, '');
  const curMap = currentMap ? norm(currentMap) : '';
  let mapWR = null, mapRating = null, mapPlayed = null;
  for (const [k, v] of Object.entries(l.mapStats || {})) {
    if (norm(k) === curMap) { mapWR = v.winRate; mapRating = v.avgRating; break; }
  }
  if (mapWR == null) {
    for (const [k, v] of Object.entries(fs.mapStats || {})) {
      if (norm(k) === curMap) { mapWR = parseFloat(v.winRate); break; }
    }
  }
  // Fallback to csstats map data
  if (cs.mapStats) {
    for (const [k, v] of Object.entries(cs.mapStats)) {
      if (norm(k) === curMap) {
        if (mapWR == null && v.winRate != null) mapWR = v.winRate;
        if (v.played != null) mapPlayed = v.played;
        break;
      }
    }
  }

  const panelStyle = {
    position: 'fixed',
    top: pos.top,
    left: pos.left,
    right: undefined,
  };

  return (
    <div className="dp-v" ref={panelRef} style={panelStyle}>
      {/* Header */}
      <div className="dp-v-head">
        <span className="dp-v-name">{player.name || 'Unknown'}</span>
        {player.bans?.VACBanned && <span className="dp-v-tag dp-v-tag-ban">VAC</span>}
        {player.bans?.NumberOfGameBans > 0 && <span className="dp-v-tag dp-v-tag-ban">GAME BAN</span>}
        {player.flags?.slice(0, 2).map((f, i) => (
          <span key={i} className={`dp-v-tag dp-v-tag-${flagType(f)}`}>{f}</span>
        ))}
        {legit && <span className="dp-v-tag" style={{ background: legit.color + '22', color: legit.color }} title={legit.source === 'csrep' ? 'Trust rating from csrep.gg' : 'Heuristic score based on Leetify + Steam data'}>{legit.label} {legit.pct}%{legit.source === 'csrep' ? ' ·csrep' : ''}</span>}
      </div>
      <div className="dp-v-meta">
        {player.accountAge && <span>{player.accountAge}</span>}
        {player.hours && <span>{player.hours}</span>}
        {player.steamLevel != null && <span>Lv{player.steamLevel}</span>}
        {player.friendCount != null && <span>{player.friendCount} friends</span>}
        <span className="dp-v-src">Steam</span>
      </div>

      {/* Ranks */}
      <div className="dp-v-section">
        {(l.premier || player.gcPremier || cs.premier) && <div className="dp-v-kv"><span>Premier</span><strong>{fmt(l.premier || player.gcPremier || cs.premier)}</strong></div>}
        {(l.peakPremier || player.csstatsPeakPremier) && <div className="dp-v-kv"><span>Peak</span><strong className="dp-v-gold">{fmt(l.peakPremier || player.csstatsPeakPremier)}</strong></div>}
        {!l.premier && !player.gcPremier && !cs.premier && l.lastPremier && <div className="dp-v-kv"><span>Last Premier</span><strong>{fmt(l.lastPremier)}</strong></div>}
        {f.level && <div className="dp-v-kv"><span>FACEIT</span><strong>Lv{f.level} · {fmt(f.elo)}</strong></div>}
        {f.peakElo && <div className="dp-v-kv"><span>Peak ELO</span><strong className="dp-v-gold">{fmt(f.peakElo)}</strong></div>}
      </div>

      {/* Leetify Overview — headline winrate + rating */}
      {(l.recentWinRate != null || l.winRate != null || l.leetifyRating != null || l.totalMatches != null) && (
        <div className="dp-v-section dp-v-leetify-head" data-src="leetify">
          <div className="dp-v-sec-title">LEETIFY <span className="dp-v-src">last 30</span></div>
          {l.recentWinRate != null && (
            <div className="dp-v-kv"><span>Win%</span><strong style={{ color: sus(l.recentWinRate, 40, 55, 75, 90) }}>{l.recentWinRate}%</strong></div>
          )}
          {l.winRate != null && l.winRate !== l.recentWinRate && (
            <div className="dp-v-kv"><span>Win Rate</span><strong>{l.winRate}%</strong></div>
          )}
          {l.leetifyRating != null && (
            <div className="dp-v-kv"><span>Rating</span><strong style={{ color: sus(l.leetifyRating, 0, 5, 15, 25) }}>{l.leetifyRating.toFixed(2)}</strong></div>
          )}
          {l.totalMatches != null && (
            <div className="dp-v-kv"><span>Matches</span><strong>{fmt(l.totalMatches)}</strong></div>
          )}
        </div>
      )}

      {/* Leetify Skills Bars */}
      {l.aim != null && (
        <div className="dp-v-section" data-src="leetify">
          <div className="dp-v-sec-title">SKILLS <span className="dp-v-src">Leetify</span></div>
          <RatingBar label="Aim" value={l.aim} color={sus(l.aim, 40, 65, 85, 95)} />
          <RatingBar label="Positioning" value={l.positioning} color={sus(l.positioning, 40, 65, 85, 95)} />
          <RatingBar label="Utility" value={l.utility} color={sus(l.utility, 40, 65, 85, 95)} />
          {l.clutch != null && <div className="dp-v-kv"><span>Clutch</span><strong style={{ color: sus(l.clutch, 0.8, 1.05, 1.3, 1.8) }}>{l.clutch.toFixed(2)}</strong></div>}
          {l.opening != null && <div className="dp-v-kv"><span>Opening</span><strong style={{ color: sus(l.opening, 0.8, 1.05, 1.3, 1.8) }}>{l.opening.toFixed(2)}</strong></div>}
          {(l.ctLeetify != null || l.tLeetify != null) && (
            <div className="dp-v-kv"><span>CT / T</span><strong>{l.ctLeetify != null ? l.ctLeetify.toFixed(2) : '--'} / {l.tLeetify != null ? l.tLeetify.toFixed(2) : '--'}</strong></div>
          )}
          {l.reactionTime != null && <div className="dp-v-kv"><span>Reaction Time</span><strong style={{ color: sus(l.reactionTime, 700, 400, 300, 200, true) }}>{Math.round(l.reactionTime)}ms</strong></div>}
          {l.preaim != null && <div className="dp-v-kv"><span>Preaim</span><strong style={{ color: sus(l.preaim, 15, 8, 5, 3, true) }}>{l.preaim.toFixed(1)}°</strong></div>}
          {l.sprayAccuracy != null && <div className="dp-v-kv"><span>Spray Accuracy</span><strong style={{ color: sus(l.sprayAccuracy, 12, 20, 30, 45) }}>{l.sprayAccuracy.toFixed(1)}%</strong></div>}
          {l.headAccuracy != null && <div className="dp-v-kv"><span>Accuracy Head</span><strong style={{ color: sus(l.headAccuracy, 15, 25, 35, 50) }}>{l.headAccuracy.toFixed(1)}%</strong></div>}
          {l.counterStrafing != null && <div className="dp-v-kv"><span>Counter-Strafing</span><strong style={{ color: sus(l.counterStrafing, 45, 65, 80, 92) }}>{l.counterStrafing.toFixed(1)}%</strong></div>}
        </div>
      )}

      {/* Leetify Duels (v3 only — gracefully hides for mini-profile) */}
      {(l.ctOpeningSuccess != null || l.tOpeningSuccess != null || l.tradeKillSuccess != null || l.tradedDeathSuccess != null) && (
        <div className="dp-v-section" data-src="leetify">
          <div className="dp-v-sec-title">DUELS <span className="dp-v-src">Leetify</span></div>
          {l.ctOpeningSuccess != null && <div className="dp-v-kv"><span>CT Opening</span><strong style={{ color: sus(l.ctOpeningSuccess, 35, 50, 65, 80) }}>{l.ctOpeningSuccess.toFixed(1)}%</strong></div>}
          {l.tOpeningSuccess != null && <div className="dp-v-kv"><span>T Opening</span><strong style={{ color: sus(l.tOpeningSuccess, 35, 50, 65, 80) }}>{l.tOpeningSuccess.toFixed(1)}%</strong></div>}
          {l.tradeKillSuccess != null && <div className="dp-v-kv"><span>Trade Kill</span><strong style={{ color: sus(l.tradeKillSuccess, 35, 50, 65, 80) }}>{l.tradeKillSuccess.toFixed(1)}%</strong></div>}
          {l.tradedDeathSuccess != null && <div className="dp-v-kv"><span>Traded Death</span><strong style={{ color: sus(l.tradedDeathSuccess, 35, 50, 65, 80) }}>{l.tradedDeathSuccess.toFixed(1)}%</strong></div>}
        </div>
      )}

      {/* Leetify Utility (v3 only) */}
      {(l.flashHitPerFlash != null || l.flashAvgDuration != null || l.flashLeadingToKill != null || l.heDamageAvg != null || l.utilityOnDeath != null) && (
        <div className="dp-v-section" data-src="leetify">
          <div className="dp-v-sec-title">UTILITY <span className="dp-v-src">Leetify</span></div>
          {l.flashHitPerFlash != null && <div className="dp-v-kv"><span>Enemies Flashed Per Flashbang</span><strong>{l.flashHitPerFlash.toFixed(2)}</strong></div>}
          {l.flashAvgDuration != null && <div className="dp-v-kv"><span>Average Flashbang Duration</span><strong>{l.flashAvgDuration.toFixed(1)}s</strong></div>}
          {l.flashLeadingToKill != null && <div className="dp-v-kv"><span>Flashbangs Leading To Kill</span><strong>{l.flashLeadingToKill.toFixed(2)}</strong></div>}
          {l.heDamageAvg != null && <div className="dp-v-kv"><span>HE Foes Damage Average</span><strong>{l.heDamageAvg.toFixed(0)}</strong></div>}
          {l.utilityOnDeath != null && <div className="dp-v-kv"><span>Utility on Death</span><strong>{l.utilityOnDeath.toFixed(0)}</strong></div>}
        </div>
      )}

      {/* Leetify Per-Map Breakdown (v3 only) */}
      {l.mapStats && Object.keys(l.mapStats).length > 0 && (
        <div className="dp-v-section" data-src="leetify">
          <div className="dp-v-sec-title">MAPS <span className="dp-v-src">Leetify</span></div>
          {Object.entries(l.mapStats).slice(0, 6).map(([k, v]) => (
            <div key={k} className="dp-v-kv">
              <span>{(v.map || k).replace(/^de_/, '').replace(/^cs_/, '')}</span>
              <strong>
                {v.matches}m · {v.winRate != null ? `${v.winRate}%` : '--'}
                {v.avgRating != null ? ` · ${(v.avgRating * 100).toFixed(1)}` : ''}
              </strong>
            </div>
          ))}
        </div>
      )}

      {/* csstats.gg — Last 30 */}
      {(cs.recentKd != null || cs.recentWinRate != null) && (
        <div className="dp-v-section" data-src="csstats">
          <div className="dp-v-sec-title">CSSTATS.GG <span className="dp-v-src">last 30</span></div>
          {cs.recentWinRate != null && <div className="dp-v-kv"><span>Win%</span><strong style={{ color: sus(cs.recentWinRate, 40, 55, 75, 90) }}>{cs.recentWinRate}%</strong></div>}
          {cs.recentKd != null && <div className="dp-v-kv"><span>K/D</span><strong style={{ color: sus(cs.recentKd, 0.8, 1.1, 2.0, 3.0) }}>{cs.recentKd}</strong></div>}
          {cs.recentRating != null && <div className="dp-v-kv"><span>HLTV</span><strong style={{ color: sus(cs.recentRating, 0.9, 1.1, 1.5, 1.8) }}>{cs.recentRating.toFixed(2)}</strong></div>}
          {cs.recentAdr != null && <div className="dp-v-kv"><span>ADR</span><strong style={{ color: sus(cs.recentAdr, 60, 80, 110, 140) }}>{cs.recentAdr}</strong></div>}
          {cs.recentHs != null && <div className="dp-v-kv"><span>HS%</span><strong style={{ color: sus(cs.recentHs, 25, 45, 60, 75) }}>{cs.recentHs}%</strong></div>}
        </div>
      )}

      {/* csstats.gg — Lifetime */}
      {(cs.kd != null || cs.winRate != null || cs.hltvRating != null) && (
        <div className="dp-v-section" data-src="csstats">
          <div className="dp-v-sec-title">CSSTATS.GG <span className="dp-v-src">lifetime</span></div>
          {cs.winRate != null && <div className="dp-v-kv"><span>Win%</span><strong style={{ color: sus(cs.winRate, 40, 55, 70, 85) }}>{cs.winRate}%</strong></div>}
          {cs.kd != null && <div className="dp-v-kv"><span>K/D</span><strong style={{ color: sus(cs.kd, 0.8, 1.1, 2.0, 3.0) }}>{cs.kd}</strong></div>}
          {cs.hltvRating != null && <div className="dp-v-kv"><span>HLTV</span><strong style={{ color: sus(cs.hltvRating, 0.9, 1.1, 1.5, 1.8) }}>{cs.hltvRating.toFixed(2)}</strong></div>}
          {cs.adr != null && <div className="dp-v-kv"><span>ADR</span><strong style={{ color: sus(cs.adr, 60, 80, 110, 140) }}>{cs.adr}</strong></div>}
          {cs.hsPercent != null && <div className="dp-v-kv"><span>HS%</span><strong style={{ color: sus(cs.hsPercent, 25, 45, 60, 75) }}>{cs.hsPercent}%</strong></div>}
          {cs.matches != null && (
            <div className="dp-v-kv">
              <span>Matches</span>
              <strong>{fmt(cs.matches)} ({fmt(cs.won)}W/{fmt(cs.lost)}L{cs.tied ? `/${fmt(cs.tied)}T` : ''})</strong>
            </div>
          )}
          {cs.damage != null && <div className="dp-v-kv"><span>Total Damage</span><strong>{fmt(cs.damage)}</strong></div>}
        </div>
      )}

      {/* Fallback — shown only when neither csstats nor leetify has data */}
      {cs.kd == null && cs.winRate == null && l.recentWinRate == null && (fs.kd || s.kd) && (
        <div className="dp-v-section" data-src={fs.kd ? 'faceit' : 'steam'}>
          <div className="dp-v-sec-title">STATS <span className="dp-v-src">{fs.kd ? 'FACEIT' : 'Steam'}</span></div>
          {(fs.kd || s.kd) && <div className="dp-v-kv"><span>K/D</span><strong style={{ color: sus(parseFloat(fs.kd || s.kd), 0.8, 1.1, 2.0, 3.0) }}>{fs.kd || s.kd}</strong></div>}
          {fs.winRate != null && <div className="dp-v-kv"><span>Win%</span><strong style={{ color: sus(parseFloat(fs.winRate), 40, 55, 70, 85) }}>{fs.winRate}%</strong></div>}
          {fs.adr != null && <div className="dp-v-kv"><span>ADR</span><strong style={{ color: sus(parseFloat(fs.adr), 60, 80, 110, 140) }}>{fs.adr}</strong></div>}
          {s.headshotPct != null && <div className="dp-v-kv"><span>HS%</span><strong style={{ color: sus(parseFloat(s.headshotPct), 25, 45, 60, 75) }}>{s.headshotPct}%</strong></div>}
        </div>
      )}

      {/* Clutch breakdown */}
      {cs.clutchOverall != null && (
        <div className="dp-v-section" data-src="csstats">
          <div className="dp-v-sec-title">CLUTCH <span className="dp-v-src">csstats.gg</span></div>
          <div className="dp-v-kv"><span>1vX overall</span><strong style={{ color: sus(cs.clutchOverall, 10, 20, 30, 45) }}>{cs.clutchOverall}%</strong></div>
          {cs.clutch1v1 != null && <div className="dp-v-kv"><span>1v1</span><strong style={{ color: sus(cs.clutch1v1, 25, 45, 65, 80) }}>{cs.clutch1v1}%{cs.clutch1v1Wins != null ? ` (${cs.clutch1v1Wins}W/${cs.clutch1v1Losses}L)` : ''}</strong></div>}
          {cs.clutch1v2 != null && <div className="dp-v-kv"><span>1v2</span><strong style={{ color: sus(cs.clutch1v2, 10, 25, 40, 60) }}>{cs.clutch1v2}%{cs.clutch1v2Wins != null ? ` (${cs.clutch1v2Wins}W/${cs.clutch1v2Losses}L)` : ''}</strong></div>}
          {cs.clutch1v3 != null && <div className="dp-v-kv"><span>1v3</span><strong style={{ color: sus(cs.clutch1v3, null, 15, 25, 45) }}>{cs.clutch1v3}%{cs.clutch1v3Wins != null ? ` (${cs.clutch1v3Wins}W/${cs.clutch1v3Losses}L)` : ''}</strong></div>}
          {cs.clutch1v4 != null && <div className="dp-v-kv"><span>1v4</span><strong style={{ color: sus(cs.clutch1v4, null, 8, 15, 30) }}>{cs.clutch1v4}%{cs.clutch1v4Wins != null ? ` (${cs.clutch1v4Wins}W/${cs.clutch1v4Losses}L)` : ''}</strong></div>}
          {cs.clutch1v5 != null && <div className="dp-v-kv"><span>1v5</span><strong style={{ color: sus(cs.clutch1v5, null, 5, 10, 20) }}>{cs.clutch1v5}%{cs.clutch1v5Wins != null ? ` (${cs.clutch1v5Wins}W/${cs.clutch1v5Losses}L)` : ''}</strong></div>}
        </div>
      )}

      {/* Entry breakdown */}
      {(cs.entrySuccess != null || cs.entryPerRound != null) && (
        <div className="dp-v-section" data-src="csstats">
          <div className="dp-v-sec-title">ENTRY <span className="dp-v-src">csstats.gg</span></div>
          {cs.entryPerRound != null && <div className="dp-v-kv"><span>Per Round</span><strong>{cs.entryPerRound}%</strong></div>}
          {cs.entrySuccess != null && <div className="dp-v-kv"><span>Success</span><strong style={{ color: sus(cs.entrySuccess, 30, 50, 65, 80) }}>{cs.entrySuccess}%</strong></div>}
          {(cs.entrySuccessT != null || cs.entrySuccessCT != null) && (
            <div className="dp-v-kv"><span>Success T / CT</span><strong>{cs.entrySuccessT != null ? `${cs.entrySuccessT}%` : '--'} / {cs.entrySuccessCT != null ? `${cs.entrySuccessCT}%` : '--'}</strong></div>
          )}
          {cs.entryAttempts != null && <div className="dp-v-kv"><span>Attempts</span><strong>{cs.entryAttempts}%</strong></div>}
          {(cs.entryAttemptsT != null || cs.entryAttemptsCT != null) && (
            <div className="dp-v-kv"><span>Attempts T / CT</span><strong>{cs.entryAttemptsT != null ? `${cs.entryAttemptsT}%` : '--'} / {cs.entryAttemptsCT != null ? `${cs.entryAttemptsCT}%` : '--'}</strong></div>
          )}
        </div>
      )}

      {/* CSRep detailed analysis bars — render if ANY csrep data is present.
          Individual Bar rows return null when their value is null, so a
          partial response (e.g. trust only, or subset of metrics) still
          shows whatever csrep.gg did give us instead of hiding everything. */}
      {(cr.trust != null || cr.metrics || cr.anomalies != null || cr.sba != null) && (() => {
        const m = cr.metrics || {};
        const pctBar = (val, target, invert = false) => {
          if (val == null) return 0;
          const raw = Math.min(100, Math.max(0, (val / target) * 100));
          return invert ? Math.min(100, Math.max(0, 100 - raw)) : raw;
        };
        // Gray = default / not a cheater tell. Green = good legit.
        // Orange = sus. Red = high sus. invertHigh flips direction.
        const tone = (val, badAt, goodAt, susAt, highSusAt, invertHigh = false) => {
          if (val == null) return 'norm';
          if (!invertHigh) {
            if (val >= highSusAt) return 'bad';
            if (val >= susAt) return 'sus';
            if (val >= goodAt) return 'good';
            return 'norm';
          }
          if (val <= highSusAt) return 'bad';
          if (val <= susAt) return 'sus';
          if (val <= goodAt) return 'good';
          return 'norm';
        };
        const colorOf = (t) => t === 'bad' ? '#de4848' : t === 'sus' ? '#e08b3c' : t === 'good' ? '#4eac87' : '#6b7180';
        const Bar = ({ label, value, unit, barPct, tone: t }) => {
          if (value == null) return null;
          const color = colorOf(t);
          return (
            <div className="dp-v-bar">
              <div className="dp-v-bar-row">
                <span className="dp-v-bar-lbl">{label}</span>
                <span className="dp-v-bar-val" style={{ color }}>{value}{unit || ''}</span>
              </div>
              <div className="dp-v-bar-track"><div className="dp-v-bar-fill" style={{ width: `${Math.round(barPct)}%`, background: color }} /></div>
            </div>
          );
        };
        return (
          <div className="dp-v-section" data-src="csrep">
            <div className="dp-v-sec-title">CSREP ANALYSIS <span className="dp-v-src">csrep.gg</span></div>
            {cr.trust != null && <div className="dp-v-kv"><span>Trust Rating</span><strong style={{ color: cr.trust >= 80 ? '#4eac87' : cr.trust >= 60 ? '#6b7180' : cr.trust >= 40 ? '#e08b3c' : '#de4848' }}>{Math.round(cr.trust)}%</strong></div>}
            <Bar label="Aim Accuracy"    value={m.aimAcc}       unit="%"  barPct={pctBar(m.aimAcc, 40)}            tone={tone(m.aimAcc, 10, 18, 25, 35)} />
            <Bar label="Head Accuracy"   value={m.headAcc}      unit="%"  barPct={pctBar(m.headAcc, 60)}           tone={tone(m.headAcc, 15, 25, 35, 50)} />
            <Bar label="KAST"            value={m.kast}         unit="%"  barPct={pctBar(m.kast, 100)}             tone={tone(m.kast, 60, 72, 85, 95)} />
            <Bar label="HLTV 2.0"        value={m.hltvRating}   unit=""   barPct={pctBar(m.hltvRating, 2)}         tone={tone(m.hltvRating, 0.9, 1.15, 1.5, 2.0)} />
            <Bar label="Reaction"        value={m.reactionMs}   unit="ms" barPct={pctBar(m.reactionMs, 800, true)} tone={tone(m.reactionMs, 700, 400, 300, 200, true)} />
            <Bar label="Time to Damage"  value={m.ttdMs}        unit="ms" barPct={pctBar(m.ttdMs, 1000, true)}     tone={tone(m.ttdMs, 1000, 500, 400, 300, true)} />
            <Bar label="Preaim"          value={m.preaimDeg}    unit="°"  barPct={pctBar(m.preaimDeg, 20, true)}   tone={tone(m.preaimDeg, 15, 8, 5, 3, true)} />
            <Bar label="Crosshair"       value={m.crosshairDeg} unit="°"  barPct={pctBar(m.crosshairDeg, 20, true)} tone={tone(m.crosshairDeg, 15, 8, 4, 2, true)} />
            <Bar label="Wallbang Kill"   value={m.wallbang}     unit="%"  barPct={pctBar(m.wallbang, 10)}          tone={tone(m.wallbang, null, 1.5, 3, 7)} />
            <Bar label="Smoke Kill"      value={m.smoke}        unit="%"  barPct={pctBar(m.smoke, 10)}             tone={tone(m.smoke, null, 1.5, 3, 7)} />
          </div>
        );
      })()}

      {/* CSRep account reputation */}
      {cr.account && (cr.account.age?.value || cr.account.hours?.value) && (
        <div className="dp-v-section" data-src="csrep">
          <div className="dp-v-sec-title">ACCOUNT REP <span className="dp-v-src">csrep.gg</span></div>
          {cr.account.age?.value && <div className="dp-v-kv"><span>Age</span><strong>{cr.account.age.value}{cr.account.age.delta != null ? ` (${cr.account.age.delta > 0 ? '+' : ''}${cr.account.age.delta}%)` : ''}</strong></div>}
          {cr.account.hours?.value && <div className="dp-v-kv"><span>CS2 Hours</span><strong>{cr.account.hours.value}{cr.account.hours.delta != null ? ` (${cr.account.hours.delta > 0 ? '+' : ''}${cr.account.hours.delta}%)` : ''}</strong></div>}
          {cr.account.inventory?.value && <div className="dp-v-kv"><span>Inventory</span><strong>{cr.account.inventory.value}</strong></div>}
          {cr.account.level?.value && <div className="dp-v-kv"><span>Steam Level</span><strong>{cr.account.level.value}</strong></div>}
          {cr.account.collectibles?.value && <div className="dp-v-kv"><span>Collectibles</span><strong>{cr.account.collectibles.value}</strong></div>}
        </div>
      )}

      {/* Current Map */}
      {curMap && (mapWR != null || mapRating != null || mapPlayed != null) && (
        <div className="dp-v-section" data-src={mapRating != null ? 'leetify' : 'csstats'}>
          <div className="dp-v-sec-title">{curMap.toUpperCase()} <span className="dp-v-src">{mapRating != null ? 'Leetify' : 'csstats.gg'}</span></div>
          {mapWR != null && <div className="dp-v-kv"><span>Win%</span><strong style={{ color: sus(mapWR, 40, 55, 75, 90) }}>{mapWR}%</strong></div>}
          {mapRating != null && <div className="dp-v-kv"><span>Rating</span><strong style={{ color: sus(mapRating, 0, 5, 15, 25) }}>{(mapRating * 100).toFixed(1)}</strong></div>}
          {mapPlayed != null && <div className="dp-v-kv"><span>Played</span><strong>{mapPlayed}</strong></div>}
        </div>
      )}

      {/* Footer — credit only sources that actually contributed data to this
          panel. Blank links for providers that returned nothing are noise
          and falsely imply we used their data. */}
      <div className="dp-v-foot">
        {player.profileUrl && <a className="dp-v-link" data-src="steam" href={player.profileUrl} target="_blank" rel="noopener noreferrer">Steam</a>}
        {f.faceitUrl && (f.level != null || f.elo != null) && <a className="dp-v-link" data-src="faceit" href={f.faceitUrl} target="_blank" rel="noopener noreferrer">FACEIT</a>}
        {player.steamId && (cs.kd != null || cs.hltvRating != null || cs.premier != null || cs.matches != null) && (
          <a className="dp-v-link" data-src="csstats" href={`https://csstats.gg/player/${player.steamId}`} target="_blank" rel="noopener noreferrer">csstats.gg</a>
        )}
        {player.steamId && (cr.trust != null || cr.metrics || cr.anomalies != null || cr.sba != null || cr.account) && (
          <a className="dp-v-link" data-src="csrep" href={`https://csrep.gg/player/${player.steamId}`} target="_blank" rel="noopener noreferrer">csrep.gg</a>
        )}
        {(l.aim != null || l.leetifyRating != null || l.recentWinRate != null) && (
          <a className="dp-v-link" data-src="leetify" href={`https://leetify.com/app/profile/${player.steamId}`} target="_blank" rel="noopener noreferrer">Leetify</a>
        )}
      </div>

      {/* Leetify attribution — required by their API terms */}
      {(l.aim != null || l.leetifyRating != null || l.recentWinRate != null) && (
        <div className="dp-v-credit">
          <a href={`https://leetify.com/app/profile/${player.steamId}`} target="_blank" rel="noopener noreferrer" title="Data provided by Leetify">
            <img src={leetifyBadge} alt="Powered by Leetify" />
          </a>
        </div>
      )}
    </div>
  );
}
