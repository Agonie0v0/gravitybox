import { useState } from 'react';
import { formatCompactTokens, formatInteger, formatUsd } from '../lib/format';
import type { ResolvedLocale } from '../lib/i18n';

export interface TrendBarPoint {
  label: string;
  tooltipLabel: string;
  value: number;
  isFuture?: boolean;
}

export function TrendChart({
  points,
  metric = 'tokens',
  locale,
  height = 128,
  onHover,
}: {
  points: TrendBarPoint[];
  metric?: 'tokens' | 'requests' | 'cost';
  locale: ResolvedLocale;
  height?: number;
  onHover?: (point: TrendBarPoint | null) => void;
}) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  const maxVal = points.reduce((acc, p) => (p.value > acc ? p.value : acc), 0);
  const safeMax = maxVal > 0 ? maxVal : 1;

  const formatAxis = (v: number) => {
    if (v <= 0) return '0';
    if (metric === 'cost') return formatUsd(v);
    if (metric === 'requests') return formatInteger(v, locale);
    return formatCompactTokens(v, locale);
  };

  const count = points.length;
  const xTickIndices = new Set<number>();
  if (count > 0) {
    xTickIndices.add(0);
    xTickIndices.add(count - 1);
    const step = count <= 7 ? 1 : count <= 14 ? 2 : count === 24 ? 4 : Math.max(1, Math.floor(count / 5));
    for (let i = step; i < count - 1; i += step) {
      if (count - 1 - i >= Math.max(1, Math.floor(step / 2))) {
        xTickIndices.add(i);
      }
    }
  }

  return (
    <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'stretch',
          gap: 8,
          height,
          position: 'relative',
        }}
      >
        {/* Y-Axis labels */}
        <div
          className="tabular"
          style={{
            width: 40,
            flexShrink: 0,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            alignItems: 'flex-end',
            fontSize: 10,
            color: 'var(--text-secondary)',
            paddingTop: 2,
            paddingBottom: 2,
          }}
        >
          <span>{maxVal > 0 ? formatAxis(maxVal) : ''}</span>
          {height >= 110 && maxVal > 0 ? <span>{formatAxis(maxVal / 2)}</span> : <span />}
          <span>0</span>
        </div>

        {/* Plot area */}
        <div
          style={{
            flex: 1,
            minWidth: 0,
            position: 'relative',
            display: 'flex',
            alignItems: 'flex-end',
            gap: count > 20 ? 3 : 5,
            paddingTop: 4,
            borderBottom: '1px solid var(--divider)',
          }}
          onMouseLeave={() => {
            setHoveredIdx(null);
            onHover?.(null);
          }}
        >
          {/* Dashed top & middle guide lines */}
          <div
            style={{
              position: 'absolute',
              top: 4,
              left: 0,
              right: 0,
              borderTop: '1px dashed var(--divider)',
              pointerEvents: 'none',
            }}
          />
          {height >= 110 && (
            <div
              style={{
                position: 'absolute',
                top: '50%',
                left: 0,
                right: 0,
                borderTop: '1px dashed var(--divider)',
                opacity: 0.65,
                pointerEvents: 'none',
              }}
            />
          )}

          {points.map((pt, idx) => {
            const pct = maxVal > 0 && pt.value > 0 ? Math.max(5, Math.min(100, (pt.value / safeMax) * 100)) : 0;
            const isHovered = hoveredIdx === idx;
            return (
              <div
                key={`${pt.label}-${idx}`}
                style={{
                  flex: 1,
                  height: '100%',
                  display: 'flex',
                  alignItems: 'flex-end',
                  justifyContent: 'center',
                  cursor: 'pointer',
                  position: 'relative',
                }}
                onMouseEnter={() => {
                  setHoveredIdx(idx);
                  onHover?.(pt);
                }}
              >
                {pct > 0 ? (
                  <div
                    style={{
                      width: '100%',
                      maxWidth: 16,
                      height: `${pct}%`,
                      borderRadius: '4px 4px 1.5px 1.5px',
                      background: isHovered
                        ? 'var(--blue-bright)'
                        : 'linear-gradient(180deg, #2b86ff 0%, #1565e8 100%)',
                      opacity: hoveredIdx !== null && !isHovered ? 0.62 : 1,
                      transition: 'height 220ms cubic-bezier(0.22, 1, 0.36, 1), opacity 120ms ease, background 120ms ease',
                    }}
                  />
                ) : (
                  <div
                    style={{
                      width: '100%',
                      maxWidth: 16,
                      height: 3,
                      borderRadius: 2,
                      background: isHovered ? 'var(--blue-border)' : 'var(--track)',
                      opacity: pt.isFuture ? 0.35 : 0.7,
                    }}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* X-axis tick row */}
      <div
        className="tabular"
        style={{
          display: 'flex',
          alignItems: 'center',
          paddingLeft: 48,
          gap: count > 20 ? 3 : 5,
          fontSize: 10,
          color: 'var(--text-secondary)',
        }}
      >
        {points.map((pt, idx) => (
          <div
            key={`x-${idx}`}
            style={{
              flex: 1,
              textAlign: idx === 0 ? 'left' : idx === count - 1 ? 'right' : 'center',
              whiteSpace: 'nowrap',
              overflow: 'visible',
            }}
          >
            {xTickIndices.has(idx) ? pt.label : ''}
          </div>
        ))}
      </div>
    </div>
  );
}
