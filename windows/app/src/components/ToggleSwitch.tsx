export function ToggleSwitch({
  checked,
  disabled = false,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      style={{
        width: 38,
        height: 22,
        padding: 2,
        borderRadius: 999,
        border: 'none',
        background: checked ? 'var(--blue)' : 'var(--switch-off)',
        display: 'inline-flex',
        alignItems: 'center',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        transition: 'background-color 150ms ease',
        flexShrink: 0,
      }}
    >
      <span
        style={{
          width: 18,
          height: 18,
          borderRadius: '50%',
          background: '#ffffff',
          boxShadow: '0 1px 3px rgba(0,0,0,0.22)',
          transform: checked ? 'translateX(16px)' : 'translateX(0)',
          transition: 'transform 160ms cubic-bezier(0.22, 1, 0.36, 1)',
        }}
      />
    </button>
  );
}
