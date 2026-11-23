import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Clock,
  FolderOpen,
  Info,
  RotateCcw,
  RotateCw,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { Modal } from '../components/Modal';
import { ToggleSwitch } from '../components/ToggleSwitch';
import { useApp } from '../context/AppContext';
import { formatBytes, formatInteger, formatShortDateTime } from '../lib/format';
import {
  backendRequest,
  getAntigravityRunning,
  launchAntigravity,
  openFolder,
  revealInExplorer,
} from '../lib/tauri';
import type { MaintenanceEntry, MaintenanceScanReply } from '../lib/types';

type DetailTab = 'runtime' | 'history' | 'protected' | 'snapshot' | null;

const STATEFUL_NAMES = new Set([
  'AgentTaskStepLogs',
  'AgentVerboseTranscripts',
  'AgentSubagentDatabases',
]);

function isStateful(e: MaintenanceEntry): boolean {
  return e.category === 'stateful' || STATEFUL_NAMES.has(e.name);
}

export function MaintenanceModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const {
    t,
    locale,
    reachable,
    maintenanceScan,
    sshWindowsCount,
    fetchMaintenanceScan,
    fetchDashboard,
    fetchUsage,
    closeAntigravitySafely,
    showToast,
    askConfirm,
  } = useApp();

  const [scan, setScan] = useState<MaintenanceScanReply | null>(maintenanceScan);
  const [retentionDays, setRetentionDays] = useState<number>(7);
  const [runtimeEnabled, setRuntimeEnabled] = useState<boolean>(true);
  const [historyEnabled, setHistoryEnabled] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);
  const [feedback, setFeedback] = useState<{ text: string; error?: boolean } | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>(null);

  const runScan = useCallback(
    async (days: number) => {
      if (!reachable) return;
      setBusy(true);
      setFeedback(null);
      try {
        const res = await fetchMaintenanceScan(days, true);
        if (res) {
          setScan(res);
          const rtBytes = res.buckets?.runtimeCache?.clearableBytes ?? res.safeBytes ?? 0;
          const hiBytes = res.buckets?.historyLogs?.clearableBytes ?? res.statefulBytes ?? 0;
          if (rtBytes <= 0) setRuntimeEnabled(false);
          if (hiBytes <= 0) setHistoryEnabled(false);
        }
      } catch (err) {
        setFeedback({ text: err instanceof Error ? err.message : String(err), error: true });
      } finally {
        setBusy(false);
      }
    },
    [fetchMaintenanceScan, reachable],
  );

  useEffect(() => {
    if (open) {
      if (maintenanceScan) setScan(maintenanceScan);
      void runScan(retentionDays);
    } else {
      setDetailTab(null);
      setFeedback(null);
    }
  }, [open, retentionDays, runScan]);

  const entries = scan?.entries ?? [];
  const protectedEntries = scan?.protectedEntries ?? [];
  const snapshots = scan?.snapshots ?? [];

  const runtimeEntries = useMemo(
    () => entries.filter((e) => !isStateful(e) && e.clearable !== false && e.bytes > 0),
    [entries],
  );
  const historyEntries = useMemo(
    () => entries.filter((e) => isStateful(e) && e.clearable !== false && e.bytes > 0),
    [entries],
  );

  const runtimeBytes =
    scan?.buckets?.runtimeCache?.clearableBytes ??
    scan?.safeBytes ??
    runtimeEntries.reduce((s, e) => s + e.bytes, 0);
  const historyBytes =
    scan?.buckets?.historyLogs?.clearableBytes ??
    scan?.statefulBytes ??
    historyEntries.reduce((s, e) => s + e.bytes, 0);
  const protectedBytes =
    scan?.protectedBytes ?? protectedEntries.reduce((s, e) => s + e.bytes, 0);

  const runtimeFiles =
    scan?.buckets?.runtimeCache?.fileCount ??
    runtimeEntries.reduce((s, e) => s + (e.fileCount ?? 0), 0);
  const historyFiles =
    scan?.buckets?.historyLogs?.fileCount ??
    historyEntries.reduce((s, e) => s + (e.fileCount ?? 0), 0);

  const selectedScopes: string[] = [];
  if (runtimeEnabled && runtimeBytes > 0) selectedScopes.push('runtime_cache');
  if (historyEnabled && historyBytes > 0) selectedScopes.push('history_logs');

  const selectedBytes =
    (runtimeEnabled && runtimeBytes > 0 ? runtimeBytes : 0) +
    (historyEnabled && historyBytes > 0 ? historyBytes : 0);

  const totalBarBytes = Math.max(1, runtimeBytes + historyBytes + protectedBytes);
  const rtPct = runtimeBytes > 0 ? Math.max(2, (runtimeBytes / totalBarBytes) * 100) : 0;
  const hiPct = historyBytes > 0 ? Math.max(2, (historyBytes / totalBarBytes) * 100) : 0;
  const prPct = protectedBytes > 0 ? Math.max(2, 100 - rtPct - hiPct) : 0;

  const latestRestorable =
    scan?.latestRestorableSnapshot ??
    snapshots.find((s) => s.restorable === true && s.id) ??
    null;

  const executeClean = async (scopes: string[], restartAfter: boolean) => {
    setBusy(true);
    setFeedback({
      text: restartAfter ? t('maintenance.simple.status_restarting_clean') : t('maintenance.simple.status_cleaning'),
    });
    try {
      const res = await backendRequest<{ clearedBytes?: number; message?: string }>({
        command: 'maintenance_smart_clear',
        scopes,
        retentionDays,
        keepLocalSnapshots: 1,
      });
      const cleared = res.clearedBytes ?? 0;
      const msg =
        res.message ||
        (cleared > 0
          ? t('maintenance.simple.success_cleaned', { size: formatBytes(cleared) })
          : t('maintenance.simple.success_nothing'));
      setFeedback({ text: msg });
      showToast(msg);
      await runScan(retentionDays);
      void fetchDashboard(true);
      void fetchUsage('today', true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setFeedback({ text: msg, error: true });
      showToast(msg, true);
    } finally {
      setBusy(false);
      if (restartAfter) {
        setTimeout(() => void launchAntigravity().catch(() => {}), 500);
      }
    }
  };

  const handleCleanNow = async () => {
    if (busy || selectedScopes.length === 0 || selectedBytes <= 0) return;
    const isRunning = (await getAntigravityRunning()) || scan?.running === true;
    if (isRunning) {
      setBusy(true);
      try {
        await backendRequest({ command: 'maintenance_preflight' });
      } catch (err) {
        setBusy(false);
        const msg = err instanceof Error ? err.message : String(err);
        setFeedback({ text: msg, error: true });
        showToast(msg, true);
        return;
      }
      setBusy(false);

      const itemCount =
        (runtimeEnabled && runtimeBytes > 0 ? Math.max(1, runtimeEntries.length) : 0) +
        (historyEnabled && historyBytes > 0 ? Math.max(1, historyEntries.length) : 0);
      const fileCount =
        (runtimeEnabled && runtimeBytes > 0 ? runtimeFiles : 0) +
        (historyEnabled && historyBytes > 0 ? historyFiles : 0);

      const body =
        itemCount > 0 && fileCount > 0
          ? t('maintenance.simple.confirm_running_detail', {
              items: itemCount,
              files: formatInteger(fileCount, locale),
              size: formatBytes(selectedBytes),
            })
          : t('maintenance.simple.confirm_running_body');

      const confirmed = await askConfirm({
        title: t('maintenance.simple.confirm_running_title', { size: formatBytes(selectedBytes) }),
        body,
        confirmLabel: t('maintenance.simple.confirm_restart_and_clean'),
      });
      if (!confirmed) return;

      setBusy(true);
      setFeedback({ text: t('maintenance.simple.status_restarting_clean') });
      const closeOutcome = await closeAntigravitySafely(15_000, 'maintenance').catch(() => ({
        closed: false,
        reason: 'error',
      }));
      if (!closeOutcome.closed) {
        setBusy(false);
        const msg =
          closeOutcome.reason === 'visible_window_open'
            ? locale === 'en'
              ? 'Visible Antigravity windows are still open. Save and close them before cleaning.'
              : '检测到 Antigravity 仍有未关闭的可见窗口，请先保存并关闭后再执行清理。'
            : t('maintenance.error.quit_first_clear');
        setFeedback({ text: msg, error: true });
        showToast(msg, true);
        return;
      }
      await executeClean(selectedScopes, true);
      return;
    }

    await executeClean(selectedScopes, false);
  };

  const handleRestoreLatest = async () => {
    if (busy || !latestRestorable?.id) return;
    const isRunning = (await getAntigravityRunning()) || scan?.running === true;
    let restartAfter = false;

    if (isRunning) {
      setBusy(true);
      try {
        await backendRequest({ command: 'maintenance_preflight' });
      } catch (err) {
        setBusy(false);
        const msg = err instanceof Error ? err.message : String(err);
        setFeedback({ text: msg, error: true });
        showToast(msg, true);
        return;
      }
      setBusy(false);

      const confirmed = await askConfirm({
        title: t('maintenance.simple.undo_running_title'),
        body: t('maintenance.simple.undo_running_body'),
        confirmLabel: t('maintenance.simple.confirm_restart_and_undo'),
      });
      if (!confirmed) return;

      setBusy(true);
      setFeedback({ text: t('maintenance.simple.status_restarting_undo') });
      const closeOutcome = await closeAntigravitySafely(15_000, 'maintenance').catch(() => ({
        closed: false,
        reason: 'error',
      }));
      if (!closeOutcome.closed) {
        setBusy(false);
        const msg =
          closeOutcome.reason === 'visible_window_open'
            ? locale === 'en'
              ? 'Visible Antigravity windows are still open. Save and close them before restoring.'
              : '检测到 Antigravity 仍有未关闭的可见窗口，请先保存并关闭后再执行还原。'
            : t('maintenance.restore.quit_body');
        setFeedback({ text: msg, error: true });
        showToast(msg, true);
        return;
      }
      restartAfter = true;
    }

    setBusy(true);
    setFeedback({ text: t('maintenance.simple.status_undoing') });
    try {
      const res = await backendRequest<{ message?: string }>({
        command: 'maintenance_restore',
        snapshotId: latestRestorable.id,
      });
      const msg = res.message || t('maintenance.simple.success_undone');
      setFeedback({ text: msg });
      showToast(msg);
      await runScan(retentionDays);
      void fetchDashboard(true);
      void fetchUsage('today', true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setFeedback({ text: msg, error: true });
      showToast(msg, true);
    } finally {
      setBusy(false);
      if (restartAfter) {
        setTimeout(() => void launchAntigravity().catch(() => {}), 500);
      }
    }
  };

  const handleShowInExplorer = async () => {
    const snapPath = latestRestorable?.snapshotPath || snapshots[0]?.snapshotPath;
    if (snapPath) {
      await revealInExplorer(snapPath).catch((e) => showToast(String(e), true));
      return;
    }
    if (scan?.trashDir) {
      await openFolder(scan.trashDir).catch((e) => showToast(String(e), true));
    }
  };

  const historySubtitle =
    historyBytes > 0
      ? retentionDays > 0
        ? t('maintenance.simple.scope_history_sub', { days: retentionDays })
        : t('maintenance.simple.scope_history_sub_inactive')
      : retentionDays > 0
      ? t('maintenance.simple.scope_history_empty', { days: retentionDays })
      : t('maintenance.simple.scope_history_empty_inactive');

  const detailItems: MaintenanceEntry[] =
    detailTab === 'runtime'
      ? runtimeEntries
      : detailTab === 'history'
      ? historyEntries
      : detailTab === 'protected'
      ? protectedEntries
      : [];

  return (
    <Modal open={open} onClose={() => !busy && onClose()} maxWidth={630}>
      <div style={{ padding: '18px 22px 16px', display: 'flex', flexDirection: 'column', gap: 11, overflowY: 'auto' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>{t('maintenance.title')}</h3>
          <button
            type="button"
            className="gb-btn gb-btn-sm"
            disabled={busy || !reachable}
            onClick={() => void runScan(retentionDays)}
          >
            <RotateCw size={12} className={busy ? 'gb-spin' : undefined} />
            <span>{t('common.refresh')}</span>
          </button>
        </div>

        {/* SSH Remote active windows safety notice */}
        {sshWindowsCount > 0 && (
          <div
            className="gb-subcard"
            style={{
              padding: '9px 12px',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 11.5,
              color: 'var(--text-secondary)',
            }}
          >
            <Info size={13} style={{ color: 'var(--blue)', flexShrink: 0 }} />
            <span>{t('ssh.maintenance.active_windows_note', { count: sshWindowsCount })}</span>
          </div>
        )}

        {/* Card 1: Hero Reclaimable Space + Tri-color composition bar */}
        <div className="gb-card" style={{ padding: 15, display: 'flex', flexDirection: 'column', gap: 11 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14 }}>
            <div>
              <div style={{ fontSize: 11.5, fontWeight: 500, color: 'var(--text-secondary)' }}>
                {t('maintenance.simple.hero_title')}
              </div>
              <div className="tabular" style={{ fontSize: 30, fontWeight: 700, lineHeight: 1.15, marginTop: 2 }}>
                {scan ? formatBytes(selectedBytes) : t('maintenance.hero.scanning')}
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 3 }}>
                {t('maintenance.simple.hero_subtitle')}
              </div>
            </div>
            <button
              type="button"
              className="gb-btn gb-btn-primary"
              style={{ height: 34, padding: '0 18px', fontSize: 13, fontWeight: 600 }}
              disabled={busy || !scan || selectedBytes <= 0 || selectedScopes.length === 0}
              onClick={handleCleanNow}
            >
              {!scan || selectedBytes > 0
                ? t('maintenance.simple.btn_clean_now')
                : t('maintenance.simple.btn_nothing_to_clean')}
            </button>
          </div>

          {/* 3-segment composition bar */}
          <div
            style={{
              height: 8,
              borderRadius: 999,
              background: 'var(--track)',
              overflow: 'hidden',
              display: 'flex',
              gap: 2,
            }}
          >
            {rtPct > 0 && (
              <div
                style={{
                  width: `${rtPct}%`,
                  height: '100%',
                  background: 'var(--blue-bright)',
                  borderRadius: 999,
                  transition: 'width 240ms ease',
                }}
              />
            )}
            {hiPct > 0 && (
              <div
                style={{
                  width: `${hiPct}%`,
                  height: '100%',
                  background: '#d97706',
                  borderRadius: 999,
                  transition: 'width 240ms ease',
                }}
              />
            )}
            {prPct > 0 && (
              <div
                style={{
                  width: `${prPct}%`,
                  height: '100%',
                  background: '#9ca3af',
                  borderRadius: 999,
                  transition: 'width 240ms ease',
                }}
              />
            )}
          </div>

          {/* Interactive Legend */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', fontSize: 11.5 }}>
            <button
              type="button"
              className="gb-btn-ghost"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                border: 'none',
                padding: '2px 4px',
                borderRadius: 5,
                cursor: 'pointer',
                color: detailTab === 'runtime' ? 'var(--blue)' : 'var(--text-secondary)',
                fontSize: 11.5,
              }}
              onClick={() => setDetailTab((cur) => (cur === 'runtime' ? null : 'runtime'))}
            >
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--blue-bright)' }} />
              <span className="tabular">{t('maintenance.simple.legend_runtime', { size: formatBytes(runtimeBytes) })}</span>
            </button>

            <button
              type="button"
              className="gb-btn-ghost"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                border: 'none',
                padding: '2px 4px',
                borderRadius: 5,
                cursor: 'pointer',
                color: detailTab === 'history' ? 'var(--warning)' : 'var(--text-secondary)',
                fontSize: 11.5,
              }}
              onClick={() => setDetailTab((cur) => (cur === 'history' ? null : 'history'))}
            >
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#d97706' }} />
              <span className="tabular">{t('maintenance.simple.legend_history', { size: formatBytes(historyBytes) })}</span>
            </button>

            <button
              type="button"
              className="gb-btn-ghost"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                border: 'none',
                padding: '2px 4px',
                borderRadius: 5,
                cursor: 'pointer',
                color: detailTab === 'protected' ? 'var(--text)' : 'var(--text-secondary)',
                fontSize: 11.5,
              }}
              onClick={() => setDetailTab((cur) => (cur === 'protected' ? null : 'protected'))}
            >
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#9ca3af' }} />
              <span className="tabular">
                {protectedBytes > 0
                  ? t('maintenance.simple.legend_protected', { size: formatBytes(protectedBytes) })
                  : t('maintenance.simple.legend_protected_empty')}
              </span>
              <Info size={12} style={{ opacity: 0.7 }} />
            </button>
          </div>
        </div>

        {/* Optional expandable detail drawer when clicking legend/info */}
        {detailTab && (
          <div className="gb-subcard gb-fade-in" style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 12, fontWeight: 600 }}>
                {detailTab === 'runtime'
                  ? t('maintenance.popover.runtime.title')
                  : detailTab === 'history'
                  ? t('maintenance.popover.history.title', {
                      window:
                        retentionDays === 7
                          ? t('maintenance.simple.retention_7d')
                          : retentionDays === 30
                          ? t('maintenance.simple.retention_30d')
                          : t('maintenance.simple.retention_0d'),
                    })
                  : detailTab === 'protected'
                  ? t('maintenance.popover.protected.title')
                  : t('maintenance.popover.snapshot.title')}
              </span>
              <button
                type="button"
                className="gb-btn gb-btn-ghost gb-btn-sm"
                onClick={() => setDetailTab(null)}
              >
                {t('common.ok')}
              </button>
            </div>
            {detailItems.length === 0 ? (
              <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
                {detailTab === 'runtime'
                  ? t('maintenance.popover.runtime.empty')
                  : detailTab === 'protected'
                  ? t('maintenance.popover.protected.footer')
                  : t('maintenance.popover.snapshot.empty')}
              </div>
            ) : (
              <div style={{ maxHeight: 130, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
                {detailItems.slice(0, 12).map((item) => (
                  <div
                    key={item.name}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      fontSize: 11.5,
                      padding: '2px 0',
                    }}
                  >
                    <span style={{ color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {item.name}
                    </span>
                    <span className="tabular" style={{ color: 'var(--text-secondary)', flexShrink: 0, marginLeft: 10 }}>
                      {formatBytes(item.bytes)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Card 2: Two Scope Toggles */}
        <div className="gb-card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* Runtime Cache Row */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
            <div
              className="gb-icon-badge"
              style={{ background: 'var(--blue-soft)', border: '0.5px solid var(--blue-border)', color: 'var(--blue)' }}
            >
              <Sparkles size={14} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{t('maintenance.simple.scope_runtime_title')}</span>
                <button
                  type="button"
                  className="gb-btn-ghost"
                  style={{ border: 'none', padding: 2, cursor: 'pointer', display: 'inline-flex', color: 'var(--text-secondary)' }}
                  onClick={() => setDetailTab((c) => (c === 'runtime' ? null : 'runtime'))}
                >
                  <Info size={12} />
                </button>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
                {t('maintenance.simple.scope_runtime_sub')}
              </div>
            </div>
            <span
              className="tabular"
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: runtimeEnabled && runtimeBytes > 0 ? 'var(--text)' : 'var(--text-secondary)',
              }}
            >
              {formatBytes(runtimeBytes)}
            </span>
            <ToggleSwitch
              checked={runtimeEnabled && runtimeBytes > 0}
              disabled={busy || runtimeBytes <= 0}
              onChange={setRuntimeEnabled}
              ariaLabel={t('maintenance.simple.scope_runtime_a11y')}
            />
          </div>

          <div className="gb-divider" />

          {/* Background Task Logs Row */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
            <div
              className="gb-icon-badge"
              style={{ background: 'var(--warning-soft)', border: '0.5px solid var(--warning-border)', color: 'var(--warning)' }}
            >
              <Clock size={14} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{t('maintenance.simple.scope_history_title')}</span>
                <select
                  className="gb-select"
                  style={{ height: 24, fontSize: 11, padding: '0 8px' }}
                  disabled={busy}
                  value={retentionDays}
                  onChange={(e) => {
                    const days = Number(e.target.value);
                    setRetentionDays(days);
                    void runScan(days);
                  }}
                >
                  <option value={7}>{t('maintenance.simple.retention_7d')}</option>
                  <option value={30}>{t('maintenance.simple.retention_30d')}</option>
                  <option value={0}>{t('maintenance.simple.retention_0d')}</option>
                </select>
                <button
                  type="button"
                  className="gb-btn-ghost"
                  style={{ border: 'none', padding: 2, cursor: 'pointer', display: 'inline-flex', color: 'var(--text-secondary)' }}
                  onClick={() => setDetailTab((c) => (c === 'history' ? null : 'history'))}
                >
                  <Info size={12} />
                </button>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
                {historySubtitle}
              </div>
            </div>
            <span
              className="tabular"
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: historyEnabled && historyBytes > 0 ? 'var(--text)' : 'var(--text-secondary)',
              }}
            >
              {formatBytes(historyBytes)}
            </span>
            <ToggleSwitch
              checked={historyEnabled && historyBytes > 0}
              disabled={busy || historyBytes <= 0}
              onChange={setHistoryEnabled}
              ariaLabel={t('maintenance.simple.scope_history_a11y')}
            />
          </div>
        </div>

        {/* Card 3: Safety & One-Click Undo Footer Card */}
        <div className="gb-card" style={{ padding: 13, display: 'flex', alignItems: 'center', gap: 11 }}>
          <div
            className="gb-icon-badge"
            style={
              latestRestorable
                ? { background: 'var(--blue-soft)', border: '0.5px solid var(--blue-border)', color: 'var(--blue)' }
                : { background: 'var(--success-soft)', border: '0.5px solid var(--success-border)', color: 'var(--success)' }
            }
          >
            {latestRestorable ? <RotateCcw size={14} /> : <ShieldCheck size={14} />}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>
              {latestRestorable
                ? t('maintenance.simple.undo_ready_title', {
                    size: formatBytes(latestRestorable.totalBytes),
                    time: latestRestorable.timestamp
                      ? formatShortDateTime(latestRestorable.timestamp)
                      : t('maintenance.recovery.recent'),
                  })
                : t('maintenance.simple.safety_idle_title')}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
              {latestRestorable
                ? t('maintenance.simple.undo_ready_sub')
                : t('maintenance.simple.safety_idle_sub')}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 7, flexShrink: 0 }}>
            {latestRestorable && (
              <button
                type="button"
                className="gb-btn gb-btn-primary gb-btn-sm"
                disabled={busy}
                onClick={handleRestoreLatest}
              >
                {t('maintenance.simple.btn_undo')}
              </button>
            )}
            <button
              type="button"
              className="gb-btn gb-btn-sm"
              disabled={!latestRestorable?.snapshotPath && !scan?.trashDir}
              onClick={handleShowInExplorer}
            >
              <FolderOpen size={12} />
              <span>{t('maintenance.simple.btn_show_finder')}</span>
            </button>
          </div>
        </div>

        {feedback && (
          <div style={{ fontSize: 11.5, color: feedback.error ? 'var(--warning)' : 'var(--text-secondary)' }}>
            {feedback.text}
          </div>
        )}

        <div className="gb-divider" />

        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button type="button" className="gb-btn gb-btn-primary" disabled={busy} onClick={onClose}>
            {t('maintenance.btn.done')}
          </button>
        </div>
      </div>
    </Modal>
  );
}
