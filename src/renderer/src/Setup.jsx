import React, { useState } from 'react';
import appIcon from './assets/app-icon.png';

function ExtLink({ href, children }) {
  return (
    <a className="setup-link" href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

function InfoTip({ text }) {
  return (
    <span className="setup-info" tabIndex={0} aria-label={text}>
      <span className="setup-info-mark">?</span>
      <span className="setup-info-pop">{text}</span>
    </span>
  );
}

export default function Setup({ onComplete }) {
  const [step, setStep] = useState(0);
  const [keys, setKeys] = useState({ steam: '' });
  const [saving, setSaving] = useState(false);
  const [autoLaunch, setAutoLaunch] = useState(false);
  const [csstatsEnabled, setCsstatsEnabled] = useState(true);
  const [validation, setValidation] = useState(null);

  const updateKey = (k, v) => {
    setKeys(prev => ({ ...prev, [k]: v }));
    setValidation(null);
  };

  const handleSaveKeys = async () => {
    if (!keys.steam) {
      setStep(1);
      return;
    }
    setSaving(true);
    setValidation({ testing: true });
    const result = await window.cs2stats?.validateApiKeys?.(keys);
    setValidation(result);
    if (result?.steam?.ok) {
      await window.cs2stats?.saveApiKeys?.(keys);
      setSaving(false);
      setStep(1);
    } else {
      setSaving(false);
    }
  };

  const handleFinish = async () => {
    if (autoLaunch) await window.cs2stats?.setAutoLaunch?.(true);
    try {
      const s = await window.cs2stats?.getSettings?.();
      if (s) {
        s.general = s.general || {};
        s.general.disableCsstats = !csstatsEnabled;
        await window.cs2stats?.saveSettings?.(s);
      }
    } catch {}
    await window.cs2stats?.completeSetup?.();
    onComplete();
  };

  return (
    <div className="setup-root">
      <div className="setup-card">
        <div className="setup-titlebar" title="Drag to move">
          <div className="setup-titlebar-left">
            <img className="setup-titlebar-icon" src={appIcon} alt="" />
            <span className="setup-titlebar-label">CS2 Stats Overlay — Setup</span>
          </div>
          <button
            className="setup-close"
            onClick={() => window.cs2stats?.quitApp?.()}
            title="Close"
          >×</button>
        </div>
        <div className="setup-drag">
          <div className="setup-brand">
            <img className="setup-brand-icon" src={appIcon} alt="CS2 Stats Overlay" />
            <div>
              <div className="setup-title">CS2 Stats Overlay</div>
              <div className="setup-subtitle">
                {step === 0 ? 'API keys (all optional)' : 'csstats.gg'}
              </div>
            </div>
          </div>
        </div>

        {step === 0 && (
          <div className="setup-form">
            <p className="setup-desc">
              Leetify, FACEIT elo/level, and csstats.gg all work with zero keys. A Steam API
              key unlocks extra profile data (avatars, VAC/game-ban status) — optional.
            </p>
            <div className="setup-field">
              <label>
                Steam API Key
                <InfoTip text="Unlocks avatars/names, VAC/game-ban status, friends-list metadata. Purely HTTPS — no Steam account login required." />
                <ExtLink href="https://steamcommunity.com/dev/apikey">Get key</ExtLink>
              </label>
              <input
                type="text"
                placeholder="Profile + ban lookups (optional)"
                value={keys.steam}
                onChange={e => updateKey('steam', e.target.value)}
              />
            </div>
            {validation?.testing && (
              <div className="setup-status">Validating keys...</div>
            )}
            {validation && !validation.testing && validation.steam && !validation.steam.optional && (
              <div className={`setup-status ${validation.steam.ok ? 'setup-success' : 'setup-error'}`}>
                {validation.steam.ok ? '✓ Steam key valid' : `✗ Steam: ${validation.steam.reason}`}
              </div>
            )}
            <button className="setup-btn" onClick={handleSaveKeys} disabled={saving}>
              {saving ? 'Validating...' : 'Next'}
            </button>
            <button className="setup-skip" onClick={() => setStep(1)}>Skip — use Leetify only (public, keyless)</button>
          </div>
        )}

        {step === 1 && (
          <div className="setup-form">
            <p className="setup-desc">
              csstats.gg is scraped publicly — no login needed. This unlocks lifetime stats,
              map-specific ratings, clutch/entry rates, and the last-30-matches aggregate
              (K/D, ADR, HLTV rating, HS%, win-rate).
            </p>
            <label className="setup-checkbox">
              <input
                type="checkbox"
                checked={csstatsEnabled}
                onChange={e => setCsstatsEnabled(e.target.checked)}
              />
              <span>Scrape csstats.gg for player data (recommended)</span>
            </label>
            <div className="setup-csstats-cta">
              <div className="setup-csstats-cta-title">Want your own profile tracked?</div>
              <div className="setup-csstats-cta-body">
                Free — lets csstats.gg build long-term stats for your account, which also feeds
                this overlay. Totally optional.
              </div>
              <ExtLink href="https://csstats.gg">Sign up at csstats.gg →</ExtLink>
            </div>
            <label className="setup-checkbox">
              <input
                type="checkbox"
                checked={autoLaunch}
                onChange={e => setAutoLaunch(e.target.checked)}
              />
              <span>Start automatically when Windows boots</span>
            </label>
            <button className="setup-btn setup-btn-finish" onClick={handleFinish}>
              Start Overlay
            </button>
          </div>
        )}

        <div className="setup-steps">
          <span className={`setup-dot ${step >= 0 ? 'active' : ''}`} />
          <span className={`setup-dot ${step >= 1 ? 'active' : ''}`} />
        </div>
      </div>
    </div>
  );
}
