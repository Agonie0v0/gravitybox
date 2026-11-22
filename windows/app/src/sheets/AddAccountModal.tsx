import { useEffect, useRef, useState } from 'react';
import {
  Download,
  FilePlus2,
  FolderOpen,
  Globe,
  KeyRound,
  Loader2,
  UserCheck,
  UserPlus,
} from 'lucide-react';
import { Modal } from '../components/Modal';
import { useApp } from '../context/AppContext';
import {
  backendRequest,
  openExternalUrl,
  pickImportJsonFiles,
  pickSaveJsonPath,
} from '../lib/tauri';

export function AddAccountModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { t, locale, status, accounts, refreshAll, showToast, askConfirm } = useApp();
  const [busy, setBusy] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [showManualToken, setShowManualToken] = useState(false);
  const [refreshToken, setRefreshToken] = useState('');
  const [oauthSessionId, setOauthSessionId] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  const currentEmail = (status.liveAccountEmail || status.activeAccountEmail || '').trim();
  const oauthConfigured = status.oauthClientConfigured === true;

  const stopPolling = () => {
    if (pollRef.current) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  useEffect(() => {
    if (!open) {
      stopPolling();
      setBusy(false);
      setStatusMsg('');
      setErrorMsg('');
      setShowManualToken(false);
      setRefreshToken('');
      setOauthSessionId(null);
    }
    return () => stopPolling();
  }, [open]);

  const handleSaveCurrent = async () => {
    setErrorMsg('');
    setStatusMsg(t('add_account.status.reading_current'));
    setBusy(true);
    try {
      await backendRequest({ command: 'account_save_current' });
      await refreshAll(true);
      showToast(t('oauth.msg.succeeded'));
      onClose();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStatusMsg('');
    } finally {
      setBusy(false);
    }
  };

  const handleImport = async (directory: boolean) => {
    setErrorMsg('');
    const paths = await pickImportJsonFiles(t('add_account.import_panel_title'), directory);
    if (paths.length === 0) return;
    setStatusMsg(t('add_account.status.importing_json'));
    setBusy(true);
    try {
      const res = await backendRequest<{
        imported?: number;
        updated?: number;
        skipped?: Array<{ reason?: string }>;
        expiredWithoutRefreshConfig?: number;
      }>({ command: 'account_import_json', paths });
      const imported = res.imported ?? 0;
      const updated = res.updated ?? 0;
      const skipped = res.skipped ?? [];
      if (imported + updated === 0) {
        const reason = skipped[0]?.reason ?? (locale === 'en' ? 'No account records found' : '未找到任何账号记录');
        setErrorMsg(t('add_account.import.none_imported', { skipped: Math.max(1, skipped.length), reason }));
        setStatusMsg('');
        return;
      }
      let msg = t('add_account.import.success_summary', { imported, updated });
      if (skipped.length > 0) {
        msg += t('add_account.import.skipped_suffix', { skipped: skipped.length });
      }
      showToast(msg);
      await refreshAll(true);
      onClose();
      if ((res.expiredWithoutRefreshConfig ?? 0) > 0) {
        await askConfirm({
          title: t('add_account.import.expired_notice_title'),
          body: t('add_account.import.expired_notice_body', {
            total: imported + updated,
            expired: res.expiredWithoutRefreshConfig ?? 0,
          }),
          confirmLabel: t('common.ok'),
        });
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStatusMsg('');
    } finally {
      setBusy(false);
    }
  };

  const handleExport = async () => {
    if (accounts.length === 0) return;
    const confirmed = await askConfirm({
      title: t('accounts.export.confirm_title'),
      body: t('accounts.export.confirm_body'),
      confirmLabel: t('accounts.export.confirm_action'),
      danger: true,
    });
    if (!confirmed) return;

    const now = new Date();
    const tag = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const targetPath = await pickSaveJsonPath(
      t('accounts.export.panel_title'),
      `gravitybox-accounts-backup-${tag}.json`,
    );
    if (!targetPath) return;

    setErrorMsg('');
    setStatusMsg(t('add_account.status.exporting_json'));
    setBusy(true);
    try {
      const res = await backendRequest<{ count?: number }>({
        command: 'account_export_backup',
        path: targetPath,
        confirmed: true,
      });
      const fileName = targetPath.split(/[\\/]/).pop() ?? targetPath;
      showToast(t('accounts.export.success', { count: res.count ?? accounts.length, name: fileName }));
      onClose();
    } catch (err) {
      setErrorMsg(t('accounts.export.failed', { error: err instanceof Error ? err.message : String(err) }));
      setStatusMsg('');
    } finally {
      setBusy(false);
    }
  };

  const handleOAuthBegin = async () => {
    setErrorMsg('');
    setStatusMsg(t('add_account.status.opening_google'));
    setBusy(true);
    try {
      const res = await backendRequest<{ id?: string; authUrl?: string; url?: string }>({
        command: 'account_oauth_begin',
      });
      const authUrl = res.authUrl || res.url || '';
      const id = res.id || '';
      if (!authUrl || !id) {
        throw new Error(t('add_account.error.invalid_url'));
      }
      setOauthSessionId(id);
      setStatusMsg(t('add_account.status.complete_in_browser'));
      await openExternalUrl(authUrl);

      stopPolling();
      pollRef.current = window.setInterval(async () => {
        try {
          const st = await backendRequest<{ state?: string; status?: string; error?: string; message?: string }>({
            command: 'account_oauth_status',
            id,
          });
          const phase = st.state || st.status || '';
          if (phase === 'succeeded' || phase === 'completed') {
            stopPolling();
            setOauthSessionId(null);
            setBusy(false);
            showToast(st.message || t('oauth.msg.succeeded'));
            await refreshAll(true);
            onClose();
          } else if (phase === 'failed' || phase === 'cancelled' || phase === 'expired') {
            stopPolling();
            setOauthSessionId(null);
            setBusy(false);
            setStatusMsg('');
            setErrorMsg(st.error || st.message || t('add_account.error.incomplete'));
          }
        } catch {
          // keep polling
        }
      }, 900);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStatusMsg('');
      setBusy(false);
    }
  };

  const handleCancelOAuthOrClose = async () => {
    if (oauthSessionId) {
      stopPolling();
      await backendRequest({ command: 'account_oauth_cancel', id: oauthSessionId }).catch(() => {});
      setOauthSessionId(null);
      setBusy(false);
      setStatusMsg('');
      return;
    }
    if (!busy) onClose();
  };

  const handleAddRefreshToken = async () => {
    const token = refreshToken.trim();
    if (!token) {
      setErrorMsg(t('accounts.err.invalid_refresh_token'));
      return;
    }
    setErrorMsg('');
    setStatusMsg(t('add_account.status.saving'));
    setBusy(true);
    try {
      const start = await backendRequest<{ taskId?: string }>({
        command: 'account_add_token_start',
        refreshToken: token,
      });
      const taskId = start.taskId;
      if (taskId) {
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 400));
          const list = await backendRequest<{ tasks?: Array<{ id: string; state: string; message?: string; error?: string }> }>({
            command: 'task_list',
          }).catch(() => null);
          const task = list?.tasks?.find((x) => x.id === taskId);
          if (!task || task.state !== 'running') {
            if (task?.state === 'failed') {
              throw new Error(task.error || task.message || t('assistant.action_incomplete'));
            }
            if (task?.message) showToast(task.message);
            break;
          }
        }
      }
      await refreshAll(true);
      setRefreshToken('');
      onClose();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStatusMsg('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={handleCancelOAuthOrClose} maxWidth={500}>
      <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12, overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div
            className="gb-icon-badge"
            style={{
              width: 32,
              height: 32,
              background: 'var(--blue-soft)',
              border: '0.5px solid var(--blue-border)',
              color: 'var(--blue)',
            }}
          >
            <UserPlus size={16} />
          </div>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>{t('add_account.title')}</h3>
        </div>

        {/* Card 1: Save current active Antigravity account */}
        <div className="gb-card" style={{ padding: 13, display: 'flex', alignItems: 'center', gap: 12 }}>
          <div
            className="gb-icon-badge"
            style={{ background: 'var(--blue-soft)', border: '0.5px solid var(--blue-border)', color: 'var(--blue)' }}
          >
            <UserCheck size={15} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>{t('add_account.current_card_title')}</div>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
              {t('add_account.save_current_sub')}
            </div>
            {currentEmail && (
              <div
                className="selectable"
                style={{
                  fontSize: 11.5,
                  color: 'var(--text-secondary)',
                  marginTop: 3,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {currentEmail}
              </div>
            )}
          </div>
          <button
            type="button"
            className="gb-btn gb-btn-primary"
            disabled={busy}
            onClick={handleSaveCurrent}
          >
            {t('add_account.save_current')}
          </button>
        </div>

        {/* Card 2: Import JSON files or folder */}
        <div className="gb-card" style={{ padding: 13, display: 'flex', alignItems: 'center', gap: 12 }}>
          <div
            className="gb-icon-badge"
            style={{ background: 'var(--blue-soft)', border: '0.5px solid var(--blue-border)', color: 'var(--blue)' }}
          >
            <FilePlus2 size={15} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>{t('add_account.import_json_title')}</div>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
              {t('add_account.import_json_sub')}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              type="button"
              className="gb-btn gb-btn-sm"
              disabled={busy}
              onClick={() => handleImport(false)}
            >
              {t('add_account.import_json_btn')}
            </button>
            <button
              type="button"
              className="gb-btn gb-btn-sm gb-icon-btn"
              title={locale === 'en' ? 'Import folder' : '选择文件夹'}
              disabled={busy}
              onClick={() => handleImport(true)}
            >
              <FolderOpen size={13} />
            </button>
          </div>
        </div>

        {/* Card 3: Export backup JSON */}
        <div className="gb-card" style={{ padding: 13, display: 'flex', alignItems: 'center', gap: 12 }}>
          <div
            className="gb-icon-badge"
            style={{ background: 'var(--blue-soft)', border: '0.5px solid var(--blue-border)', color: 'var(--blue)' }}
          >
            <Download size={15} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>{t('add_account.export_title')}</div>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
              {accounts.length > 0
                ? t('add_account.export_sub', { count: accounts.length })
                : t('add_account.export_sub_empty')}
            </div>
          </div>
          <button
            type="button"
            className="gb-btn gb-btn-sm"
            disabled={busy || accounts.length === 0}
            onClick={handleExport}
          >
            {t('add_account.export_btn')}
          </button>
        </div>

        {/* Card 4: Google OAuth & Manual Refresh Token */}
        <div className="gb-card" style={{ padding: 13, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div
              className="gb-icon-badge"
              style={{ background: 'var(--blue-soft)', border: '0.5px solid var(--blue-border)', color: 'var(--blue)' }}
            >
              <Globe size={15} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{t('add_account.google_title')}</div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
                {oauthConfigured
                  ? t('add_account.google_sub')
                  : locale === 'en'
                  ? 'Supports OAuth login (when configured in .env) or manual Refresh Token'
                  : '支持 OAuth 浏览器授权（配置 .env 后）或手动填写 Refresh Token'}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              {oauthConfigured && (
                <button
                  type="button"
                  className="gb-btn gb-btn-sm"
                  disabled={busy}
                  onClick={handleOAuthBegin}
                >
                  {t('add_account.google_btn')}
                </button>
              )}
              <button
                type="button"
                className="gb-btn gb-btn-sm"
                disabled={busy}
                onClick={() => setShowManualToken((v) => !v)}
              >
                <KeyRound size={12} />
                <span>{locale === 'en' ? 'Token' : '手动 Token'}</span>
              </button>
            </div>
          </div>

          {showManualToken && (
            <div style={{ display: 'flex', gap: 8, paddingTop: 4, borderTop: '1px solid var(--divider)' }}>
              <input
                type="password"
                className="gb-input"
                style={{ flex: 1 }}
                placeholder={locale === 'en' ? 'Paste Google Refresh Token (1//...)' : '粘贴 Google Refresh Token（1//...）'}
                value={refreshToken}
                disabled={busy}
                onChange={(e) => setRefreshToken(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleAddRefreshToken();
                }}
              />
              <button
                type="button"
                className="gb-btn gb-btn-primary gb-btn-sm"
                disabled={busy || !refreshToken.trim()}
                onClick={handleAddRefreshToken}
              >
                {t('common.save')}
              </button>
            </div>
          )}
        </div>

        {(statusMsg || errorMsg) && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 12,
              color: errorMsg ? 'var(--danger)' : 'var(--text-secondary)',
              padding: '2px 2px 0',
            }}
          >
            {busy && <Loader2 size={14} className="gb-spin" style={{ color: 'var(--blue)', flexShrink: 0 }} />}
            <span>{errorMsg || statusMsg}</span>
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, paddingTop: 4 }}>
          <button
            type="button"
            className="gb-btn"
            disabled={busy && !oauthSessionId}
            onClick={handleCancelOAuthOrClose}
          >
            {t('common.cancel')}
          </button>
        </div>
      </div>
    </Modal>
  );
}
