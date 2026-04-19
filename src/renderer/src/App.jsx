import React, { useState, useEffect, useCallback, useRef } from 'react';
import Scoreboard from './Scoreboard';
import DetailPanel from './DetailPanel';
import Settings from './Settings';
import Setup from './Setup';
import PerfHud from './PerfHud';

const defaultSettings = {
  tabView: {
    premierRating: true,
    faceitLevel: true,
    kd: true,
    hsPercent: true,
    hours: true,
  },
  hoverDetail: {
    legitimacy: true,
    leetify: true,
    faceit: true,
    steamLifetime: true,
    accountInfo: true,
  },
  general: {
    opacity: 88,
    fancyScoreboard: true,
  },
};

export default function App() {
  const [needsSetup, setNeedsSetup] = useState(null); // null = loading, true/false
  const [serviceStatus, setServiceStatus] = useState({});
  const [visible, setVisible] = useState(false);
  const [players, setPlayers] = useState([]);
  const [liveStats, setLiveStats] = useState({});
  const [map, setMap] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const showSettingsRef = useRef(false);
  const dragStateResetRef = useRef(null);
  useEffect(() => {
    showSettingsRef.current = showSettings;
    window.cs2stats?.setSettingsPin?.(showSettings);
    // Clear any in-flight drag state when settings toggles — mode flips
    // (real events ↔ cursor-poll) can leave drag origins stuck.
    if (dragStateResetRef.current) dragStateResetRef.current();
  }, [showSettings]);

  // ESC closes settings as an escape hatch (no matter the focus state)
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && showSettings) setShowSettings(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showSettings]);

  // Main process can force-close settings (e.g. CS2 closed while pinned)
  useEffect(() => {
    window.cs2stats?.onForceCloseSettings?.(() => setShowSettings(false));
  }, []);
  const [settings, setSettings] = useState(defaultSettings);
  const [selectedPlayer, setSelectedPlayer] = useState(null);
  const [sbMode, setSbMode] = useState('expanded');
  const [sbPos, setSbPos] = useState({ x: 0, y: 0 });
  const clampPos = (pos) => {
    // The overlay window spans the entire virtual screen (all monitors) so the
    // scoreboard should be draggable anywhere inside it but never past an edge.
    // Layout: .sb-positioner is width:100%, padding-top:10vh, flex-centers the
    // .sb-board horizontally. sbPos is applied as a translate() on the positioner.
    // We clamp the translate offset against the natural centered position.
    const board = document.querySelector('.sb-board');
    const margin = 8;
    const winW = window.innerWidth;
    const winH = window.innerHeight;
    if (!board) {
      const maxX = Math.max(0, winW / 2 - 280);
      const maxY = Math.max(0, winH / 2 - 120);
      return { x: Math.max(-maxX, Math.min(maxX, pos.x)), y: Math.max(-maxY, Math.min(maxY, pos.y)) };
    }
    // getBoundingClientRect size (width/height) is unaffected by ancestor translates.
    const r = board.getBoundingClientRect();
    const boardW = r.width;
    const boardH = r.height;
    const paddingTopPx = winH * 0.10;
    const maxX = Math.max(0, (winW - boardW) / 2 - margin);
    const maxYUp = Math.max(0, paddingTopPx - margin);
    const maxYDown = Math.max(0, winH - paddingTopPx - boardH - margin);
    return {
      x: Math.max(-maxX, Math.min(maxX, pos.x)),
      y: Math.max(-maxYUp, Math.min(maxYDown, pos.y)),
    };
  };
  const sbPosRef = useRef({ x: 0, y: 0 });
  // Detail panel position tracking — stored as an ABSOLUTE viewport position
  // that persists across hovers and Tab toggles. When the scoreboard moves,
  // we translate this position by the same delta so the panel follows it.
  // null = no saved position yet, use the scoreboard anchor on first mount.
  const [dpPos, setDpPos] = useState(() => {
    try {
      const raw = sessionStorage.getItem('dp-pos');
      if (raw) {
        const p = JSON.parse(raw);
        if (Number.isFinite(p?.top) && Number.isFinite(p?.left)) {
          return { top: p.top, left: p.left };
        }
      }
    } catch {}
    return null;
  });
  const dpPosRef = useRef(dpPos);
  useEffect(() => { dpPosRef.current = dpPos; }, [dpPos]);
  // Rescale sbPos whenever the zoom factor changes (font size preview or
  // save). CSS pixels get re-mapped, so we scale the saved offset by
  // oldZoom/newZoom to keep the scoreboard in the same physical screen spot.
  // Seed with the current zoom on mount so the first preview tick has a
  // baseline to compute the ratio from.
  const lastZoomRef = useRef(null);
  useEffect(() => {
    lastZoomRef.current = window.cs2stats?.getZoomFactor?.() || 1;
  }, []);
  useEffect(() => {
    window.cs2stats?.onZoomChanged?.((newZoom) => {
      const prev = lastZoomRef.current;
      lastZoomRef.current = newZoom;
      if (!prev || !newZoom || prev === newZoom) return;
      const ratio = prev / newZoom;
      setSbPos((p) => {
        const next = { x: Math.round(p.x * ratio), y: Math.round(p.y * ratio) };
        sbPosRef.current = next;
        window.cs2stats?.savePosition?.(next);
        return next;
      });
      // Similarly rescale the detail panel absolute pos so it stays put.
      setDpPos((p) => {
        if (!p) return p;
        const next = { top: Math.round(p.top * ratio), left: Math.round(p.left * ratio) };
        try { sessionStorage.setItem('dp-pos', JSON.stringify(next)); } catch {}
        return next;
      });
      // And the settings panel position, so it grows in place instead of
      // drifting to a new spot when zoom re-maps CSS pixels.
      setSettingsPos((p) => {
        const next = { x: Math.round(p.x * ratio), y: Math.round(p.y * ratio) };
        settingsPosRef.current = next;
        return next;
      });
    });
  }, []);
  // Follow the scoreboard: when sbPos changes, translate the hover panel's
  // absolute position by the same delta so it sticks to the same relative
  // spot on the scoreboard.
  const prevSbPosRef = useRef({ x: 0, y: 0 });
  useEffect(() => {
    const dx = sbPos.x - prevSbPosRef.current.x;
    const dy = sbPos.y - prevSbPosRef.current.y;
    prevSbPosRef.current = { x: sbPos.x, y: sbPos.y };
    if ((dx !== 0 || dy !== 0) && dpPosRef.current) {
      setDpPos((p) => (p ? { top: p.top + dy, left: p.left + dx } : p));
    }
  }, [sbPos.x, sbPos.y]);
  const [settingsPos, setSettingsPos] = useState({ x: 0, y: 0 });
  const settingsPosRef = useRef({ x: 0, y: 0 });
  useEffect(() => { settingsPosRef.current = settingsPos; }, [settingsPos]);
  const clampSettingsPos = (pos) => {
    // Panel is top-anchored inside .overlay-panel.centered (padding-top: 24px),
    // so Y bounds are asymmetric. Also clamp to the smallest display's height
    // rather than the virtual-screen window height, since the panel should fit
    // on whichever monitor it gets dragged onto.
    const panel = document.querySelector('.settings-panel');
    const margin = 8;
    const paddingTop = 24;
    const winW = window.innerWidth;
    const winH = window.innerHeight;
    const minDisplayH = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--min-display-h')) || winH;
    if (!panel) return pos;
    const r = panel.getBoundingClientRect();
    const maxX = Math.max(0, (winW - r.width) / 2 - margin);
    const maxYUp = Math.max(0, paddingTop - margin);
    const maxYDown = Math.max(0, minDisplayH - paddingTop - r.height - margin);
    return {
      x: Math.max(-maxX, Math.min(maxX, pos.x)),
      y: Math.max(-maxYUp, Math.min(maxYDown, pos.y)),
    };
  };
  // When settings opens, place it where the scoreboard currently sits so the
  // user doesn't have to hunt for it. Clamped to stay on-screen.
  useEffect(() => {
    if (showSettings) {
      // Defer one tick so the panel has rendered and we can measure it.
      const t = setTimeout(() => {
        setSettingsPos(clampSettingsPos({ x: sbPosRef.current.x, y: sbPosRef.current.y }));
      }, 0);
      return () => clearTimeout(t);
    }
  }, [showSettings]);
  const [dragging, setDragging] = useState(false);
  const [setupHint, setSetupHint] = useState(null);
  const [updateStatus, setUpdateStatus] = useState(null);
  useEffect(() => {
    window.cs2stats?.onUpdateStatus?.((s) => setUpdateStatus(s));
    window.cs2stats?.getUpdateStatus?.().then((s) => s && setUpdateStatus(s));
  }, []);
  const dragStart = useRef(null);
  const playersRef = useRef([]);
  const hideTimeout = useRef(null);
  const settingsRef = useRef(null);
  useEffect(() => { settingsRef.current = settings; }, [settings]);
  const COL_MIN = { name: 110, rank: 60, hltv: 40, kd: 34, win: 44, adr: 38, hs: 40, hours: 42 };
  const COL_MAX = { name: 400, rank: 200, hltv: 120, kd: 100, win: 120, adr: 100, hs: 100, hours: 120 };

  useEffect(() => { playersRef.current = players; }, [players]);
  useEffect(() => { sbPosRef.current = sbPos; }, [sbPos]);

  useEffect(() => {
    if (window.cs2stats?.getSettings) {
      window.cs2stats.getSettings().then((saved) => {
        if (saved) {
          setSettings((prev) => ({ ...prev, ...saved }));
          if (saved.general?.sbPosX != null || saved.general?.sbPosY != null) {
            setSbPos(clampPos({ x: saved.general?.sbPosX || 0, y: saved.general?.sbPosY || 0 }));
          }
          // Check if setup is needed
          setNeedsSetup(!saved.general?.setupComplete);
        } else {
          setNeedsSetup(true);
        }
      });
    }

    // Listen for setup show command

    // Service status updates
    window.cs2stats?.onServiceStatus?.((s) => setServiceStatus(s));
    window.cs2stats?.getServiceStatus?.().then(s => s && setServiceStatus(s));

    if (window.cs2stats) {
      window.cs2stats.onOverlayToggle?.((vis) => {
        // When settings panel is open, keep the overlay visible even if Tab is released
        setVisible((prev) => showSettingsRef.current ? true : vis);
        if (!vis && !showSettingsRef.current) {
          setSelectedPlayer(null);
          // Re-enable click-through when hiding
          window._dpClickThrough = true;
          window.cs2stats.setClickThrough?.(true);
          if (dragging) {
            setDragging(false);
          }
        }
      });

      window.cs2stats.onPlayersUpdate?.((data) => {
        if (data.players) setPlayers(data.players);
        if (data.map) setMap(data.map);
        // Real player data arriving = GSI is working; clear any stale hint.
        if (data.players && data.players.length > 0) setSetupHint(null);
      });

      window.cs2stats.onLiveStatsUpdate?.((stats) => {
        setLiveStats(stats);
        // Update team assignments in real-time (e.g., half-time swap)
        if (stats._teams) {
          setPlayers(prev => {
            const teams = stats._teams;
            let changed = false;
            const updated = prev.map(p => {
              if (teams[p.steamId] && teams[p.steamId] !== p.team) {
                changed = true;
                return { ...p, team: teams[p.steamId] };
              }
              return p;
            });
            return changed ? updated : prev;
          });
        }
      });

      window.cs2stats.onShowSettings?.(() => {
        setShowSettings((prev) => !prev);
      });

      window.cs2stats.onSetupHint?.((msg) => {
        // Sticky: stays until GSI data arrives or user clicks to dismiss.
        // Auto-timeout would imply the issue fixed itself — it won't.
        setSetupHint(msg);
      });

      // Cursor hover + drag + click detection (via main process GetCursorPos)
      let sbDragOrigin = null;
      let dpDragOrigin = null;
      let colResizeOrigin = null;
      let settingsDragOrigin = null;
      let wasLmb = false;
      // Exposed so the settings-toggle effect can clear any stuck drag state
      // when the input mode flips between real-events and cursor-poll.
      dragStateResetRef.current = () => {
        sbDragOrigin = null;
        dpDragOrigin = null;
        colResizeOrigin = null;
        settingsDragOrigin = null;
        wasLmb = false;
        dragStart.current = null;
        document.querySelectorAll('.sb-resize-handle.sb-resize-active')
          .forEach(el => el.classList.remove('sb-resize-active'));
      };
      // Drag persistence is stored as a delta from the scoreboard anchor —
      // keeps the panel glued to the scoreboard when you drag the board around.
      const getBoardAnchor = () => {
        const board = document.querySelector('.sb-board');
        if (!board) return { left: 8, top: 8 };
        const r = board.getBoundingClientRect();
        const panelApproxWidth = 340;
        const gap = 12;
        let left = r.right + gap;
        if (left + panelApproxWidth > window.innerWidth - 8) {
          left = Math.max(8, r.left - panelApproxWidth - gap);
        }
        return { left, top: Math.max(8, r.top) };
      };
      let hoverClearTimer = null;

      const hitTest = (selector, x, y) => {
        const els = document.querySelectorAll(selector);
        for (const el of els) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true;
        }
        return false;
      };

      window.cs2stats.onCursorPos?.((pos) => {
        // force-device-scale-factor=1 ensures 1:1 pixel mapping
        const cx = pos.x;
        const cy = pos.y;
        const lmbDown = pos.lmb;
        const lmbJustPressed = lmbDown && !wasLmb;
        const lmbJustReleased = !lmbDown && wasLmb;
        wasLmb = lmbDown;

        // --- Settings panel drag (must come before click dispatch) ---
        if (showSettingsRef.current && lmbDown) {
          if (lmbJustPressed && !settingsDragOrigin && hitTest('.settings-drag-handle', cx, cy)) {
            // Don't start a drag if the press landed on a child control (close button, etc.)
            const target = document.elementFromPoint(cx, cy);
            const onControl = target && (target.closest('button') || target.closest('input'));
            if (!onControl) {
              settingsDragOrigin = { mx: cx, my: cy, sx: settingsPosRef.current.x, sy: settingsPosRef.current.y };
            }
          }
          if (settingsDragOrigin) {
            setSettingsPos(clampSettingsPos({
              x: settingsDragOrigin.sx + cx - settingsDragOrigin.mx,
              y: settingsDragOrigin.sy + cy - settingsDragOrigin.my,
            }));
            return;
          }
        }

        // --- Button clicks (on LMB release) ---
        if (lmbJustReleased && !sbDragOrigin && !dpDragOrigin && !settingsDragOrigin) {
          // Settings panel clickables (iterated so we find the one under the cursor)
          if (showSettingsRef.current) {
            const hitInRect = (r) => cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom;
            const clickable = document.querySelectorAll(
              '.settings-panel button, .settings-panel input[type="checkbox"], .settings-panel input[type="range"]'
            );
            for (const el of clickable) {
              const r = el.getBoundingClientRect();
              if (r.width === 0 || r.height === 0) continue;
              if (hitInRect(r)) {
                if (el.tagName === 'INPUT' && el.type === 'checkbox') {
                  el.checked = !el.checked;
                  el.dispatchEvent(new Event('change', { bubbles: true }));
                } else {
                  el.click();
                }
                return;
              }
            }
            return; // don't fall through to scoreboard dispatch while settings open
          }
          const filterBtn = document.querySelector('.sb-filter-btn');
          if (filterBtn && hitTest('.sb-filter-btn', cx, cy)) {
            filterBtn.click();
            return;
          }
          const reloadBtn = document.querySelector('.sb-reload-btn');
          if (reloadBtn && hitTest('.sb-reload-btn', cx, cy)) {
            reloadBtn.click();
            return;
          }
          const settingsBtn = document.querySelector('.sb-settings-btn');
          if (settingsBtn && hitTest('.sb-settings-btn', cx, cy)) {
            settingsBtn.click();
            return;
          }
          // Detail panel external links (Steam / FACEIT / Leetify / csstats.gg / badge)
          const dpLinks = document.querySelectorAll('.dp-v a[href^="http"]');
          for (const a of dpLinks) {
            const r = a.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) {
              const href = a.getAttribute('href');
              if (href) window.cs2stats?.openExternal?.(href);
              return;
            }
          }
        }

        // --- Slider drag (range inputs) while settings open ---
        if (showSettingsRef.current && lmbDown) {
          const range = document.querySelector('.settings-panel input[type="range"]');
          if (range) {
            const r = range.getBoundingClientRect();
            if (cx >= r.left && cx <= r.right && cy >= r.top - 10 && cy <= r.bottom + 10) {
              const min = Number(range.min) || 0;
              const max = Number(range.max) || 100;
              const pct = Math.max(0, Math.min(1, (cx - r.left) / r.width));
              const value = Math.round(min + pct * (max - min));
              if (String(value) !== range.value) {
                range.value = String(value);
                range.dispatchEvent(new Event('input', { bubbles: true }));
                range.dispatchEvent(new Event('change', { bubbles: true }));
              }
              return;
            }
          }
        }

        // --- Column resize (checked before sb-drag-handle since handles sit on header) ---
        if (lmbDown && !dpDragOrigin && !sbDragOrigin) {
          if (lmbJustPressed && !colResizeOrigin) {
            const handles = document.querySelectorAll('.sb-resize-handle');
            for (const h of handles) {
              const r = h.getBoundingClientRect();
              if (r.width === 0) continue;
              if (cx >= r.left - 2 && cx <= r.right + 2 && cy >= r.top && cy <= r.bottom) {
                const col = h.getAttribute('data-resize-col');
                const colEl = h.closest('.sb-col');
                const startWidth = colEl ? colEl.getBoundingClientRect().width : 60;
                colResizeOrigin = { col, mx: cx, startWidth };
                h.classList.add('sb-resize-active');
                break;
              }
            }
          }
          if (colResizeOrigin) {
            const delta = cx - colResizeOrigin.mx;
            const min = COL_MIN[colResizeOrigin.col] ?? 40;
            const max = COL_MAX[colResizeOrigin.col] ?? 400;
            const newWidth = Math.round(Math.max(min, Math.min(max, colResizeOrigin.startWidth + delta)));
            setSettings(prev => {
              const curr = prev.columnWidths || {};
              if (curr[colResizeOrigin.col] === newWidth) return prev;
              return { ...prev, columnWidths: { ...curr, [colResizeOrigin.col]: newWidth } };
            });
            return;
          }
        }

        // --- Scoreboard drag ---
        if (lmbDown && !dpDragOrigin) {
          if (lmbJustPressed && hitTest('.sb-drag-handle', cx, cy)) {
            sbDragOrigin = { mx: cx, my: cy, sx: sbPosRef.current.x, sy: sbPosRef.current.y };
          }
          if (sbDragOrigin) {
            setSbPos(clampPos({ x: sbDragOrigin.sx + cx - sbDragOrigin.mx, y: sbDragOrigin.sy + cy - sbDragOrigin.my }));
            return;
          }
        }

        // --- Detail panel drag ---
        if (lmbDown && !sbDragOrigin) {
          if (lmbJustPressed) {
            const dpEl = document.querySelector('.dp-v');
            if (dpEl) {
              const r = dpEl.getBoundingClientRect();
              if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) {
                // Skip drag init if the press landed on a link — let the click
                // dispatch on release fire openExternal instead.
                const hitLink = Array.from(dpEl.querySelectorAll('a[href^="http"]')).some(a => {
                  const ar = a.getBoundingClientRect();
                  return ar.width > 0 && ar.height > 0 &&
                    cx >= ar.left && cx <= ar.right && cy >= ar.top && cy <= ar.bottom;
                });
                if (!hitLink) {
                  dpDragOrigin = { mx: cx, my: cy, sl: r.left, st: r.top };
                }
              }
            }
          }
          if (dpDragOrigin) {
            const newLeft = Math.round(dpDragOrigin.sl + cx - dpDragOrigin.mx);
            const newTop = Math.round(dpDragOrigin.st + cy - dpDragOrigin.my);
            const cur = dpPosRef.current;
            if (!cur || cur.left !== newLeft || cur.top !== newTop) {
              const next = { top: newTop, left: newLeft };
              setDpPos(next);
              sessionStorage.setItem('dp-pos', JSON.stringify(next));
            }
            return;
          }
        }

        // --- Release drags ---
        if (lmbJustReleased) {
          if (sbDragOrigin) {
            sbDragOrigin = null;
            setSbPos(p => { window.cs2stats?.savePosition?.(p); return p; });
          }
          if (dpDragOrigin) dpDragOrigin = null;
          if (settingsDragOrigin) settingsDragOrigin = null;
          if (colResizeOrigin) {
            document.querySelectorAll('.sb-resize-handle.sb-resize-active').forEach(el => el.classList.remove('sb-resize-active'));
            colResizeOrigin = null;
            // Persist latest settings (which already contains the new widths from live updates)
            const s = settingsRef.current;
            if (s) window.cs2stats?.saveSettings?.(s);
          }
        }

        // Only block hover during active drags, not all LMB holds
        if (sbDragOrigin || dpDragOrigin || colResizeOrigin || settingsDragOrigin) return;

        // --- Hover: hit-test player rows ---
        // When cursor is over the detail panel, disable click-through so
        // native mouse wheel scroll works. Re-enable when cursor leaves.
        const overPanel = hitTest('.dp-v', cx, cy);
        if (overPanel !== (window._dpClickThrough === false)) {
          window._dpClickThrough = overPanel ? false : true;
          window.cs2stats?.setClickThrough?.(!overPanel);
        }
        if (overPanel) return;

        const rows = document.querySelectorAll('[data-steamid]');
        let found = null;
        for (const row of rows) {
          const rect = row.getBoundingClientRect();
          if (cx >= rect.left && cx <= rect.right && cy >= rect.top && cy <= rect.bottom) {
            found = row.getAttribute('data-steamid');
            break;
          }
        }
        if (found) {
          setSelectedPlayer(prev => {
            if (prev?.steamId === found) return prev;
            return playersRef.current.find(p => p.steamId === found) || null;
          });
        }
        // Don't clear — keep last hovered player's panel open
      });

      // Arrow key selection (backup)
      window.cs2stats.onSelectPlayer?.((dir) => {
        setPlayers(prev => {
          if (prev.length === 0) return prev;
          const currentIdx = selectedPlayer
            ? prev.findIndex(p => p.steamId === selectedPlayer.steamId)
            : -1;
          let newIdx;
          if (dir === 'down') {
            newIdx = currentIdx < prev.length - 1 ? currentIdx + 1 : 0;
          } else {
            newIdx = currentIdx > 0 ? currentIdx - 1 : prev.length - 1;
          }
          setSelectedPlayer(prev[newIdx] || null);
          return prev;
        });
      });

    }

    // Mouse drag for scoreboard + detail panel (forward:true is active when Tab held)
    const handleMouseDown = (e) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (el?.closest('.sb-filter-btn') || el?.closest('.sb-reload-btn') || el?.closest('.sb-settings-btn') || el?.closest('.sb-resize-handle')) return;
      if (el?.closest('.settings-close')) return;
      if (el?.closest('.settings-drag-handle')) {
        dragStart.current = {
          mx: e.clientX, my: e.clientY,
          sx: settingsPosRef.current.x, sy: settingsPosRef.current.y,
          kind: 'settings',
        };
        return;
      }
      if (el?.closest('.sb-drag-handle')) {
        setDragging(true);
        dragStart.current = { mx: e.clientX, my: e.clientY, sx: sbPosRef.current.x, sy: sbPosRef.current.y, kind: 'sb' };
      }
    };
    const handleMouseMove = (e) => {
      const d = dragStart.current;
      if (!d) return;
      const nx = d.sx + e.clientX - d.mx;
      const ny = d.sy + e.clientY - d.my;
      if (d.kind === 'settings') {
        setSettingsPos(clampSettingsPos({ x: nx, y: ny }));
      } else {
        setSbPos(clampPos({ x: nx, y: ny }));
      }
    };
    const handleMouseUp = () => {
      const d = dragStart.current;
      if (!d) return;
      dragStart.current = null;
      if (d.kind === 'settings') return; // settings position not persisted
      setDragging(false);
      setSbPos(p => { window.cs2stats?.savePosition?.(p); return p; });
    };
    const handleKeyDown = (e) => {
      if (e.key === 'Tab') e.preventDefault();
    };
    window.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousedown', handleMouseDown);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  const handleSaveSettings = useCallback((newSettings) => {
    setSettings(newSettings);
    // zoom-changed IPC handler rescales sbPos/dpPos by the old/new zoom
    // ratio, so we don't need to reset position here.
    window.cs2stats?.saveSettings?.(newSettings);
    setShowSettings(false);
  }, []);

  // Show setup on first launch
  if (needsSetup === true) {
    return <Setup onComplete={() => setNeedsSetup(false)} />;
  }
  if (needsSetup === null) return null; // loading

  return (
    <>
    <PerfHud />
    <div className={`overlay-root ${(visible || showSettings) ? 'visible' : 'hidden'}`}>
      {showSettings ? (
        <>
          {/* Clicking anywhere outside the panel dismisses Settings.
              mousedown (not click) so a drag that starts outside +
              ends inside closes, and so it fires before focusable
              widgets steal the click. */}
          <div className="settings-backdrop" onMouseDown={() => setShowSettings(false)} />
          <div
            className="overlay-panel centered"
            style={{ transform: `translate(${settingsPos.x}px, ${settingsPos.y}px)` }}
          >
            <Settings
              settings={settings}
              onSave={handleSaveSettings}
              onClose={() => setShowSettings(false)}
            />
          </div>
        </>
      ) : (
        <>
          <div
            className="sb-positioner"
            style={{ transform: `translate(${sbPos.x}px, ${sbPos.y}px)` }}
          >
            <div className="sb-stack">
              <Scoreboard
                players={players}
                liveStats={liveStats}
                map={map}
                settings={settings}
                selectedPlayer={visible ? selectedPlayer : null}
                compact={sbMode === 'compact'}
                onToggleMode={() => setSbMode(m => m === 'compact' ? 'expanded' : 'compact')}
                onOpenSettings={() => setShowSettings(true)}
                onReloadQueue={() => {
                  window.cs2stats?.resetQueue?.();
                  // Close any open hover and reset it to its default anchor
                  // so the next hover doesn't reuse the old position.
                  setSelectedPlayer(null);
                  setDpPos(null);
                  try { sessionStorage.removeItem('dp-pos'); } catch {}
                }}
                serviceStatus={serviceStatus}
                onSelectPlayer={(p) => setSelectedPlayer(prev => prev?.steamId === p.steamId ? null : p)}
                onHoverPlayer={(p) => {
                  if (p) {
                    setSelectedPlayer(p);
                  }
                  // Don't clear instantly — let user move to detail panel
                }}
              />
              {setupHint && (
                <div className="setup-hint setup-hint-inline" onClick={() => setSetupHint(null)}>
                  <div className="setup-hint-icon">!</div>
                  <div className="setup-hint-text">{setupHint}</div>
                  <div className="setup-hint-dismiss">click to dismiss</div>
                </div>
              )}
              {updateStatus && (updateStatus.phase === 'available' || updateStatus.phase === 'downloading' || updateStatus.phase === 'downloaded') && (
                <div
                  className={`update-banner update-banner-${updateStatus.phase}`}
                  onClick={() => {
                    if (updateStatus.phase === 'downloaded') window.cs2stats?.installUpdate?.();
                  }}
                >
                  <div className="update-banner-icon">↑</div>
                  <div className="update-banner-text">
                    {updateStatus.phase === 'available' && `Update ${updateStatus.version || ''} available — downloading...`}
                    {updateStatus.phase === 'downloading' && `Downloading update... ${updateStatus.percent || 0}%`}
                    {updateStatus.phase === 'downloaded' && `Update ${updateStatus.version || ''} ready — click to restart`}
                  </div>
                </div>
              )}
            </div>
          </div>
          {/* DetailPanel is rendered OUTSIDE .sb-positioner so its
              position:fixed styles resolve against the viewport, not the
              transformed ancestor. Fixes the drag-jump bug. */}
          {visible && selectedPlayer && (
            <DetailPanel player={selectedPlayer} settings={settings} currentMap={map} pattern={liveStats?._patterns?.[selectedPlayer?.steamId]} liveData={liveStats?.[selectedPlayer?.steamId]} sbPos={sbPos} dpPos={dpPos} />
          )}
        </>
      )}
    </div>
    </>
  );
}
