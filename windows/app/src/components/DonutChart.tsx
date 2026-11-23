import { formatUsd } from '../lib/format';

export interface DonutSlice {
  label: string;
  usd: number;
  color: string;
}

export const DONUT_PALETTE = [
  '#2563eb',
  '#0d9488',
  '#7c3aed',
  '#d97706',
  '#4f46e5',
  '#db2777',
];

export function DonutChart({
  slices,
  totalUsd,
  centerCaption,
  size = 114,
}: {
  slices: DonutSlice[];
  totalUsd: number;
  centerCaption: string;
  size?: number;
}) {
  const stroke = 11;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const sum = slices.reduce((acc, s) => acc + Math.max(0, s.usd), 0);
  const effectiveTotal = Math.max(totalUsd, sum, 1e-9);

  let accLen = 0;
  const gap = slices.length > 1 ? 2.5 : 0;

  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--track)"
          strokeWidth={stroke}
        />
        {slices.map((s, idx) => {
          const frac = Math.max(0, s.usd) / effectiveTotal;
          const rawLen = frac * c;
          const dashLen = Math.max(0, rawLen - gap);
          const dashOffset = -accLen;
          accLen += rawLen;
          if (dashLen <= 0.2) return null;
          return (
            <circle
              key={`${s.label}-${idx}`}
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={s.color}
              strokeWidth={stroke}
              strokeDasharray={`${dashLen} ${c - dashLen}`}
              strokeDashoffset={dashOffset}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
              style={{ transition: 'stroke-dasharray 260ms ease' }}
            />
          );
        })}
      </svg>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          textAlign: 'center',
          pointerEvents: 'none',
          padding: 14,
        }}
      >
        <div
          className="tabular"
          style={{
            fontSize: 15,
            fontWeight: 700,
            color: 'var(--text)',
            lineHeight: 1.15,
          }}
        >
          {formatUsd(totalUsd)}
        </div>
        <div
          style={{
            fontSize: 10,
            color: 'var(--text-secondary)',
            marginTop: 2,
          }}
        >
          {centerCaption}
        </div>
      </div>
    </div>
  );
}
