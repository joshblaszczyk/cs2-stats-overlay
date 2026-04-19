import React, { useMemo, useState } from 'react';

function DataDot({ player }) {
  const hasCsstats = player.csstats && player.csstats.kd != null;
  const hasLeetify = player.leetify && player.leetify.aim != null;
  const hasFaceit = player.faceit && player.faceit.level != null;
  // csrep metrics stand in for csstats on private/untracked profiles.
  const hasCsrep   = player.csrep?.metrics?.kd != null;
  const anyStats = hasLeetify || hasCsstats || hasCsrep;
  const q = anyStats && hasFaceit ? 'full' : anyStats || hasFaceit ? 'partial' : 'basic';
  return <span className={`data-dot ${q}`} title={q === 'full' ? 'Full data' : q === 'partial' ? 'Partial data' : 'Basic data'} />;
}

function FlagPill({ player }) {
  if (!player.flags || player.flags.length === 0) return null;
  const flag = player.flags[0];
  const type = flag.includes('VAC') || flag.includes('GAME BAN') || flag.includes('LIKELY')
    ? 'danger'
    : flag.includes('SMURF') || flag.includes('SUS')
    ? 'smurf'
    : 'info';
  return <span className={`flag-pill ${type}`}>{flag}</span>;
}

function fmtRating(r) {
  if (!r) return null;
  return r >= 1000 ? Math.round(r / 1000) + 'K' : String(r);
}

function PlayerRow({ player, isLocal, isSelected, showRecent }) {
  const displayName = isLocal ? 'You' : (player.name || 'Unknown');
  const premier = player.leetify?.premier || player.gcPremier || player.csstatsPeakPremier;
  const faceitLvl = player.faceit?.level || player.csstats?.faceitLevel;
  const cs = player.csstats || {};
  const lt = player.leetify || {};
  // csrep.gg metrics are the last-resort fallback when csstats has
  // nothing (private profile / untracked account). csrep still gives
  // us kd/adr/hltv/hs for these players — better than a blank row.
  const csr = player.csrep?.metrics || {};
  const hasCsRecent = cs.recentKd != null || cs.recentRating != null;

  const kd = showRecent && cs.recentKd != null
    ? cs.recentKd
    : (cs.kd ?? player.faceit?.stats?.kd ?? player.stats?.kd ?? csr.kd);
  const hltv = showRecent && cs.recentRating != null
    ? cs.recentRating
    : (cs.hltvRating ?? csr.hltvRating);
  const wr = showRecent
    ? (cs.recentWinRate ?? lt.recentWinRate ?? cs.winRate ?? lt.winRate ?? player.faceit?.stats?.winRate)
    : (cs.winRate ?? lt.winRate ?? player.faceit?.stats?.winRate);
  const hs = showRecent && hasCsRecent ? cs.recentHs : (cs.hsPercent ?? csr.headAcc);
  const adr = showRecent && hasCsRecent ? cs.recentAdr : (cs.adr ?? csr.adr);
  const hours = player.hours && player.hours !== 'Private' ? player.hours : null;

  return (
    <div
      className={`sb-row ${isLocal ? 'sb-row-local' : ''} ${isSelected ? 'sb-row-selected' : ''}`}
      data-steamid={player.steamId}
    >
      <div className="sb-col sb-col-name">
        <DataDot player={player} />
        <span className="sb-name">{displayName}</span>
        <FlagPill player={player} />
      </div>
      <div className="sb-col sb-col-rank">
        {premier && <span className="sb-rank-premier">{fmtRating(premier)}</span>}
        {faceitLvl && <span className={`sb-rank-faceit ${faceitLvl >= 9 ? 'high' : faceitLvl >= 7 ? 'mid' : ''}`}>Lv{faceitLvl}</span>}
      </div>
      <div className={`sb-col sb-col-stat sb-col-hltv ${hltv >= 1.2 ? 'green' : hltv && hltv < 0.9 ? 'red' : ''}`}>
        {hltv ? hltv.toFixed(2) : '--'}
      </div>
      <div className="sb-col sb-col-stat sb-col-kd">{kd || '--'}</div>
      <div className={`sb-col sb-col-stat sb-col-win ${wr >= 55 ? 'green' : wr && wr <= 45 ? 'red' : ''}`}>
        {wr ? `${wr}%` : '--'}
      </div>
      <div className="sb-col sb-col-stat sb-col-adr">{adr || '--'}</div>
      <div className="sb-col sb-col-stat sb-col-hs">{hs ? `${hs}%` : '--'}</div>
      <div className="sb-col sb-col-hours">{hours || '--'}</div>
    </div>
  );
}

function ColumnHeaders({ showRecent, onToggleFilter, onOpenSettings, onReloadQueue }) {
  const H = (col) => <div className="sb-resize-handle" data-resize-col={col} />;
  return (
    <div className="sb-row sb-row-header">
      <div className="sb-col sb-col-name sb-hdr">PLAYER{H('name')}</div>
      <div className="sb-col sb-col-rank sb-hdr">RANK{H('rank')}</div>
      <div className="sb-col sb-col-stat sb-col-hltv sb-hdr">HLTV{H('hltv')}</div>
      <div className="sb-col sb-col-stat sb-col-kd sb-hdr">K/D{H('kd')}</div>
      <div className="sb-col sb-col-stat sb-col-win sb-hdr">WIN%{H('win')}</div>
      <div className="sb-col sb-col-stat sb-col-adr sb-hdr">ADR{H('adr')}</div>
      <div className="sb-col sb-col-stat sb-col-hs sb-hdr">HS%{H('hs')}</div>
      <div className="sb-col sb-col-hours sb-hdr">HRS{H('hours')}</div>
      <button className="sb-reload-btn" title="Reload queue (re-scan players)" onClick={(e) => { e.stopPropagation(); onReloadQueue?.(); }}>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="23 4 23 10 17 10"/>
          <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
        </svg>
      </button>
      <button className="sb-settings-btn" title="Settings" onClick={(e) => { e.stopPropagation(); onOpenSettings?.(); }}>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3"/>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
        </svg>
      </button>
      <button className={`sb-filter-btn ${showRecent ? 'active' : ''}`} onClick={(e) => { e.stopPropagation(); onToggleFilter(); }}>
        {showRecent ? '30' : 'ALL'}
      </button>
    </div>
  );
}

function SectionHeader({ label, color, count, avgRating, score }) {
  return (
    <div className={`sb-section sb-section-${color}`}>
      <span className="sb-section-label">{label}</span>
      {score != null && <span className="sb-section-score">{score}</span>}
      {avgRating && <span className="sb-section-avg">avg {avgRating}</span>}
      <span className="sb-section-count">{count} players</span>
    </div>
  );
}

function calcAvgRating(players) {
  const ratings = players.map(p => p.leetify?.premier || p.gcPremier || p.csstatsPeakPremier).filter(Boolean);
  if (ratings.length === 0) return null;
  const avg = Math.round(ratings.reduce((a, b) => a + b, 0) / ratings.length);
  return fmtRating(avg);
}

function StatusBanner({ status }) {
  if (!status) return null;
  const issues = Object.entries(status).filter(([_, s]) => s === 'down' || s === 'rate_limited');
  if (issues.length === 0) return null;
  const labels = { leetify: 'Leetify', csstats: 'csstats.gg', faceit: 'FACEIT', steam: 'Steam' };
  return (
    <div className="sb-status-banner sb-drag-handle">
      {issues.map(([name, state]) => (
        <span key={name} className={`sb-status-pill sb-status-${state}`}>
          {labels[name] || name} {state === 'down' ? 'down' : 'rate limited'}
        </span>
      ))}
    </div>
  );
}

const DEFAULT_COL_WIDTHS = { name: 200, rank: 100, hltv: 58, kd: 48, win: 58, adr: 50, hs: 52, hours: 60 };

export default function Scoreboard({ players, liveStats, settings, selectedPlayer, compact, onSelectPlayer, onHoverPlayer, serviceStatus, onOpenSettings, onReloadQueue }) {
  const tabView = settings?.tabView || {};
  const live = liveStats || {};
  const perf = live._performance;
  const [showRecent, setShowRecent] = useState(true);

  const cw = { ...DEFAULT_COL_WIDTHS, ...(settings?.columnWidths || {}) };
  const boardStyle = {
    '--col-name-w': cw.name + 'px',
    '--col-rank-w': cw.rank + 'px',
    '--col-hltv-w': cw.hltv + 'px',
    '--col-kd-w': cw.kd + 'px',
    '--col-win-w': cw.win + 'px',
    '--col-adr-w': cw.adr + 'px',
    '--col-hs-w': cw.hs + 'px',
    '--col-hours-w': cw.hours + 'px',
  };

  const avgRatingAll = useMemo(() => calcAvgRating(players), [players]);

  const renderRow = (p) => (
    <div key={p.steamId} onClick={() => onSelectPlayer?.(p)} onMouseEnter={() => onHoverPlayer?.(p)}>
      <PlayerRow
        player={p}
        isLocal={!!p.isLocal}
        isSelected={selectedPlayer?.steamId === p.steamId}
        showRecent={showRecent}
      />
    </div>
  );

  return (
    <div className="sb-container">
      <div className="sb-board" style={boardStyle} onMouseLeave={() => onHoverPlayer?.(null)}>
        <StatusBanner status={serviceStatus} />
        {/* Your live stats header */}
        <div className="sb-header sb-drag-handle">
          {perf ? (
            <div className="sb-live">
              <span className="sb-live-kda">{perf.kills}/{perf.deaths}/{perf.assists}</span>
              <span className="sb-live-sep" />
              <span className="sb-live-adr">{perf.adr} ADR</span>
              <span className="sb-live-sep" />
              <span className="sb-live-money">${perf.money?.toLocaleString()}</span>
              <span
                className={`sb-live-buy sb-buy-${perf.buyAdvice?.replace(' ', '-').toLowerCase()}`}
                title={perf.buyAdviceReason || (perf.teamState ? `team: ${perf.teamState}` : '')}
              >
                {perf.buyAdvice}
                {perf.buyAdviceReason && <span className="sb-live-buy-reason"> — {perf.buyAdviceReason}</span>}
              </span>
            </div>
          ) : (
            <div className="sb-live"><span className="sb-live-wait">Waiting for match...</span></div>
          )}
        </div>

        {/* Column headers */}
        {!compact && <ColumnHeaders showRecent={showRecent} onToggleFilter={() => setShowRecent(r => !r)} onOpenSettings={onOpenSettings} onReloadQueue={onReloadQueue} />}

        <SectionHeader label="PLAYERS" color="green" count={players.length} avgRating={avgRatingAll} />
        <div className="sb-rows">
          {players.length === 0
            ? <div className="sb-empty">Waiting for player data...</div>
            : players.map(renderRow)
          }
        </div>
      </div>
    </div>
  );
}
