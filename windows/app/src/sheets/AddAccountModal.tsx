import { useEffect, useRef, useState } from 'react';
import {
  Check,
  Copy,
  Download,
  ExternalLink,
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
  getAppInfo,
  openExternalUrl,
  openFolder,
  pickImportJsonFiles,
  pickSaveJsonPath,
} from '../lib/tauri';

type OAuthLoginPhase =
  | 'waiting'
  | 'exchanging'
  | 'saving'
  | 'succeeded'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'expired';

interface OAuthBeginReply {
  id?: string;
  url?: string;
  authUrl?: string;
}

interface OAuthStatusReply {
  id?: string;
  phase?: OAuthLoginPhase | string;
  state?: string;
  status?: string;
  error?: string;
  message?: string;
  expiresAt?: number;
}

/**
 * Strictly validate that an OAuth authorization URL targets Google's HTTPS OAuth endpoint
 * before passing it to the OS browser launcher or exposing copy/reopen fallback actions.
 */
function isSafeGoogleOAuthUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    return (
      parsed.protocol === 'https:' &&
      parsed.hostname.toLowerCase() === 'accounts.google.com' &&
      !parsed.username &&
      !parsed.password
    );
  } catch {
    return false;
  }
}

export function AddAccountModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { t, locale, appInfo, status, accounts, refreshAll, showToast, askConfirm } = useApp();
  const [busy, setBusy] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [showManualToken, setShowManualToken] = useState(false);
  const [refreshToken, setRefreshToken] = useState('');
  const [oauthSessionId, setOauthSessionId] = useState<string | null>(null);
  const [oauthAuthUrl, setOauthAuthUrl] = useState('');
  const [copiedAuthUrl, setCopiedAuthUrl] = useState(false);
  const pollRef = useRef<number | null>(null);
  const pollInFlightRef = useRef(false);
  const copyTimerRef = useRef<number | null>(null);

  const currentEmail = (status.liveAccountEmail || status.activeAccountEmail || '').trim();
  const oauthConfigured = status.oauthClientConfigured === true;

  const stopPolling = () => {
    if (pollRef.current) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
    pollInFlightRef.current = false;
  };

  useEffect(() => {
    if (!open) {
      stopPolling();
      if (copyTimerRef.current) {
        window.clearTimeout(copyTimerRef.current);
        copyTimerRef.current = null;
      }
      setBusy(false);
      setStatusMsg('');
      setErrorMsg('');
      setShowManualToken(false);
      setRefreshToken('');
      setOauthSessionId(null);
      setOauthAuthUrl('');
      setCopiedAuthUrl(false);
    }
    return () => {
      stopPolling();
      if (copyTimerRef.current) {
        window.clearTimeout(copyTimerRef.current);
        copyTimerRef.current = null;
      }
    };
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

  const handleOpenConfigDir = async () => {
    setErrorMsg('');
    try {
      const dir = appInfo?.stateDir || (await getAppInfo()).stateDir;
      if (!dir) {
        throw new Error(locale === 'en' ? 'Unable to locate GravityBox config folder' : '无法定位 GravityBox 配置目录');
      }
      await openFolder(dir);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handleReopenOAuthUrl = async () => {
    if (!oauthAuthUrl || !isSafeGoogleOAuthUrl(oauthAuthUrl)) {
      setErrorMsg(t('add_account.error.invalid_url'));
      return;
    }
    setErrorMsg('');
    try {
      await openExternalUrl(oauthAuthUrl);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handleCopyOAuthUrl = async () => {
    if (!oauthAuthUrl || !isSafeGoogleOAuthUrl(oauthAuthUrl)) {
      setErrorMsg(t('add_account.error.invalid_url'));
      return;
    }
    try {
      await navigator.clipboard.writeText(oauthAuthUrl);
      setCopiedAuthUrl(true);
      if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setCopiedAuthUrl(false), 2000);
    } catch {
      setErrorMsg(locale === 'en' ? 'Failed to copy authorization link' : '复制授权链接失败');
    }
  };

  const handleOAuthBegin = async () => {
    setErrorMsg('');
    setStatusMsg(t('add_account.status.opening_google'));
    setBusy(true);
    try {
      const res = await backendRequest<OAuthBeginReply>({
        command: 'account_oauth_begin',
      });
      const authUrl = (res.authUrl || res.url || '').trim();
      const id = (res.id || '').trim();
      if (!authUrl || !id || !isSafeGoogleOAuthUrl(authUrl)) {
        throw new Error(t('add_account.error.invalid_url'));
      }
      setOauthSessionId(id);
      setOauthAuthUrl(authUrl);
      setCopiedAuthUrl(false);
      setStatusMsg(t('add_account.status.complete_in_browser'));

      try {
        await openExternalUrl(authUrl);
      } catch (openErr) {
        setErrorMsg(
          locale === 'en'
            ? `Could not open browser automatically (${openErr instanceof Error ? openErr.message : String(openErr)}). Use "Reopen Browser" or "Copy Auth Link" below.`
            : `未能自动拉起浏览器（${openErr instanceof Error ? openErr.message : String(openErr)}），请使用下方「重新打开浏览器」或「复制授权链接」。`,
        );
      }

      stopPolling();
      let consecutiveErrors = 0;
      pollRef.current = window.setInterval(async () => {
        if (pollInFlightRef.current) return;
        pollInFlightRef.current = true;
        try {
          const st = await backendRequest<OAuthStatusReply>({
            command: 'account_oauth_status',
            id,
          });
          consecutiveErrors = 0;
          const phase = st.phase || st.state || st.status || '';
          if (phase === 'exchanging') {
            setStatusMsg(locale === 'en' ? 'Exchanging Google authorization...' : '正在交换 Google 授权凭据...');
          } else if (phase === 'saving') {
            setStatusMsg(t('add_account.status.saving'));
          } else if (phase === 'succeeded' || phase === 'completed') {
            stopPolling();
            setOauthSessionId(null);
            setOauthAuthUrl('');
            setBusy(false);
            showToast(st.message || t('oauth.msg.succeeded'));
            await refreshAll(true);
            onClose();
          } else if (phase === 'failed' || phase === 'cancelled' || phase === 'expired') {
            stopPolling();
            setOauthSessionId(null);
            setOauthAuthUrl('');
            setBusy(false);
            setStatusMsg('');
            setErrorMsg(st.error || st.message || t('add_account.error.incomplete'));
          }
        } catch (pollErr) {
          consecutiveErrors += 1;
          if (consecutiveErrors >= 6) {
            stopPolling();
            setOauthSessionId(null);
            setOauthAuthUrl('');
            setBusy(false);
            setStatusMsg('');
            setErrorMsg(pollErr instanceof Error ? pollErr.message : t('add_account.error.incomplete'));
          }
        } finally {
          pollInFlightRef.current = false;
        }
      }, 900);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStatusMsg('');
      setOauthSessionId(null);
      setOauthAuthUrl('');
      setBusy(false);
    }
  };

  const handleCancelOAuthOrClose = async () => {
    if (oauthSessionId) {
      stopPolling();
      const activeId = oauthSessionId;
      setOauthSessionId(null);
      setOauthAuthUrl('');
      setCopiedAuthUrl(false);
      setBusy(false);
      setStatusMsg('');
      await backendRequest({ command: 'account_oauth_cancel', id: activeId }).catch(() => {});
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
    <Modal open={open} onClose={handleCancelOAuthOrClose} maxWidth={520}>
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

        {/* Card 1: Save current active Antigravity account (recommended multi-account workflow) */}
        <div className="gb-card" style={{ padding: 13, display: 'flex', alignItems: 'center', gap: 12 }}>
          <div
            className="gb-icon-badge"
            style={{ background: 'var(--blue-soft)', border: '0.5px solid var(--blue-border)', color: 'var(--blue)' }}
          >
            <UserCheck size={15} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>{t('add_account.current_card_title')}</div>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2, lineHeight: 1.45 }}>
              {locale === 'en'
                ? 'Recommended (no OAuth setup needed): sign in to the target Google account in Antigravity, then click Save Current Account to store it.'
                : '多账号推荐方式（无需配置 OAuth）：先在 Antigravity 登录目标 Google 账号，再点「保存当前账号」一键收入。'}
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
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            <div
              className="gb-icon-badge"
              style={{ background: 'var(--blue-soft)', border: '0.5px solid var(--blue-border)', color: 'var(--blue)', marginTop: 1 }}
            >
              <Globe size={15} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{t('add_account.google_title')}</div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2, lineHeight: 1.45 }}>
                {oauthConfigured
                  ? t('add_account.google_sub')
                  : locale === 'en'
                  ? 'Neither macOS nor Windows bundles OAuth keys by default. To enable browser sign-in, configure GRAVITYBOX_GOOGLE_CLIENT_ID and GRAVITYBOX_GOOGLE_CLIENT_SECRET in %APPDATA%\\GravityBox\\.env and restart GravityBox.'
                  : '原版 macOS 与 Windows 默认均不内置 OAuth 密钥；如需浏览器授权，请在 %APPDATA%\\GravityBox\\.env 配置 GRAVITYBOX_GOOGLE_CLIENT_ID 与 GRAVITYBOX_GOOGLE_CLIENT_SECRET 后重启应用。'}
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6, flexShrink: 0 }}>
              {oauthConfigured ? (
                <button
                  type="button"
                  className="gb-btn gb-btn-sm"
                  disabled={busy}
                  onClick={handleOAuthBegin}
                >
                  {t('add_account.google_btn')}
                </button>
              ) : (
                <button
                  type="button"
                  className="gb-btn gb-btn-sm"
                  disabled={busy}
                  onClick={() => void handleOpenConfigDir()}
                >
                  <FolderOpen size={12} />
                  <span>{locale === 'en' ? 'Open Config Folder' : '打开配置目录'}</span>
                </button>
              )}
              <button
                type="button"
                className="gb-btn gb-btn-sm"
                disabled={busy}
                onClick={() => setShowManualToken((v) => !v)}
              >
                <KeyRound size={12} />
                <span>{locale === 'en' ? 'Manual Token' : '手动 Token'}</span>
              </button>
            </div>
          </div>

          {oauthSessionId && oauthAuthUrl && (
            <div
              className="gb-subcard"
              style={{
                padding: '9px 11px',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
              <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', lineHeight: 1.4 }}>
                {locale === 'en'
                  ? 'Waiting for Google browser authorization callback. If the browser did not open, reopen or copy the link:'
                  : '正在等待浏览器完成 Google 授权回调；若浏览器未自动弹出，可重新打开或复制授权链接：'}
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="gb-btn gb-btn-sm"
                  onClick={() => void handleReopenOAuthUrl()}
                >
                  <ExternalLink size={12} />
                  <span>{locale === 'en' ? 'Reopen Browser' : '重新打开浏览器'}</span>
                </button>
                <button
                  type="button"
                  className="gb-btn gb-btn-sm"
                  onClick={() => void handleCopyOAuthUrl()}
                >
                  {copiedAuthUrl ? <Check size={12} /> : <Copy size={12} />}
                  <span>
                    {copiedAuthUrl
                      ? locale === 'en'
                        ? 'Copied'
                        : '已复制'
                      : locale === 'en'
                      ? 'Copy Auth Link'
                      : '复制授权链接'}
                  </span>
                </button>
              </div>
            </div>
          )}

          {showManualToken && (
            <div style={{ display: 'flex', gap: 8, paddingTop: 6, borderTop: '1px solid var(--divider)' }}>
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
