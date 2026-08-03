/** Lightweight SVG charts for Super Admin — no external chart library. */

export type ChartPoint = { label: string; value: number };

function maxOf(points: ChartPoint[], min = 1) {
  return Math.max(min, ...points.map((p) => Number(p.value) || 0));
}

export function AreaChart({
  points,
  color = '#38bdf8',
  height = 180,
}: {
  points: ChartPoint[];
  color?: string;
  height?: number;
}) {
  const w = 640;
  const h = height;
  const pad = 16;
  const data = points.length ? points : [{ label: '—', value: 0 }];
  const max = maxOf(data);
  const step = data.length > 1 ? (w - pad * 2) / (data.length - 1) : 0;
  const coords = data.map((p, i) => {
    const x = pad + i * step;
    const y = h - pad - ((Number(p.value) || 0) / max) * (h - pad * 2);
    return `${x},${y}`;
  });
  const line = coords.join(' ');
  const area = `${pad},${h - pad} ${line} ${pad + (data.length - 1) * step},${h - pad}`;
  const gradId = `sa-grad-${color.replace('#', '')}`;

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="sa-chart-svg" preserveAspectRatio="none">
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.45" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polyline fill={`url(#${gradId})`} stroke="none" points={area} />
      <polyline fill="none" stroke={color} strokeWidth="2.5" points={line} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function BarChart({
  points,
  color = '#34d399',
  height = 160,
}: {
  points: ChartPoint[];
  color?: string;
  height?: number;
}) {
  const data = points.length ? points : [{ label: '—', value: 0 }];
  const max = maxOf(data);
  return (
    <div className="sa-bar-chart" style={{ height }}>
      {data.map((p) => (
        <div key={p.label} className="sa-bar-col" title={`${p.label}: ${p.value}`}>
          <div
            className="sa-bar-fill"
            style={{
              height: `${Math.max(6, ((Number(p.value) || 0) / max) * 100)}%`,
              background: `linear-gradient(180deg, ${color}, ${color}88)`,
            }}
          />
          <span>{/^\d{4}-\d{2}/.test(String(p.label)) ? String(p.label).slice(5) : p.label}</span>
        </div>
      ))}
    </div>
  );
}

export function DonutChart({
  segments,
  size = 160,
  centerLabel,
  centerValue,
}: {
  segments: { label: string; value: number; color: string }[];
  size?: number;
  centerLabel?: string;
  centerValue?: string | number;
}) {
  const total = segments.reduce((s, x) => s + (Number(x.value) || 0), 0) || 1;
  const r = 42;
  const c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <div className="sa-donut-wrap">
      <svg width={size} height={size} viewBox="0 0 120 120" className="sa-donut">
        <circle cx="60" cy="60" r={r} fill="none" stroke="rgba(148,163,184,0.12)" strokeWidth="12" />
        {segments.map((seg) => {
          const len = (Number(seg.value) / total) * c;
          const el = (
            <circle
              key={seg.label}
              cx="60"
              cy="60"
              r={r}
              fill="none"
              stroke={seg.color}
              strokeWidth="12"
              strokeDasharray={`${len} ${c - len}`}
              strokeDashoffset={-offset}
              strokeLinecap="butt"
              transform="rotate(-90 60 60)"
            />
          );
          offset += len;
          return el;
        })}
        <text x="60" y="56" textAnchor="middle" className="sa-donut-value">{centerValue ?? total}</text>
        <text x="60" y="72" textAnchor="middle" className="sa-donut-label">{centerLabel || 'Total'}</text>
      </svg>
      <div className="sa-donut-legend">
        {segments.map((s) => (
          <div key={s.label} className="sa-legend-row">
            <span className="sa-dot" style={{ background: s.color }} />
            <span>{s.label}</span>
            <strong>{s.value}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}

export function SparkTrend({ up, label }: { up?: boolean; label: string }) {
  return (
    <span className={`sa-trend ${up ? 'up' : 'flat'}`}>
      <span aria-hidden>{up ? '▲' : '●'}</span> {label}
    </span>
  );
}
