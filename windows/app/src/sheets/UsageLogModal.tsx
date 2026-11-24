import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, RotateCw, Search } from 'lucide-react';
import { Modal } from '../components/Modal';
import { BrandIcons } from '../components/ModelIcon';
import { useApp } from '../context/AppContext';
import {
  formatCompactTokens,
  formatInteger,
  formatLocalDateInput,
  formatOutputTps,
  formatShortDateTime,
  formatThinkingEffortLabel,
  formatUsd,
  localizedModelLabel,
} from '../lib/format';
import { backendRequest, pickSaveJsonPath, saveJsonFile } from '../lib/tauri';
import { cleanSshHostLabel, normalizeSshEnvironment } from '../lib/ssh';
import type { UsageEventRow, UsageEventsReply, UsagePeriodKey } from '../lib/types';

const PERIODS: UsagePeriodKey[] = ['today', '7d', '30d', 'all', 'custom'];
const PAGE_SIZE = 200;

function defaultLogStartDate(): string {
  const d = new Date();
  d.setDate(d.getDate() - 6);
  return formatLocalDateInput(d);
}

export function UsageLogModal({
  open,
  initialPeriod,
  initialEnvironmentId = 'all',
  initialStartDate,
  initialEndDate,
  onClose,
}: {
  open: boolean;
  initialPeriod: UsagePeriodKey;
  initialEnvironmentId?: string;
  initialStartDate?: string;
  initialEndDate?: string;
  onClose: () => void;
}) {
  const { t, locale, isDark, sshEnvironments, showToast } = useApp();
  const [period, setPeriod] = useState<UsagePeriodKey>(initialPeriod);
  const [startDate, setStartDate] = useState<string>(() => initialStartDate || defaultLogStartDate());
  const [endDate, setEndDate] = useState<string>(() => initialEndDate || formatLocalDateInput(new Date()));
  const [environmentId, setEnvironmentId] = useState<string>(initialEnvironmentId);
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<UsageEventRow[]>([]);
  const [total, setTotal] = useState(0);
  const [scope, setScope] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [pageInput, setPageInput] = useState('1');
  const snapshotIdRef = useRef<string | null>(null);
  const debounceRef = useRef<number | null>(null);

  const todayDateStr = formatLocalDateInput(new Date());
  const isCustomRangeValid = Boolean(startDate && endDate && startDate <= endDate);

  const normalizedSshHosts = sshEnvironments.map((env) =>
    normalizeSshEnvironment(env, t('ssh.remote_fallback')),
  );

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
      query: string;
      offset: number;
      startDate?: string;
      endDate?: string;
      force?: boolean;
    }) => {
      if (opts.period === 'custom' && (!opts.startDate || !opts.endDate || opts.startDate > opts.endDate)) {
        return;
      }
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
        if (opts.period === 'custom' && opts.startDate && opts.endDate) {
          payload.startDate = opts.startDate;
          payload.endDate = opts.endDate;
        }
        if (opts.environmentId && opts.environmentId !== 'all') {
          payload.environmentId = opts.environmentId;
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
      const nextStart = initialStartDate || defaultLogStartDate();
      const nextEnd = initialEndDate || formatLocalDateInput(new Date());
      setPeriod(initialPeriod);
      setEnvironmentId(initialEnvironmentId);
      setStartDate(nextStart);
      setEndDate(nextEnd);
      setQuery('');
      setOffset(0);
      if (initialPeriod !== 'custom' || (nextStart && nextEnd && nextStart <= nextEnd)) {
        void fetchRows({
          period: initialPeriod,
          environmentId: initialEnvironmentId,
          query: '',
          offset: 0,
          startDate: nextStart,
          endDate: nextEnd,
          force: false,
        });
      }
    } else {
      releaseSnapshot();
    }
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, [open, initialPeriod, initialEnvironmentId, initialStartDate, initialEndDate, fetchRows, releaseSnapshot]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  const handleQueryChange = (val: string) => {
    setQuery(val);
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      setOffset(0);
      void fetchRows({ period, environmentId, query: val, offset: 0, startDate, endDate });
    }, 180);
  };

  const handlePeriodChange = (next: UsagePeriodKey) => {
    releaseSnapshot();
    setPeriod(next);
    setOffset(0);
    if (next !== 'custom' || isCustomRangeValid) {
      void fetchRows({
        period: next,
        environmentId,
        query,
        offset: 0,
        startDate,
        endDate,
        force: true,
      });
    }
  };

  const handleCustomDatesChange = (nextStart: string, nextEnd: string) => {
    releaseSnapshot();
    setStartDate(nextStart);
    setEndDate(nextEnd);
    setOffset(0);
    if (nextStart && nextEnd && nextStart <= nextEnd) {
      void fetchRows({
        period: 'custom',
        environmentId,
        query,
        offset: 0,
        startDate: nextStart,
        endDate: nextEnd,
        force: true,
      });
    }
  };

  const handleEnvironmentChange = (nextEnv: string) => {
    releaseSnapshot();
    setEnvironmentId(nextEnv);
    setOffset(0);
    void fetchRows({
      period,
      environmentId: nextEnv,
      query,
      offset: 0,
      startDate,
      endDate,
      force: true,
    });
  };

  const handleJumpPage = () => {
    const n = Number.parseInt(pageInput.trim(), 10);
    if (!Number.isInteger(n) || n < 1 || n > totalPages) {
      setPageInput(String(currentPage));
      return;
    }
    const nextOffset = (n - 1) * PAGE_SIZE;
    setOffset(nextOffset);
    void fetchRows({ period, environmentId, query, offset: nextOffset, startDate, endDate });
  };

  const handleExport = async () => {
    const periodTag = period === 'custom' ? `${startDate}_${endDate}` : period;
    const targetPath = await pickSaveJsonPath(
      t('usage_log.title'),
      t('usage_log.export.filename', { period: periodTag }),
    );
    if (!targetPath) return;
    try {
      await saveJsonFile(targetPath, {
        period,
        ...(period === 'custom' ? { startDate, endDate } : {}),
        query,
        scope,
        total,
        rows,
      });
      showToast(t('usage_log.export.done'));
    } catch (err) {
      showToast(t('usage_log.export.failed', { error: err instanceof Error ? err.message : String(err) }), true);
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
              disabled={loading || (period === 'custom' && !isCustomRangeValid)}
              onClick={() => {
                releaseSnapshot();
                setOffset(0);
                void fetchRows({
                  period,
                  environmentId,
                  query,
                  offset: 0,
                  startDate,
                  endDate,
                  force: true,
                });
              }}
            >
              <RotateCw size={12} className={loading ? 'gb-spin' : undefined} />
              <span>{t('common.refresh')}</span>
            </button>
            <button
              type="button"
              className="gb-btn gb-btn-sm"
              disabled={loading || rows.length === 0}
              onClick={handleExport}
            >
              <Download size={12} />
              <span>{t('usage.export_btn')}</span>
            </button>
          </div>
        </div>

        {/* Search + Environment + Period filter */}
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
          <div className="gb-segmented">
            {PERIODS.map((p) => (
              <button
                key={p}
                type="button"
                className={`gb-segmented-btn ${period === p ? 'active' : ''}`}
                onClick={() => handlePeriodChange(p)}
              >
                {t(
                  `usage.period.${p}`,
                  undefined,
                  p === 'custom' ? (locale === 'en' ? 'Custom' : '自定义') : undefined,
                )}
              </button>
            ))}
          </div>
        </div>

        {/* Inline Custom Date Pickers */}
        {period === 'custom' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5 }}>
              <span style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>
                {t('usage.custom.start_date', undefined, locale === 'en' ? 'Start Date' : '开始日期')}
              </span>
              <input
                type="date"
                className="gb-input tabular"
                style={{ height: 26 }}
                value={startDate}
                max={todayDateStr}
                onChange={(e) => handleCustomDatesChange(e.target.value, endDate)}
              />
            </label>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5 }}>
              <span style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>
                {t('usage.custom.end_date', undefined, locale === 'en' ? 'End Date' : '结束日期')}
              </span>
              <input
                type="date"
                className="gb-input tabular"
                style={{ height: 26 }}
                value={endDate}
                max={todayDateStr}
                onChange={(e) => handleCustomDatesChange(startDate, e.target.value)}
              />
            </label>
            {!isCustomRangeValid && (
              <span style={{ fontSize: 11, color: 'var(--danger)', fontWeight: 500 }}>
                {t(
                  'usage.custom.invalid_range',
                  undefined,
                  locale === 'en' ? 'Start date must be on or before end date.' : '开始日期不能晚于结束日期。',
                )}
              </span>
            )}
          </div>
        )}

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
              const effortLabel = formatThinkingEffortLabel(
                row.thinkingEffort ?? row.thinking_effort,
              );
              const inp = Number(row.inputTokens ?? row.input_tokens ?? 0);
              const out = Number(row.outputTokens ?? row.output_tokens ?? 0);
              const cached = Number(row.cachedTokens ?? row.cached_tokens ?? 0);
              const cacheWrite = Number(row.cacheWriteTokens ?? row.cache_write_tokens ?? 0);
              const totalTok = Number(row.totalTokens ?? row.total_tokens ?? inp + out + cached + cacheWrite);
              const usd = Number(row.estimatedUsd ?? row.estimated_usd ?? 0);
              const rawTps = row.outputTps ?? row.output_tps;
              const streamSec = row.streamingDurationSeconds ?? row.streaming_duration_seconds;
              const effectiveTps =
                typeof rawTps === 'number' && Number.isFinite(rawTps) && rawTps > 0
                  ? rawTps
                  : out > 0 && typeof streamSec === 'number' && Number.isFinite(streamSec) && streamSec > 0
                  ? out / streamSec
                  : null;
              const ts = row.timestamp
                ? typeof row.timestamp === 'number'
                  ? formatShortDateTime(row.timestamp)
                  : formatShortDateTime(new Date(row.timestamp))
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
                      {effortLabel && (
                        <span
                          className="gb-pill gb-pill-blue"
                          style={{ height: 18, padding: '0 6px', fontSize: 10, flexShrink: 0 }}
                        >
                          {effortLabel}
                        </span>
                      )}
                      {(() => {
                        const rowEnvId = row.environmentId || row.environment_id || '';
                        const isRemote =
                          (rowEnvId && rowEnvId !== 'local') || row.environmentKind === 'ssh';
                        if (!isRemote) return null;
                        const label = cleanSshHostLabel(
                          row.hostLabel || row.host_label || row.environmentLabel || rowEnvId,
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
                      {effectiveTps !== null ? ` · ${formatOutputTps(effectiveTps)}` : ''}
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
              disabled={loading || offset <= 0}
              onClick={() => {
                const next = Math.max(0, offset - PAGE_SIZE);
                setOffset(next);
                void fetchRows({ period, environmentId, query, offset: next, startDate, endDate });
              }}
            >
              {t('usage_log.prev_page')}
            </button>
            <button
              type="button"
              className="gb-btn gb-btn-sm"
              disabled={loading || offset + rows.length >= total}
              onClick={() => {
                const next = offset + PAGE_SIZE;
                setOffset(next);
                void fetchRows({ period, environmentId, query, offset: next, startDate, endDate });
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
