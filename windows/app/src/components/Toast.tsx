import { AlertCircle, CheckCircle2, X } from 'lucide-react';

export interface ToastMessage {
  id: number;
  message: string;
  error?: boolean;
}

export function ToastBanner({
  toast,
  onClose,
}: {
  toast: ToastMessage | null;
  onClose: () => void;
}) {
  if (!toast) return null;
  return (
    <div
      className="gb-fade-in"
      style={{
        position: 'fixed',
        bottom: 16,
        right: 18,
        zIndex: 1500,
        maxWidth: 420,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '9px 12px',
        borderRadius: 10,
        background: 'var(--card)',
        border: toast.error ? '1px solid var(--danger-border)' : '1px solid var(--border-strong)',
        boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
        color: 'var(--text)',
        fontSize: 12,
      }}
    >
      {toast.error ? (
        <AlertCircle size={15} style={{ color: 'var(--danger)', flexShrink: 0 }} />
      ) : (
        <CheckCircle2 size={15} style={{ color: 'var(--success)', flexShrink: 0 }} />
      )}
      <span style={{ flex: 1, lineHeight: 1.35 }}>{toast.message}</span>
      <button
        type="button"
        className="gb-btn gb-btn-ghost gb-icon-btn"
        style={{ width: 22, height: 22 }}
        onClick={onClose}
      >
        <X size={13} />
      </button>
    </div>
  );
}
