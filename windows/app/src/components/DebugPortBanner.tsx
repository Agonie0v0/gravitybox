import { AlertTriangle, RotateCw } from 'lucide-react';

export function DebugPortBanner({
  title,
  body,
  buttonLabel,
  busy = false,
  compact = false,
  onRelaunch,
}: {
  title: string;
  body: string;
  buttonLabel: string;
  busy?: boolean;
  compact?: boolean;
  onRelaunch: () => void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: compact ? 9 : 11,
        padding: compact ? '9px 10px' : '11px 14px',
        borderRadius: compact ? 11 : 14,
        background: 'var(--warning-soft)',
        border: '1px solid var(--warning-border)',
      }}
    >
      <div
        className="gb-icon-badge"
        style={{
          width: compact ? 26 : 28,
          height: compact ? 26 : 28,
          background: 'var(--warning-soft)',
          border: '0.5px solid var(--warning-border)',
          color: 'var(--warning)',
        }}
      >
        <AlertTriangle size={compact ? 13 : 14} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: compact ? 12 : 13,
            fontWeight: 600,
            color: 'var(--text)',
            lineHeight: 1.3,
          }}
        >
          {title}
        </div>
        <div
          style={{
            fontSize: 11,
            color: 'var(--text-secondary)',
            marginTop: 1,
            lineHeight: 1.35,
          }}
        >
          {body}
        </div>
      </div>
      <button
        type="button"
        className="gb-btn gb-btn-sm"
        disabled={busy}
        onClick={onRelaunch}
      >
        <RotateCw size={12} className={busy ? 'gb-spin' : undefined} />
        <span>{buttonLabel}</span>
      </button>
    </div>
  );
}
