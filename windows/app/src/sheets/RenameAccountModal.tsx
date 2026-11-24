import { useEffect, useState } from 'react';
import { Modal } from '../components/Modal';
import { useApp } from '../context/AppContext';
import { backendRequest } from '../lib/tauri';

export function RenameAccountModal({
  account,
  onClose,
}: {
  account: { id: string; email: string; name?: string } | null;
  onClose: () => void;
}) {
  const { t, fetchAccounts, showToast } = useApp();
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (account) setName(account.name ?? '');
  }, [account]);

  const trimmed = name.trim();
  const canSave = Boolean(account) && trimmed.length <= 80 && trimmed !== (account?.name ?? '').trim();

  const handleSave = async () => {
    if (!account || !canSave) return;
    setSaving(true);
    try {
      await backendRequest({ command: 'account_rename', id: account.id, name: trimmed });
      await fetchAccounts();
      onClose();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={Boolean(account)} onClose={onClose} maxWidth={390}>
      <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>{t('accounts.rename.title')}</h3>
          <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 3 }}>{account?.email}</div>
        </div>
        <input
          type="text"
          className="gb-input"
          style={{ width: '100%', height: 32 }}
          maxLength={80}
          placeholder={t('accounts.rename.placeholder')}
          value={name}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && canSave) void handleSave();
          }}
        />
        <div className="gb-divider" />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="gb-btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="gb-btn gb-btn-primary"
            disabled={!canSave || saving}
            onClick={handleSave}
          >
            {t('common.save')}
          </button>
        </div>
      </div>
    </Modal>
  );
}
