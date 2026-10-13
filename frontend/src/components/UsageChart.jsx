import { useState } from "react";
import { formatNumber } from "../lib/format.js";

/**
 * Daily usage bars for one module and month. Single series, so no legend - the heading names it.
 * Bars: thin, 4px rounded tops anchored to the baseline, 2px gaps; hover/focus shows the exact value.
 */
export default function UsageChart({ days, unit, month, label, emptyText }) {
  const [hover, setHover] = useState(null);
  const y = Math.floor(month / 100);
  const m = month % 100;
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const byDay = Object.fromEntries((days || []).map((d) => [Number(d.day.slice(8, 10)), d]));
  const series = Array.from({ length: daysInMonth }, (_, i) => ({ day: i + 1, total: byDay[i + 1]?.total ?? null, readings: byDay[i + 1]?.readings ?? 0 }));
  const max = Math.max(0, ...series.map((s) => s.total || 0));

  if (!max) {
    return (
      <div className="chart empty">
        {emptyText ? (
          <p>{emptyText}</p>
        ) : (
          <>
            <p>No {label.toLowerCase()} readings for this month yet.</p>
            <p className="muted small">They appear here as soon as the data feed sends them to the backend.</p>
          </>
        )}
      </div>
    );
  }

  const niceMax = niceCeil(max);
  const W = 640;
  const H = 220;
  const pad = { l: 44, r: 8, t: 12, b: 24 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const slot = iw / daysInMonth;
  const bw = Math.max(2, slot - 2);
  const ticks = [0, niceMax / 2, niceMax];

  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Daily ${label} usage in ${unit}`} onMouseLeave={() => setHover(null)}>
        {ticks.map((t) => {
          const yy = pad.t + ih - (t / niceMax) * ih;
          return (
            <g key={t}>
              <line x1={pad.l} x2={W - pad.r} y1={yy} y2={yy} className="grid" />
              <text x={pad.l - 6} y={yy + 4} className="axis" textAnchor="end">
                {formatNumber(t, t < 10 ? 1 : 0)}
              </text>
            </g>
          );
        })}
        {series.map((s, i) => {
          const x = pad.l + i * slot + 1;
          const h = s.total ? Math.max(1, (s.total / niceMax) * ih) : 0;
          const top = pad.t + ih - h;
          const r = Math.min(4, bw / 2, h);
          return (
            <g key={s.day}>
              {h > 0 && (
                <path
                  className={`bar ${hover === i ? "on" : ""}`}
                  d={`M${x},${pad.t + ih} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${pad.t + ih} Z`}
                />
              )}
              <rect
                x={pad.l + i * slot}
                y={pad.t}
                width={slot}
                height={ih}
                fill="transparent"
                tabIndex={s.total ? 0 : -1}
                onMouseEnter={() => setHover(i)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
              />
              {(s.day === 1 || s.day % 5 === 0) && (
                <text x={x + bw / 2} y={H - 6} className="axis" textAnchor="middle">
                  {s.day}
                </text>
              )}
            </g>
          );
        })}
        <line x1={pad.l} x2={W - pad.r} y1={pad.t + ih} y2={pad.t + ih} className="baseline" />
      </svg>
      {hover !== null && series[hover].total !== null && (
        <div className="tip" style={{ left: `${((pad.l + hover * slot + slot / 2) / W) * 100}%` }}>
          <strong>
            {formatNumber(series[hover].total)} {unit}
          </strong>
          <span>
            Day {series[hover].day} · {series[hover].readings} reading{series[hover].readings === 1 ? "" : "s"}
          </span>
        </div>
      )}
    </div>
  );
}

function niceCeil(v) {
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}
