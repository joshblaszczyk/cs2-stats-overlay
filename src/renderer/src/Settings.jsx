import React, { useState, useEffect, useCallback } from 'react';

function CheckboxRow({ label, checked, onChange }) {
  return (
    <label className="settings-checkbox">
      <input type="checkbox" checked={checked} onChange={onChange} />
      <span className="checkbox-label">{label}</span>
    </label>
  );
}

function SectionTitle({ children }) {
  return <div className="settings-section-title">{children}</div>;
}

function CsstatsStatusButton() {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const check = useCallback(async () => {
    setBusy(true);
    try {
      const s = await window.cs2stats?.getCsstatsStatus?.();
      setStatus(s);
    } catch (e) {
      setStatus({ error: e.message });
    } finally {
      setBusy(false);
    }
  }, []);
  const label = busy
    ? 'Probing csstats.gg...'
    : !status
      ? 'Check status'
      : status.error
        ? `Error · ${status.error.slice(0, 40)}`
        : status.unknown
          ? 'No local player to probe'
          : status.rateLimited
            ? (status.cooldownRemainingMin > 0
                ? `Rate limited · ${status.cooldownRemainingMin} min left`
                : 'Rate limited · probe returned no data')
            : `OK · probe succeeded${status.cachedPlayers ? ` · ${status.cachedPlayers} cached` : ''}`;
  const cls = (status?.rateLimited || status?.error) ? 'settings-btn settings-btn-danger' : 'settings-btn';
  return <button className={cls} onClick={check}>{label}</button>;
}

function KeyRow({ label, fieldKey, status, required, placeholder, helpUrl, helpText, onSaved, onCleared }) {
  const [editing, setEditing] = useState(!status?.set);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  // When the async key status lands after mount, flip out of edit mode if the
  // key is actually set. Only do this once (don't override a manual Replace click).
  const [statusApplied, setStatusApplied] = useState(false);
  useEffect(() => {
    if (!statusApplied && status && typeof status.set === 'boolean') {
      setEditing(!status.set);
      setStatusApplied(true);
    }
  }, [status, statusApplied]);

  const save = async () => {
    const value = draft.trim();
    if (!value) { setMsg({ type: 'error', text: 'Empty value' }); return; }
    setBusy(true);
    setMsg({ type: 'ok', text: 'Validating...' });
    try {
      const payload = { steam: '', faceit: '' };
      payload[fieldKey] = value;
      const v = await window.cs2stats?.validateApiKeys?.(payload);
      const result = v?.[fieldKey];
      if (result && result.ok === false && !result.optional) {
        setMsg({ type: 'error', text: `Invalid key: ${result.reason || 'rejected by provider'}` });
        return;
      }
      await window.cs2stats?.saveApiKeys?.(payload);
      setMsg({ type: 'ok', text: '✓ Saved & validated' });
      setDraft('');
      setEditing(false);
      onSaved?.();
    } catch (e) {
      setMsg({ type: 'error', text: e.message || 'Save failed' });
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await window.cs2stats?.clearApiKey?.(fieldKey);
      setMsg({ type: 'ok', text: 'Cleared' });
      setEditing(true);
      onCleared?.();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-key-row">
      <div className="settings-key-label">
        <span>{label}</span>
        {required && <span className="settings-key-required">required</span>}
        {!required && <span className="settings-key-optional">optional</span>}
        {helpUrl && (
          <button
            type="button"
            className="settings-key-link"
            onClick={() => window.cs2stats?.openExternal?.(helpUrl)}
            title={helpUrl}
          >
            {helpText || 'Get key'}
          </button>
        )}
      </div>
      {!editing && status?.set && (
        <div className="settings-key-view">
          <span className="settings-key-masked">{status.masked}</span>
          <button className="settings-btn" disabled={busy} onClick={() => setEditing(true)}>Replace</button>
          <button className="settings-btn settings-btn-danger" disabled={busy} onClick={clear}>Clear</button>
        </div>
      )}
      {editing && (
        <div className="settings-key-edit">
          <input
            type="password"
            className="settings-key-input"
            placeholder={placeholder}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            autoComplete="new-password"
          />
          <button
            className="settings-btn"
            disabled={busy}
            onClick={async () => {
              const txt = await window.cs2stats?.readClipboard?.();
              if (txt) setDraft(txt.trim());
            }}
          >Paste</button>
          <button className="settings-btn settings-btn-primary" disabled={busy || !draft.trim()} onClick={save}>Save</button>
          {status?.set && (
            <button className="settings-btn" disabled={busy} onClick={() => { setEditing(false); setDraft(''); }}>Cancel</button>
          )}
        </div>
      )}
      {msg && <div className={`settings-key-msg settings-key-msg-${msg.type}`}>{msg.text}</div>}
    </div>
  );
}

function ConfirmButton({ label, confirmLabel, onConfirm, danger }) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <button className={`settings-btn ${danger ? 'settings-btn-danger' : ''}`} onClick={() => setConfirming(true)}>
        {label}
      </button>
    );
  }
  return (
    <span className="settings-confirm">
      <button className={`settings-btn settings-btn-primary`} onClick={() => { onConfirm?.(); setConfirming(false); }}>
        {confirmLabel || 'Confirm'}
      </button>
      <button className="settings-btn" onClick={() => setConfirming(false)}>Cancel</button>
    </span>
  );
}

export default function Settings({ settings, onSave, onClose }) {
  const [local, setLocal] = useState(JSON.parse(JSON.stringify(settings)));
  const [autoLaunch, setAutoLaunch] = useState(false);
  const [keyStatus, setKeyStatus] = useState(null);
  const [appInfo, setAppInfo] = useState(null);
  const [updatePhase, setUpdatePhase] = useState(null); // { phase, version?, percent?, message? }
  const refreshKeyStatus = useCallback(async () => {
    const s = await window.cs2stats?.getKeyStatus?.();
    if (s) setKeyStatus(s);
  }, []);

  useEffect(() => {
    window.cs2stats?.getAutoLaunch?.().then(v => setAutoLaunch(!!v));
    window.cs2stats?.getAppInfo?.().then(v => setAppInfo(v));
    // Subscribe to updater events so the Check button can show progress
    // (checking / available / downloading / downloaded / not-available / error).
    // Without this the button click looked unresponsive — every state
    // transition was invisible in the Settings panel.
    window.cs2stats?.onUpdateStatus?.((s) => setUpdatePhase(s));
    refreshKeyStatus();
  }, [refreshKeyStatus]);

  // Human label for each updater phase — surfaced next to the Check button.
  function updatePhaseLabel(p) {
    if (!p) return null;
    switch (p.phase) {
      case 'checking':      return 'Checking…';
      case 'available':     return `Update ${p.version || ''} available — downloading…`;
      case 'downloading':   return `Downloading… ${p.percent ?? 0}%`;
      case 'downloaded':    return `Ready — restart to install ${p.version || ''}`;
      case 'not-available': return 'Up to date';
      case 'error':         return `Error: ${p.message || 'unknown'}`;
      default:              return null;
    }
  }

  async function handleCheckForUpdate() {
    // Optimistic local state so the click feels immediate even before the
    // main process's 'checking' event arrives.
    setUpdatePhase({ phase: 'checking' });
    try {
      const r = await window.cs2stats?.checkForUpdate?.();
      // Dev builds return {phase: 'not-available'} synchronously without
      // emitting events; surface that here.
      if (r && r.error) setUpdatePhase({ phase: 'error', message: r.error });
    } catch (err) {
      setUpdatePhase({ phase: 'error', message: err.message });
    }
  }

  function handleAutoLaunch() {
    const next = !autoLaunch;
    setAutoLaunch(next);
    window.cs2stats?.setAutoLaunch?.(next);
  }

  function toggleTab(key) {
    setLocal((prev) => ({ ...prev, tabView: { ...prev.tabView, [key]: !prev.tabView[key] } }));
  }

  function toggleHover(key) {
    setLocal((prev) => ({ ...prev, hoverDetail: { ...prev.hoverDetail, [key]: !prev.hoverDetail[key] } }));
  }

  function setOpacity(val) {
    setLocal((prev) => ({ ...prev, general: { ...prev.general, opacity: val } }));
    // Apply live so user sees the transparency change as they drag
    window.cs2stats?.previewOpacity?.(val);
  }

  function toggleGeneral(key) {
    setLocal((prev) => ({ ...prev, general: { ...prev.general, [key]: !prev.general[key] } }));
  }

  const bodyRef = React.useRef(null);
  // Scroll by ~80% of the visible area per click, so 2-3 clicks reach either
  // end regardless of panel height. clamp() stays inside scroll bounds.
  const scrollByPage = (dir) => {
    const el = bodyRef.current;
    if (!el) return;
    const delta = Math.max(120, Math.floor(el.clientHeight * 0.8)) * dir;
    el.scrollTop = Math.max(0, Math.min(el.scrollHeight - el.clientHeight, el.scrollTop + delta));
  };

  return (
    <div className="settings-panel">
      <div className="settings-header settings-drag-handle">
        <span className="settings-title">Settings</span>
        <div className="settings-header-actions">
          <button className="settings-scroll-btn" title="Scroll up" onClick={(e) => { e.stopPropagation(); scrollByPage(-1); }}>▲</button>
          <button className="settings-scroll-btn" title="Scroll down" onClick={(e) => { e.stopPropagation(); scrollByPage(1); }}>▼</button>
          <button className="settings-close" onClick={onClose}>&times;</button>
        </div>
      </div>

      <div className="settings-body" ref={bodyRef}>

        {/* ─────────── API Keys ─────────── */}
        <div className="settings-section">
          <SectionTitle>API Keys</SectionTitle>
          <KeyRow
            label="Steam Web API"
            fieldKey="steam"
            status={keyStatus?.steam}
            required
            placeholder="paste Steam Web API key"
            helpUrl="https://steamcommunity.com/dev/apikey"
            helpText="Get key"
            onSaved={refreshKeyStatus}
            onCleared={refreshKeyStatus}
          />
          <div className="settings-key-help">
            Leetify, FACEIT (level + elo), csstats.gg, and csrep.gg all work keylessly.
            Only Steam Web needs a key — for names, avatars, VAC/game-ban status.
          </div>
        </div>

        {/* ─────────── Appearance ─────────── */}
        <div className="settings-section">
          <SectionTitle>Appearance</SectionTitle>
          <div className="settings-slider-row">
            <span className="slider-label">Overlay opacity</span>
            <input
              type="range"
              min="10"
              max="100"
              value={local.general.opacity}
              onChange={(e) => setOpacity(Number(e.target.value))}
              className="settings-slider"
            />
            <span className="slider-value">{local.general.opacity}%</span>
          </div>
          <div className="settings-slider-row">
            <span className="slider-label">Font size</span>
            <div className="settings-font-group">
              <button
                className="settings-font-btn"
                title="Decrease"
                onClick={() => {
                  const cur = local.general.fontScale ?? 100;
                  const v = Math.max(70, cur - 5);
                  setLocal((prev) => ({ ...prev, general: { ...prev.general, fontScale: v } }));
                  window.cs2stats?.previewFontScale?.(v);
                }}
              >A−</button>
              <span className="slider-value settings-font-val">{local.general.fontScale ?? 100}%</span>
              <button
                className="settings-font-btn"
                title="Increase"
                onClick={() => {
                  const cur = local.general.fontScale ?? 100;
                  const v = Math.min(150, cur + 5);
                  setLocal((prev) => ({ ...prev, general: { ...prev.general, fontScale: v } }));
                  window.cs2stats?.previewFontScale?.(v);
                }}
              >A+</button>
              <button
                className="settings-font-btn"
                title="Reset to 100%"
                onClick={() => {
                  setLocal((prev) => ({ ...prev, general: { ...prev.general, fontScale: 100 } }));
                  window.cs2stats?.previewFontScale?.(100);
                }}
              >Reset</button>
            </div>
          </div>
        </div>

        {/* ─────────── Performance ─────────── */}
        <div className="settings-section">
          <SectionTitle>Performance</SectionTitle>
          <div className="settings-perf-row">
            <span className="slider-label">FPS mode</span>
            <div className="settings-perf-group">
              {['battery', 'balanced', 'high'].map((m) => (
                <button
                  key={m}
                  className={`settings-perf-btn ${(local.general.perfMode || 'balanced') === m ? 'active' : ''}`}
                  onClick={() => setLocal((prev) => ({ ...prev, general: { ...prev.general, perfMode: m } }))}
                >
                  {m === 'battery' ? '15 FPS' : m === 'high' ? '60 FPS' : '30 FPS'}
                </button>
              ))}
            </div>
          </div>
          <div className="settings-key-help">
            Battery = 15 FPS overlay + slow cursor polling (lowest CPU). High = 60 FPS + fast polling (smoothest drag on high-refresh monitors).
          </div>
        </div>

        {/* ─────────── TAB Columns ─────────── */}
        <div className="settings-section">
          <SectionTitle>TAB Columns</SectionTitle>
          <CheckboxRow label="Premier Rating" checked={local.tabView.premierRating} onChange={() => toggleTab('premierRating')} />
          <CheckboxRow label="FACEIT Level" checked={local.tabView.faceitLevel} onChange={() => toggleTab('faceitLevel')} />
          <CheckboxRow label="K/D" checked={local.tabView.kd} onChange={() => toggleTab('kd')} />
          <CheckboxRow label="HS%" checked={local.tabView.hsPercent} onChange={() => toggleTab('hsPercent')} />
          <CheckboxRow label="Hours" checked={local.tabView.hours} onChange={() => toggleTab('hours')} />
        </div>

        {/* ─────────── Hover Details ─────────── */}
        <div className="settings-section">
          <SectionTitle>Hover Details</SectionTitle>
          <CheckboxRow label="Legitimacy / Flags" checked={local.hoverDetail.legitimacy} onChange={() => toggleHover('legitimacy')} />
          <CheckboxRow label="Leetify Ratings" checked={local.hoverDetail.leetify} onChange={() => toggleHover('leetify')} />
          <CheckboxRow label="FACEIT Stats" checked={local.hoverDetail.faceit} onChange={() => toggleHover('faceit')} />
          <CheckboxRow label="Steam Lifetime" checked={local.hoverDetail.steamLifetime} onChange={() => toggleHover('steamLifetime')} />
          <CheckboxRow label="Account Info" checked={local.hoverDetail.accountInfo} onChange={() => toggleHover('accountInfo')} />
        </div>

        {/* ─────────── Behavior ─────────── */}
        <div className="settings-section">
          <SectionTitle>Behavior</SectionTitle>
          <CheckboxRow label="Launch on Windows startup" checked={autoLaunch} onChange={handleAutoLaunch} />
          <CheckboxRow
            label="Low-power mode (reduce csstats scraping)"
            checked={!!local.general.lowPowerMode}
            onChange={() => toggleGeneral('lowPowerMode')}
          />
          <CheckboxRow
            label="Disable csstats.gg scraping entirely"
            checked={!!local.general.disableCsstats}
            onChange={() => toggleGeneral('disableCsstats')}
          />
          <div className="settings-key-help">
            Turn off csstats if you're rate-limited or want to preserve its servers. Leetify / FACEIT / Steam still work without it.
          </div>
        </div>

        {/* ─────────── Data / Reset ─────────── */}
        <div className="settings-section">
          <SectionTitle>Data</SectionTitle>
          <div className="settings-action-row">
            <span>csstats.gg rate limit status</span>
            <CsstatsStatusButton />
          </div>
          <div className="settings-action-row">
            <span>Player queue (current match)</span>
            <button className="settings-btn" onClick={() => window.cs2stats?.resetQueue?.()}>Reset queue</button>
          </div>
          <div className="settings-action-row">
            <span>Scoreboard position</span>
            <button className="settings-btn" onClick={() => window.cs2stats?.resetSbPosition?.()}>Reset to center</button>
          </div>
          <div className="settings-action-row">
            <span>Player data cache</span>
            <ConfirmButton label="Clear cache" confirmLabel="Clear" onConfirm={() => window.cs2stats?.clearPlayerCache?.()} danger />
          </div>
          <div className="settings-action-row">
            <span>Full reset</span>
            <ConfirmButton label="Reset all settings" confirmLabel="Reset + relaunch" onConfirm={() => window.cs2stats?.resetAllSettings?.()} danger />
          </div>
        </div>

        {/* ─────────── System ─────────── */}
        <div className="settings-section">
          <SectionTitle>System</SectionTitle>
          <div className="settings-action-row">
            <span>Re-run setup wizard</span>
            <ConfirmButton label="Re-run" confirmLabel="Relaunch" onConfirm={() => window.cs2stats?.reRunSetup?.()} />
          </div>
          <div className="settings-action-row">
            <span>User data folder</span>
            <button className="settings-btn" onClick={() => window.cs2stats?.openUserDataFolder?.()}>Open</button>
          </div>
          <div className="settings-action-row">
            <span>Logs folder (raw — contains your SteamID)</span>
            <button className="settings-btn" onClick={() => window.cs2stats?.openLogsFolder?.()}>Open</button>
          </div>
          <div className="settings-action-row">
            <span>Bug report (sanitized — safe to share)</span>
            <button className="settings-btn settings-btn-primary" onClick={async () => {
              const r = await window.cs2stats?.exportBugReport?.();
              if (r?.ok) alert(`Sanitized report created.\n${r.steamIdsScrubbed} SteamID(s) scrubbed.\nFolder opens in Explorer.`);
              else alert(`Failed: ${r?.reason || 'unknown'}`);
            }}>Export</button>
          </div>
          <div className="settings-action-row">
            <span>
              Check for updates
              {updatePhase && (
                <span style={{ opacity: 0.7, fontSize: '0.85em', marginLeft: 8 }}>
                  — {updatePhaseLabel(updatePhase)}
                </span>
              )}
            </span>
            {updatePhase?.phase === 'downloaded' ? (
              <button className="settings-btn settings-btn-primary" onClick={() => window.cs2stats?.installUpdate?.()}>
                Restart
              </button>
            ) : (
              <button
                className="settings-btn"
                disabled={updatePhase?.phase === 'checking' || updatePhase?.phase === 'downloading'}
                onClick={handleCheckForUpdate}
              >
                {updatePhase?.phase === 'checking' ? 'Checking…' : 'Check'}
              </button>
            )}
          </div>
          <div className="settings-action-row">
            <span>Uninstall (GSI config + auto-launch + app data)</span>
            <ConfirmButton label="Uninstall" confirmLabel="Really uninstall?" danger onConfirm={() => window.cs2stats?.uninstall?.()} />
          </div>
          {appInfo && (
            <div className="settings-about">
              CS2 Stats Overlay v{appInfo.version} · Electron {appInfo.electronVersion}
              {appInfo.buildTag && (
                <div style={{ opacity: 0.6, fontSize: '0.85em', marginTop: 2 }}>
                  Build: {appInfo.buildTag}
                </div>
              )}
            </div>
          )}
        </div>

      </div>

      <div className="settings-actions">
        <button className="settings-save-btn" onClick={() => onSave(local)}>Save & Close</button>
      </div>
    </div>
  );
}
