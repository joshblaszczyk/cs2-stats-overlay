import React, { useState, useEffect } from 'react';

export default function PerfHud() {
  const [visible, setVisible] = useState(false);
  const [metrics, setMetrics] = useState({ rssMB: 0, cpuPct: 0, gsiPerSec: 0 });

  useEffect(() => {
    window.cs2stats?.onPerfMetrics?.((m) => setMetrics(m));
    window.cs2stats?.onPerfHudToggle?.((v) => setVisible(v));
  }, []);

  if (!visible) return null;

  return (
    <div className="perf-hud">
      <div>RAM  {metrics.rssMB} MB</div>
      <div>CPU  {metrics.cpuPct}%</div>
      <div>GSI  {metrics.gsiPerSec}/s</div>
    </div>
  );
}
