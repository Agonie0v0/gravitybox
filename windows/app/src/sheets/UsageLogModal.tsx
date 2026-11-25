import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, RotateCw, Search } from 'lucide-react';
import { Modal } from '../components/Modal';
import { BrandIcons } from '../components/ModelIcon';
import { useApp } from '../context/AppContext';
import {
  formatCompactTokens,
  formatInteger,
  formatShortDateTime,
  formatUsd,
  localizedModelLabel,
} from '../lib/format';
import { backendRequest, pickSaveJsonPath, saveJsonFile } from '../lib/tauri';
import { cleanSshHostLabel, normalizeSshEnvironment } from '../lib/ssh';
import type {
  AvailableAccountUsageOption,
  UsageEventRow,
  UsageEventsReply,
  UsagePeriodKey,
} from '../lib/types';

const PERIODS: UsagePeriodKey[] = ['today', '7d', '30d', 'all'];
const PAGE_SIZE = 200;
const EXPORT_PAGE_SIZE = 500;
const EXPORT_MAX_PAGES = 200;

export function UsageLogModal({
  open,
  initialPeriod,
  initialEnvironmentId = 'all',
  initialAccountId = 'all',
  availableAccounts = [],
  onClose,
}: {
  open: boolean;
  initialPeriod: UsagePeriodKey;
  initialEnvironmentId?: string;
  initialAccountId?: string;
  availableAccounts?: AvailableAccountUsageOption[];
  onClose: () => void;
}) {
  const { t, locale, isDark, sshEnvironments, showToast } = useApp();
  const [period, setPeriod] = useState<UsagePeriodKey>(initialPeriod);
  const [environmentId, setEnvironmentId] = useState<string>(initialEnvironmentId);
  const [accountId, setAccountId] = useState<string>(initialAccountId);
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<UsageEventRow[]>([]);
  const [total, setTotal] = useState(0);
  const [scope, setScope] = useState('');
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');
  const [pageInput, setPageInput] = useState('1');
  const snapshotIdRef = useRef<string | null>(null);
  const debounceRef = useRef<number | null>(null);

  const normalizedSshHosts = sshEnvironments.map((env) =>
    normalizeSshEnvironment(env, t('ssh.remote_fallback')),
  );
  const accountOptions = availableAccounts.filter((opt) => opt.id && opt.id !== 'all');

  const releaseSnapshot = useCallback(() => {
    const id = snapshotIdRef.current;
    snapshotIdRef.current = null;
    if (id) {
      void backendRequest({ command: 'usage_snapshot_release', snapshotId: id }).catch(() => {});
    }
  }, []);

  const fetchRows = useCallback(
    async (opts: {
      period: UsagePeriodKey;
      environmentId: string;
      accountId: string;
      query: string;
      offset: number;
      force?: boolean;
    }) => {
      setLoading(true);
      setError('');
      try {
        const payload: Record<string, unknown> = {
          command: 'usage_events',
          period: opts.period,
          query: opts.query,
          offset: opts.offset,
          limit: PAGE_SIZE,
        };
        if (opts.environmentId && opts.environmentId !== 'all') {
          payload.environmentId = opts.environmentId;
        }
        if (opts.accountId && opts.accountId !== 'all') {
          payload.accountId = opts.accountId;
        }
        if (opts.force) {
          payload.force = true;
          payload.pinSnapshot = true;
        } else if (snapshotIdRef.current) {
          payload.snapshotId = snapshotIdRef.current;
        } else {
          payload.pinSnapshot = true;
        }
        const res = await backendRequest<UsageEventsReply>(payload);
        if (res.snapshot_id) snapshotIdRef.current = res.snapshot_id;
        setRows(res.rows ?? []);
        setTotal(res.total ?? 0);
        setScope(res.scope || t('usage_log.scope.default'));
        setPageInput(String(Math.floor(opts.offset / PAGE_SIZE) + 1));
      } catch (err) {
        setRows([]);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [t],
  );

  useEffect(() => {
    if (open) {
      setPeriod(initialPeriod);
      setEnvironmentId(initialEnvironmentId);
      setAccountId(initialAccountId);
      setQuery('');
      setOffset(0);
      void fetchRows({
        period: initialPeriod,
        environmentId: initialEnvironmentId,
        accountId: initialAccountId,
        query: '',
        offset: 0,
        force: false,
      });
    } else {
      releaseSnapshot();
    }
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, [open, initialPeriod, initialEnvironmentId, initialAccountId, fetchRows, releaseSnapshot]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  const handleQueryChange = (val: string) => {
    setQuery(val);
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      setOffset(0);
      void fetchRows({ period, environmentId, accountId, query: val, offset: 0 });
    }, 180);
  };

  const handlePeriodChange = (next: UsagePeriodKey) => {
    setPeriod(next);
    setOffset(0);
    void fetchRows({ period: next, environmentId, accountId, query, offset: 0 });
  };

  const handleEnvironmentChange = (nextEnv: string) => {
    releaseSnapshot();
    setEnvironmentId(nextEnv);
    setOffset(0);
    void fetchRows({ period, environmentId: nextEnv, accountId, query, offset: 0, force: true });
  };

  const handleAccountChange = (nextAcc: string) => {
    releaseSnapshot();
    setAccountId(nextAcc);
    setOffset(0);
    void fetchRows({ period, environmentId, accountId: nextAcc, query, offset: 0, force: true });
  };

  const handleJumpPage = () => {
    const n = Number.parseInt(pageInput.trim(), 10);
    if (!Number.isInteger(n) || n < 1 || n > totalPages) {
      setPageInput(String(currentPage));
      return;
    }
    const nextOffset = (n - 1) * PAGE_SIZE;
    setOffset(nextOffset);
    void fetchRows({ period, environmentId, accountId, query, offset: nextOffset });
  };

  const handleExport = async () => {
    if (exporting) return;
    const targetPath = await pickSaveJsonPath(
      t('usage_log.title'),
      t('usage_log.export.filename', { period }),
    );
    if (!targetPath) return;
    setExporting(true);
    try {
      const collected: UsageEventRow[] = [];
      let snapId = snapshotIdRef.current;
      let expectedTotal = total;
      let exportScope = scope || t('usage_log.scope.default');

      for (let page = 0; page < EXPORT_MAX_PAGES; page += 1) {
        const reqOffset = page * EXPORT_PAGE_SIZE;
        if (page > 0 && reqOffset >= expectedTotal) break;
        const payload: Record<string, unknown> = {
          command: 'usage_events',
          period,
          query,
          offset: reqOffset,
          limit: EXPORT_PAGE_SIZE,
        };
        if (environmentId && environmentId !== 'all') payload.environmentId = environmentId;
        if (accountId && accountId !== 'all') payload.accountId = accountId;
        if (snapId) {
          payload.snapshotId = snapId;
        } else {
          payload.pinSnapshot = true;
        }
        const pageRes = await backendRequest<UsageEventsReply>(payload);
        if (pageRes.snapshot_id) {
          snapId = pageRes.snapshot_id;
          snapshotIdRef.current = pageRes.snapshot_id;
        }
        if (pageRes.scope) exportScope = pageRes.scope;
        if (typeof pageRes.total === 'number' && Number.isFinite(pageRes.total)) {
          expectedTotal = pageRes.total;
        }
        const batch = pageRes.rows ?? [];
        if (batch.length === 0) break;
        collected.push(...batch);
        if (collected.length >= expectedTotal || batch.length < EXPORT_PAGE_SIZE) break;
      }

      await saveJsonFile(targetPath, {
        period,
        environmentId,
        accountId,
        query,
        scope: exportScope,
        total: collected.length,
        rows: collected,
      });
      showToast(t('usage_log.export.saved', { count: formatInteger(collected.length, locale), scope: exportScope }));
    } catch (err) {
      showToast(t('usage_log.export.failed', { error: err instanceof Error ? err.message : String(err) }), true);
    } finally {
      setExporting(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} maxWidth={720}>
      <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12, height: '82vh', maxHeight: 620 }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>{t('usage_log.title')}</h3>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              className="gb-btn gb-btn-sm"
              disabled={loading || exporting}
              onClick={() => {
                releaseSnapshot();
                setOffset(0);
                void fetchRows({ period, environmentId, accountId, query, offset: 0, force: true });
              }}
            >
              <RotateCw size={12} className={loading ? 'gb-spin' : undefined} />
              <span>{t('common.refresh')}</span>
            </button>
            <button
              type="button"
              className="gb-btn gb-btn-sm"
              disabled={loading || exporting || rows.length === 0}
              onClick={handleExport}
            >
              <Download size={12} />
              <span>{exporting ? t('usage_log.loading') : t('usage.export_btn')}</span>
            </button>
          </div>
        </div>

        {/* Search + Environment + Account + Period filter */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <div style={{ position: 'relative', flex: 1, minWidth: 160 }}>
            <Search
              size={13}
              style={{
                position: 'absolute',
                left: 10,
                top: '50%',
                transform: 'translateY(-50%)',
                color: 'var(--text-secondary)',
                pointerEvents: 'none',
              }}
            />
            <input
              type="text"
              className="gb-input"
              style={{ width: '100%', paddingLeft: 30 }}
              placeholder={t('usage_log.search_placeholder')}
              value={query}
              onChange={(e) => handleQueryChange(e.target.value)}
            />
          </div>
          {normalizedSshHosts.length > 0 && (
            <select
              className="gb-select"
              style={{ height: 30, fontSize: 12, maxWidth: 160 }}
              aria-label={t('usage_log.env.a11y')}
              value={environmentId}
              onChange={(e) => handleEnvironmentChange(e.target.value)}
            >
              <option value="all">{t('usage_log.env.all')}</option>
              <option value="local">{t('usage_log.env.local_label')}</option>
              {normalizedSshHosts.map((host) => (
                <option key={host.id || host.hostLabel} value={host.id}>
                  {t('usage_log.env.ssh_label', { host: host.hostLabel })}
                </option>
              ))}
            </select>
          )}
          {accountOptions.length > 0 && (
            <select
              className="gb-select"
              style={{ height: 30, fontSize: 12, maxWidth: 170 }}
              aria-label={t('usage_log.account.a11y')}
              value={accountId}
              onChange={(e) => handleAccountChange(e.target.value)}
            >
              <option value="all">{t('usage_log.account.all')}</option>
              {accountOptions.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.id === 'unattributed' ? t('usage.account.unattributed') : opt.label || opt.email || opt.id}
                </option>
              ))}
            </select>
          )}
          <div className="gb-segmented">
            {PERIODS.map((p) => (
              <button
                key={p}
                type="button"
                className={`gb-segmented-btn ${period === p ? 'active' : ''}`}
                onClick={() => handlePeriodChange(p)}
              >
                {t(`usage.period.${p}`)}
              </button>
            ))}
          </div>
        </div>

        {/* Event List */}
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            paddingRight: 2,
          }}
        >
          {error ? (
            <div style={{ textAlign: 'center', color: 'var(--danger)', padding: 40 }}>
              {t('usage_log.status.read_failed', { error })}
            </div>
          ) : loading && rows.length === 0 ? (
            <div style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: 40 }}>
              {t('usage_log.loading_rows')}
            </div>
          ) : rows.length === 0 ? (
            <div style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: 40 }}>
              <div>{query.trim() ? t('usage_log.status.no_match') : t('usage_log.empty.none')}</div>
              {query.trim() && (
                <button
                  type="button"
                  className="gb-btn gb-btn-sm"
                  style={{ marginTop: 10 }}
                  onClick={() => handleQueryChange('')}
                >
                  {t('usage_log.clear_filters')}
                </button>
              )}
            </div>
          ) : (
            rows.map((row, idx) => {
              const model = localizedModelLabel(row.model, locale);
              const inp = Number(row.inputTokens ?? row.input_tokens ?? 0);
              const out = Number(row.outputTokens ?? row.output_tokens ?? 0);
              const cached = Number(row.cachedTokens ?? row.cached_tokens ?? 0);
              const cacheWrite = Number(row.cacheWriteTokens ?? row.cache_write_tokens ?? 0);
              const totalTok = Number(row.totalTokens ?? row.total_tokens ?? inp + out + cached + cacheWrite);
              const usd = Number(row.estimatedUsd ?? row.estimated_usd ?? 0);
              const rawTs =
                typeof row.timestamp_seconds === 'number' &&
                Number.isFinite(row.timestamp_seconds) &&
                row.timestamp_seconds > 0
                  ? row.timestamp_seconds * 1000
                  : row.timestamp;
              const ts = rawTs
                ? typeof rawTs === 'number'
                  ? formatShortDateTime(rawTs < 1e12 ? rawTs * 1000 : rawTs)
                  : formatShortDateTime(new Date(rawTs))
                : t('usage_event.time_unknown');

              return (
                <div
                  key={row.id ?? `${idx}-${ts}`}
                  className="gb-card"
                  style={{
                    padding: '10px 13px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 4,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                      <BrandIcons fallbackName={model} size={14} isDark={isDark} />
                      <span
                        style={{
                          fontSize: 12.5,
                          fontWeight: 600,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {model}
                      </span>
                      {(() => {
                        const rowEnvId = row.environmentId || row.environment_id || '';
                        const rowEnvKind = row.environmentKind || row.environment_kind || '';
                        const isRemote = (rowEnvId && rowEnvId !== 'local') || rowEnvKind === 'ssh';
                        if (!isRemote) return null;
                        const label = cleanSshHostLabel(
                          row.hostLabel ||
                            row.host_label ||
                            row.environmentLabel ||
                            row.environment_label ||
                            rowEnvId,
                          t('ssh.remote_fallback'),
                        );
                        return (
                          <span className="gb-pill gb-pill-neutral" style={{ flexShrink: 0 }}>
                            {t('usage_log.env.ssh_label', { host: label })}
                          </span>
                        );
                      })()}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
                      <span className="tabular" style={{ fontSize: 12, fontWeight: 600 }}>
                        {formatCompactTokens(totalTok, locale, true)} Token
                      </span>
                      <span className="tabular" style={{ fontSize: 12, fontWeight: 600, color: 'var(--blue)' }}>
                        {row.priced === false && usd === 0 ? t('menu_panel.usage.unpriced') : formatUsd(usd)}
                      </span>
                    </div>
                  </div>
                  <div
                    className="tabular"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      fontSize: 11,
                      color: 'var(--text-secondary)',
                    }}
                  >
                    <span>
                      {t('usage_event.input')} {formatCompactTokens(inp, locale, true)} ·{' '}
                      {t('usage_event.cache_read')} {formatCompactTokens(cached, locale, true)}
                      {cacheWrite > 0
                        ? ` · ${t('usage_event.cache_write')} ${formatCompactTokens(cacheWrite, locale, true)}`
                        : ''}{' '}
                      · {t('usage_event.output')} {formatCompactTokens(out, locale, true)}
                    </span>
                    <span>{ts}</span>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Status line */}
        <div className="tabular" style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
          {rows.length > 0
            ? t('usage_log.status.page', {
                scope,
                total: formatInteger(total, locale),
                start: formatInteger(offset + 1, locale),
                end: formatInteger(offset + rows.length, locale),
              })
            : t('usage_log.status.empty')}
        </div>

        {/* Pagination Footer */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button
              type="button"
              className="gb-btn gb-btn-sm"
              disabled={loading || exporting || offset <= 0}
              onClick={() => {
                const next = Math.max(0, offset - PAGE_SIZE);
                setOffset(next);
                void fetchRows({ period, environmentId, accountId, query, offset: next });
              }}
            >
              {t('usage_log.prev_page')}
            </button>
            <button
              type="button"
              className="gb-btn gb-btn-sm"
              disabled={loading || exporting || offset + rows.length >= total}
              onClick={() => {
                const next = offset + PAGE_SIZE;
                setOffset(next);
                void fetchRows({ period, environmentId, accountId, query, offset: next });
              }}
            >
              {t('usage_log.next_page')}
            </button>
            <input
              type="text"
              className="gb-input tabular"
              style={{ width: 46, height: 26, textAlign: 'center' }}
              value={pageInput}
              disabled={loading || total === 0}
              onChange={(e) => setPageInput(e.target.value)}
              onBlur={handleJumpPage}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleJumpPage();
              }}
            />
            <span className="tabular" style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
              {t('usage_log.page_count', { pages: formatInteger(totalPages, locale) })}
            </span>
          </div>
          <button type="button" className="gb-btn gb-btn-primary" onClick={onClose}>
            {t('usage_log.done')}
          </button>
        </div>
      </div>
    </Modal>
  );
}
