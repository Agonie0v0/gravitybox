import { useEffect, useMemo, useState } from 'react';
import { BarChart2, Download, FileText, Gauge, RotateCw, Server, Tag } from 'lucide-react';
import { DONUT_PALETTE, DonutChart, type DonutSlice } from '../components/DonutChart';
import { BrandIcons } from '../components/ModelIcon';
import { TrendChart, type TrendBarPoint } from '../components/TrendChart';
import { useApp } from '../context/AppContext';
import {
  formatCompactTokens,
  formatInteger,
  formatLocalDateInput,
  formatOutputTps,
  formatThinkingEffortLabel,
  formatUsd,
  localizedModelLabel,
  parseHourIndex,
  usageScopeText,
} from '../lib/format';
import {
  normalizeSshEnvironment,
  sshStateSortOrder,
} from '../lib/ssh';
import { pickSaveJsonPath, saveJsonFile } from '../lib/tauri';
import type { ModelUsageRaw, UsagePeriodKey, UsageSummaryReply } from '../lib/types';
import { PricingSyncModal } from '../sheets/PricingSyncModal';
import { UsageLogModal } from '../sheets/UsageLogModal';

const PERIODS: UsagePeriodKey[] = ['today', '7d', '30d', 'all', 'custom'];

interface FlatModelEffortRow {
  key: string;
  model: string;
  modelId: string;
  thinkingEffort: string | null;
  effortLabel: string;
  donutLabel: string;
  totalTokens: number;
  promptTokens: number;
  candidatesTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  requestCount: number;
  estimatedUsd: number;
  unpricedTokens: number;
  priced: boolean;
  partiallyPriced: boolean;
  pricingStatus: string;
  medianOutputTps: number | null;
  speedSampleCount: number;
}

function normalizeEffortKey(raw: string | undefined | null): string {
  const trimmed = (raw ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (
    trimmed === 'extra_high' ||
    trimmed === 'extra' ||
    trimmed === 'x_high' ||
    trimmed === 'extrahigh'
  ) {
    return 'xhigh';
  }
  if (
    trimmed === 'x_low' ||
    trimmed === 'xlow' ||
    trimmed === 'extralow'
  ) {
    return 'extra_low';
  }
  return trimmed;
}

function defaultCustomStartDate(): string {
  const d = new Date();
  d.setDate(d.getDate() - 6);
  return formatLocalDateInput(d);
}

export function UsagePage() {
  const {
    t,
    locale,
    isDark,
    reachable,
    usageByPeriod,
    usageLoading,
    usageErrors,
    sshEnvironments,
    remoteSyncing,
    fetchUsage,
    refreshRemoteEnvironments,
    showToast,
  } = useApp();

  const [period, setPeriod] = useState<UsagePeriodKey>('today');
  const [customStartDate, setCustomStartDate] = useState<string>(defaultCustomStartDate);
  const [customEndDate, setCustomEndDate] = useState<string>(() => formatLocalDateInput(new Date()));
  const [environmentId, setEnvironmentId] = useState<string>('all');
  const [scopedReport, setScopedReport] = useState<UsageSummaryReply | null>(null);
  const [chartMetric, setChartMetric] = useState<'tokens' | 'requests' | 'cost'>('tokens');
  const [hoveredPt, setHoveredPt] = useState<TrendBarPoint | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [pricingOpen, setPricingOpen] = useState(false);

  const todayDateStr = formatLocalDateInput(new Date());
  const isCustomRangeValid = Boolean(
    customStartDate && customEndDate && customStartDate <= customEndDate,
  );
  const customRangeParam = useMemo(
    () =>
      period === 'custom' && isCustomRangeValid
        ? { startDate: customStartDate, endDate: customEndDate }
        : undefined,
    [period, isCustomRangeValid, customStartDate, customEndDate],
  );

  const normalizedSshHosts = useMemo(() => {
    const fallback = t('ssh.remote_fallback');
    const seen = new Map<string, ReturnType<typeof normalizeSshEnvironment>>();
    for (const env of sshEnvironments) {
      const norm = normalizeSshEnvironment(env, fallback);
      if (norm.id) seen.set(norm.id, norm);
    }
    const baseReport = usageByPeriod[period];
    for (const av of baseReport?.availableEnvironments ?? []) {
      const norm = normalizeSshEnvironment(av, fallback);
      if (norm.id && norm.id !== 'local' && norm.id !== 'all' && !seen.has(norm.id)) {
        seen.set(norm.id, norm);
      }
    }
    return Array.from(seen.values()).sort(
      (a, b) => sshStateSortOrder(b.state) - sshStateSortOrder(a.state) || a.hostLabel.localeCompare(b.hostLabel),
    );
  }, [period, sshEnvironments, t, usageByPeriod]);

  useEffect(() => {
    if (!reachable) return;
    if (period === 'custom' && !isCustomRangeValid) return;
    if (environmentId === 'all') {
      setScopedReport(null);
      void fetchUsage(period, false, undefined, customRangeParam);
    } else {
      let active = true;
      void fetchUsage(period, false, environmentId, customRangeParam).then((res) => {
        if (active && res) setScopedReport(res);
      });
      return () => {
        active = false;
      };
    }
  }, [period, environmentId, reachable, fetchUsage, isCustomRangeValid, customRangeParam]);

  const report = environmentId === 'all' ? usageByPeriod[period] : (scopedReport ?? usageByPeriod[period]);
  const selectedSshHost = useMemo(
    () => normalizedSshHosts.find((h) => h.id === environmentId) ?? null,
    [environmentId, normalizedSshHosts],
  );
  const loading = Boolean(usageLoading[period]);
  const readError = usageErrors[period];
  const summary = report?.summary ?? {};

  const totalTokens = summary.totalTokens ?? 0;
  const promptTokens = summary.promptTokens ?? 0;
  const outputTokens = summary.candidatesTokens ?? 0;
  const cachedTokens = summary.cachedTokens ?? 0;
  const cacheWriteTokens = summary.cacheWriteTokens ?? 0;
  const requestCount = summary.requestCount ?? 0;
  const estimatedUsd = summary.estimatedUsd ?? 0;
  const cacheDenom = promptTokens + cachedTokens + cacheWriteTokens;
  const cacheHitRate =
    summary.cacheHitRate ?? (cacheDenom > 0 ? (cachedTokens / cacheDenom) * 100 : 0);
  const medianOutputTps = summary.medianOutputTps ?? summary.median_output_tps ?? null;
  const speedSampleCount = Number(summary.speedSampleCount ?? summary.speed_sample_count ?? 0) || 0;

  const modelRows = useMemo<FlatModelEffortRow[]>(() => {
    const raw: ModelUsageRaw[] =
      report?.byModelEffort ?? report?.by_model_effort ?? report?.byModel ?? report?.models ?? [];
    const order: string[] = [];
    const grouped = new Map<
      string,
      {
        model: string;
        modelId: string;
        thinkingEffort: string | null;
        total: number;
        input: number;
        output: number;
        cached: number;
        cacheWrite: number;
        req: number;
        usd: number;
        unpriced: number;
        anyPriced: boolean;
        allPriced: boolean;
        pricingStatus: string;
        medianOutputTps: number | null;
        speedSampleCount: number;
      }
    >();

    for (const item of raw) {
      const model = String(item.model ?? '').trim();
      const effortNorm = normalizeEffortKey(item.thinkingEffort ?? item.thinking_effort);
      const key = `${model.toLowerCase()}::${effortNorm}`;
      const total = Number(item.totalTokens ?? item.total_tokens ?? 0) || 0;
      const input = Number(item.promptTokens ?? item.input_tokens ?? 0) || 0;
      const output = Number(item.candidatesTokens ?? item.output_tokens ?? 0) || 0;
      const cached = Number(item.cachedTokens ?? item.cached_tokens ?? 0) || 0;
      const cacheWrite = Number(item.cacheWriteTokens ?? item.cache_write_tokens ?? 0) || 0;
      const req = Number(item.requestCount ?? item.request_count ?? 0) || 0;
      const usd = Number(item.estimatedUsd ?? item.estimated_usd ?? 0) || 0;
      const unpriced = Number(item.unpricedTokens ?? item.unpriced_tokens ?? 0) || 0;
      const itemPartial = item.partiallyPriced === true;
      const itemPriced =
        item.priced ?? (usd > 0 || (unpriced === 0 && total > 0 && item.priced === undefined));
      const effectivePriced = itemPriced || itemPartial;
      const status = String(item.pricingStatus ?? '');
      const rawId = String(item.modelId ?? item.model_id ?? model);
      const rawTps = item.medianOutputTps ?? item.median_output_tps;
      const itemTps = typeof rawTps === 'number' && Number.isFinite(rawTps) && rawTps > 0 ? rawTps : null;
      const itemSamples = Number(item.speedSampleCount ?? item.speed_sample_count ?? 0) || 0;

      const existing = grouped.get(key);
      if (existing) {
        existing.total += total;
        existing.input += input;
        existing.output += output;
        existing.cached += cached;
        existing.cacheWrite += cacheWrite;
        existing.req += req;
        existing.usd += usd;
        existing.unpriced += unpriced;
        existing.anyPriced = existing.anyPriced || effectivePriced;
        existing.allPriced = existing.allPriced && itemPriced && !itemPartial;
        if ((!existing.pricingStatus || existing.pricingStatus === 'unpriced') && status && status !== 'unpriced') {
          existing.pricingStatus = status;
        }
        if (existing.medianOutputTps === null && itemTps !== null) {
          existing.medianOutputTps = itemTps;
          existing.speedSampleCount = itemSamples;
        }
      } else {
        order.push(key);
        grouped.set(key, {
          model,
          modelId: rawId || model,
          thinkingEffort: effortNorm || null,
          total,
          input,
          output,
          cached,
          cacheWrite,
          req,
          usd,
          unpriced,
          anyPriced: effectivePriced,
          allPriced: itemPriced && !itemPartial,
          pricingStatus: status,
          medianOutputTps: itemTps,
          speedSampleCount: itemSamples,
        });
      }
    }

    return order
      .map((key) => {
        const b = grouped.get(key)!;
        const baseName = localizedModelLabel(b.model, locale);
        const effortLabel = formatThinkingEffortLabel(b.thinkingEffort);
        const partiallyPriced = b.anyPriced && (!b.allPriced || b.unpriced > 0);
        const priced = b.allPriced && b.unpriced === 0;
        return {
          key,
          model: b.model,
          modelId: b.modelId,
          thinkingEffort: b.thinkingEffort,
          effortLabel,
          donutLabel: effortLabel ? `${baseName} (${effortLabel})` : baseName,
          totalTokens: b.total,
          promptTokens: b.input,
          candidatesTokens: b.output,
          cachedTokens: b.cached,
          cacheWriteTokens: b.cacheWrite,
          requestCount: b.req,
          estimatedUsd: b.usd,
          unpricedTokens: b.unpriced,
          priced,
          partiallyPriced,
          pricingStatus: b.pricingStatus,
          medianOutputTps: b.medianOutputTps,
          speedSampleCount: b.speedSampleCount,
        };
      })
      .sort((a, b) => {
        if (a.totalTokens !== b.totalTokens) return b.totalTokens - a.totalTokens;
        if (Math.abs(a.estimatedUsd - b.estimatedUsd) > 1e-12) return b.estimatedUsd - a.estimatedUsd;
        return b.requestCount - a.requestCount;
      });
  }, [report, locale]);

  const isCustomSingleDay =
    period === 'custom' &&
    isCustomRangeValid &&
    (report?.customRange?.isSingleDay ?? report?.custom_range?.isSingleDay ?? customStartDate === customEndDate);

  const trendPoints = useMemo<TrendBarPoint[]>(() => {
    const costPerToken = totalTokens > 0 && estimatedUsd > 0 ? estimatedUsd / totalTokens : 0;

    if (period === 'today' || isCustomSingleDay) {
      const hourly = report?.todayHourly ?? [];
      const map = new Map<number, { tokens: number; requests: number; cost: number; hasCost: boolean }>();
      for (const item of hourly) {
        const h = parseHourIndex(item);
        if (h !== null) {
          const prev = map.get(h) ?? { tokens: 0, requests: 0, cost: 0, hasCost: false };
          const rawCost = item.estimatedUsd ?? item.estimated_usd;
          const hasExplicitCost = typeof rawCost === 'number' && Number.isFinite(rawCost);
          map.set(h, {
            tokens: prev.tokens + (Number(item.totalTokens ?? item.total_tokens ?? 0) || 0),
            requests: prev.requests + (Number(item.requestCount ?? item.request_count ?? 0) || 0),
            cost: prev.cost + (hasExplicitCost ? rawCost : 0),
            hasCost: prev.hasCost || hasExplicitCost,
          });
        }
      }
      const nowHour = new Date().getHours();
      const isTodayBucket = period === 'today' || customEndDate === todayDateStr;
      return Array.from({ length: 24 }, (_, hour) => {
        const hh = String(hour).padStart(2, '0');
        const row = map.get(hour);
        const tokensVal = row?.tokens ?? 0;
        const costVal = row?.hasCost ? row.cost : tokensVal * costPerToken;
        const val =
          chartMetric === 'requests'
            ? row?.requests ?? 0
            : chartMetric === 'cost'
            ? costVal
            : tokensVal;
        return {
          label: locale === 'en' ? `${hh}h` : `${hh}时`,
          tooltipLabel:
            period === 'today'
              ? t('menu_panel.trend.today_key', { time: `${hh}:00` })
              : `${customStartDate} ${hh}:00`,
          value: val,
          isFuture: isTodayBucket && val === 0 && hour > nowHour,
        };
      });
    }

    const daily = report?.dailyTrends ?? [];
    const visibleDaily =
      period === '7d' ? daily.slice(-7) : period === '30d' ? daily.slice(-30) : daily;
    return visibleDaily.map((d) => {
      const shortDate = d.date.length >= 10 ? d.date.slice(5) : d.date;
      const tokensVal = Number(d.totalTokens ?? d.total_tokens ?? 0) || 0;
      const rawCost = d.estimatedUsd ?? d.estimated_usd;
      const costVal = typeof rawCost === 'number' && Number.isFinite(rawCost) ? rawCost : tokensVal * costPerToken;
      const val =
        chartMetric === 'requests'
          ? Number(d.requestCount ?? d.request_count ?? 0) || 0
          : chartMetric === 'cost'
          ? costVal
          : tokensVal;
      return {
        label: shortDate,
        tooltipLabel: d.date,
        value: val,
      };
    });
  }, [period, isCustomSingleDay, report, chartMetric, locale, t, totalTokens, estimatedUsd, customStartDate, customEndDate, todayDateStr]);

  // Donut slices (top 4 + Other)
  const { donutSlices, effectiveTotalUsd } = useMemo(() => {
    const priced = modelRows
      .filter((m) => (m.priced || m.partiallyPriced) && m.estimatedUsd > 0)
      .sort((a, b) => b.estimatedUsd - a.estimatedUsd);
    const totalPriced = priced.reduce((s, m) => s + m.estimatedUsd, 0);
    const effTotal = Math.max(estimatedUsd, totalPriced);
    const slices: DonutSlice[] = [];
    let otherUsd = 0;
    let otherCount = 0;
    priced.forEach((m, idx) => {
      if (idx < 4 || priced.length <= 5) {
        slices.push({
          label: m.donutLabel,
          usd: m.estimatedUsd,
          color: DONUT_PALETTE[idx % DONUT_PALETTE.length],
        });
      } else {
        otherUsd += m.estimatedUsd;
        otherCount += 1;
      }
    });
    if (otherCount > 0 && otherUsd > 0) {
      slices.push({
        label: t('usage.donut.other_models', { count: otherCount }),
        usd: otherUsd,
        color: '#8e8e93',
      });
    }
    return { donutSlices: slices, effectiveTotalUsd: effTotal };
  }, [modelRows, estimatedUsd, t]);

  const unpricedCount = summary.unpricedModels ?? modelRows.filter((m) => !m.priced && !m.partiallyPriced && m.totalTokens > 0).length;
  const failedDbs = summary.failedDatabasesCount ?? 0;
  const skippedRecs = summary.skippedLargeRecords ?? 0;
  const unknownRecs = summary.unknownTimeRecords ?? 0;
  const scannedDbs = summary.databasesScanned ?? 0;
  const discoveredDbs = summary.databasesDiscovered ?? scannedDbs;
  const hasFooterNotice =
    Boolean(readError) ||
    summary.availability === 'cached' ||
    failedDbs > 0 ||
    skippedRecs > 0 ||
    unknownRecs > 0 ||
    unpricedCount > 0;

  const handleExport = async () => {
    if (!report) return;
    const periodTag = period === 'custom' ? `${customStartDate}_${customEndDate}` : period;
    const defaultName = t('usage.models.export_filename', { period: periodTag });
    const path = await pickSaveJsonPath(t('usage.title'), defaultName);
    if (!path) return;
    try {
      await saveJsonFile(path, report);
      showToast(t('usage_log.export.done'));
    } catch (err) {
      showToast(t('usage_log.export.failed', { error: err instanceof Error ? err.message : String(err) }), true);
    }
  };

  const cacheWritePart =
    cacheWriteTokens > 0
      ? t('usage.tokens.cache_write_part', { count: formatCompactTokens(cacheWriteTokens, locale, true) })
      : '';

  return (
    <div className="gb-page-inner gb-fade-in">
      {/* Page Header */}
      <div className="gb-page-header" style={{ flexWrap: 'wrap' }}>
        <h1 className="gb-page-title">{t('usage.title')}</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <div className="gb-segmented">
            {PERIODS.map((p) => (
              <button
                key={p}
                type="button"
                className={`gb-segmented-btn ${period === p ? 'active' : ''}`}
                onClick={() => setPeriod(p)}
              >
                {t(
                  `usage.period.${p}`,
                  undefined,
                  p === 'custom' ? (locale === 'en' ? 'Custom' : '自定义') : undefined,
                )}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="gb-btn gb-btn-sm"
            disabled={!reachable || loading || (period === 'custom' && !isCustomRangeValid)}
            onClick={() => {
              if (environmentId === 'all') {
                void fetchUsage(period, true, undefined, customRangeParam);
              } else {
                void fetchUsage(period, true, environmentId, customRangeParam).then((res) => {
                  if (res) setScopedReport(res);
                });
              }
            }}
          >
            <RotateCw size={12} className={loading ? 'gb-spin' : undefined} />
            <span>{t('common.refresh')}</span>
          </button>
          <button
            type="button"
            className="gb-btn gb-btn-sm"
            disabled={!report || loading}
            onClick={handleExport}
          >
            <Download size={12} />
            <span>{t('usage.export_btn')}</span>
          </button>
        </div>
      </div>

      {/* Custom Date Range Pickers */}
      {period === 'custom' && (
        <div
          className="gb-card"
          style={{
            padding: '10px 14px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
              <span style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>
                {t('usage.custom.start_date', undefined, locale === 'en' ? 'Start Date' : '开始日期')}
              </span>
              <input
                type="date"
                className="gb-input tabular"
                value={customStartDate}
                max={todayDateStr}
                onChange={(e) => setCustomStartDate(e.target.value)}
              />
            </label>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
              <span style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>
                {t('usage.custom.end_date', undefined, locale === 'en' ? 'End Date' : '结束日期')}
              </span>
              <input
                type="date"
                className="gb-input tabular"
                value={customEndDate}
                max={todayDateStr}
                onChange={(e) => setCustomEndDate(e.target.value)}
              />
            </label>
          </div>
          {!isCustomRangeValid && (
            <span style={{ fontSize: 11.5, color: 'var(--danger)', fontWeight: 500 }}>
              {t(
                'usage.custom.invalid_range',
                undefined,
                locale === 'en' ? 'Start date must be on or before end date.' : '开始日期不能晚于结束日期。',
              )}
            </span>
          )}
        </div>
      )}

      {/* SSH Environment Scope Filter Bar (v1.2.0) */}
      {normalizedSshHosts.length > 0 && (
        <div
          className="gb-card"
          style={{
            padding: '9px 13px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
            flexWrap: 'wrap',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, fontWeight: 600, color: 'var(--text-secondary)' }}>
              <Server size={12} />
              <span>{t('usage.env.label')}</span>
            </span>
            <div className="gb-segmented" role="tablist" aria-label={t('usage.env.a11y')}>
              <button
                type="button"
                className={`gb-segmented-btn ${environmentId === 'all' ? 'active' : ''}`}
                onClick={() => setEnvironmentId('all')}
              >
                {t('usage.env.all_chip')}
              </button>
              <button
                type="button"
                className={`gb-segmented-btn ${environmentId === 'local' ? 'active' : ''}`}
                onClick={() => setEnvironmentId('local')}
              >
                {t('usage.env.local_label')}
              </button>
              {normalizedSshHosts.slice(0, 4).map((host) => (
                <button
                  key={host.id}
                  type="button"
                  className={`gb-segmented-btn ${environmentId === host.id ? 'active' : ''}`}
                  onClick={() => setEnvironmentId(host.id)}
                >
                  {host.state === 'offline_recent' || host.state === 'historical_only'
                    ? t('usage.env.offline_suffix', { label: t('usage.env.ssh_label', { host: host.hostLabel }) })
                    : t('usage.env.ssh_label', { host: host.hostLabel })}
                </button>
              ))}
            </div>
            {normalizedSshHosts.length > 4 && (
              <select
                className="gb-select"
                style={{ height: 26, fontSize: 11.5 }}
                aria-label={t('usage.env.more_hosts_a11y', { count: normalizedSshHosts.length - 4 })}
                value={normalizedSshHosts.slice(4).some((h) => h.id === environmentId) ? environmentId : ''}
                onChange={(e) => {
                  if (e.target.value) setEnvironmentId(e.target.value);
                }}
              >
                <option value="">
                  {normalizedSshHosts.length - 4 === 1
                    ? t('usage.env.more_hosts_one')
                    : t('usage.env.more_hosts_many', { count: normalizedSshHosts.length - 4 })}
                </option>
                {normalizedSshHosts.slice(4).map((host) => (
                  <option key={host.id} value={host.id}>
                    {t('usage.env.ssh_label', { host: host.hostLabel })}
                  </option>
                ))}
              </select>
            )}
          </div>
          <button
            type="button"
            className="gb-btn gb-btn-ghost gb-btn-sm"
            disabled={!reachable || remoteSyncing}
            onClick={() => void refreshRemoteEnvironments(environmentId)}
          >
            <RotateCw size={11.5} className={remoteSyncing ? 'gb-spin' : undefined} />
            <span>{locale === 'en' ? 'Sync SSH' : '同步 SSH'}</span>
          </button>
        </div>
      )}

      {selectedSshHost && (selectedSshHost.state === 'offline_recent' || selectedSshHost.state === 'historical_only') && (
        <div className="gb-subcard" style={{ padding: '8px 12px', fontSize: 11.5, color: 'var(--text-secondary)' }}>
          {selectedSshHost.state === 'offline_recent'
            ? t('usage.env.offline_recent_notice', { host: selectedSshHost.hostLabel })
            : t('usage.env.historical_notice', { host: selectedSshHost.hostLabel })}
        </div>
      )}

      {/* Full-width Token Usage & Trend Card */}
      <div className="gb-card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
              {t('usage.section.token_usage')}
            </div>
            <div className="tabular" style={{ fontSize: 30, fontWeight: 700, lineHeight: 1.15, marginTop: 2 }}>
              {formatCompactTokens(totalTokens, locale, true)}
            </div>
            <div className="tabular" style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 4 }}>
              {report
                ? t('usage.tokens.summary', {
                    input: formatCompactTokens(promptTokens, locale, true),
                    cached: formatCompactTokens(cachedTokens, locale, true),
                    cacheWrite: cacheWritePart,
                    output: formatCompactTokens(outputTokens, locale, true),
                  })
                : t('usage.tokens.placeholder')}
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600 }}>
              {t(
                `usage.trend_title.${period}`,
                undefined,
                period === 'custom' ? (locale === 'en' ? 'Custom Range Usage' : '自定义时段用量') : undefined,
              )}
            </div>
            <div className="gb-segmented">
              <button
                type="button"
                className={`gb-segmented-btn ${chartMetric === 'tokens' ? 'active' : ''}`}
                style={{ height: 22, padding: '0 8px', fontSize: 11 }}
                onClick={() => setChartMetric('tokens')}
              >
                {t('menu_panel.dim.tokens')}
              </button>
              <button
                type="button"
                className={`gb-segmented-btn ${chartMetric === 'requests' ? 'active' : ''}`}
                style={{ height: 22, padding: '0 8px', fontSize: 11 }}
                onClick={() => setChartMetric('requests')}
              >
                {t('menu_panel.dim.requests')}
              </button>
              <button
                type="button"
                className={`gb-segmented-btn ${chartMetric === 'cost' ? 'active' : ''}`}
                style={{ height: 22, padding: '0 8px', fontSize: 11 }}
                onClick={() => setChartMetric('cost')}
              >
                {locale === 'en' ? 'Cost' : '费用'}
              </button>
            </div>
          </div>
        </div>

        {hoveredPt && (
          <div className="tabular" style={{ fontSize: 11.5, color: 'var(--blue)', fontWeight: 500 }}>
            {hoveredPt.tooltipLabel} ·{' '}
            {chartMetric === 'cost'
              ? formatUsd(hoveredPt.value)
              : chartMetric === 'requests'
              ? `${formatInteger(hoveredPt.value, locale)} ${t('menu_panel.dim.requests')}`
              : `${formatCompactTokens(hoveredPt.value, locale, true)} Token`}
          </div>
        )}

        <TrendChart
          points={trendPoints}
          metric={chartMetric}
          locale={locale}
          height={138}
          onHover={setHoveredPt}
        />
      </div>

      {/* Middle 2-Column Row: API Cost Donut + Requests & Cache */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1.12fr 1fr',
          gap: 12,
        }}
      >
        {/* Left: API Cost Estimation */}
        <div className="gb-card" style={{ padding: 15, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <span style={{ fontSize: 13.5, fontWeight: 600 }}>{t('usage.section.cost')}</span>
              <button
                type="button"
                className="gb-btn gb-btn-ghost gb-btn-sm"
                style={{ height: 22, padding: '0 7px', fontSize: 11 }}
                onClick={() => setPricingOpen(true)}
              >
                <Tag size={11} />
                <span>{t('pricing_sheet.title')}</span>
              </button>
            </div>
            <span className="tabular" style={{ fontSize: 23, fontWeight: 700 }}>
              {formatUsd(estimatedUsd)}
            </span>
          </div>

          <div className="gb-divider" />

          {donutSlices.length > 0 ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, flex: 1 }}>
              <DonutChart
                slices={donutSlices}
                totalUsd={effectiveTotalUsd}
                centerCaption={t('component.donut.equivalent_bill')}
              />
              <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 7 }}>
                {donutSlices.map((s) => {
                  const pct = effectiveTotalUsd > 0 ? Math.round((s.usd / effectiveTotalUsd) * 100) : 0;
                  const pctStr = s.usd > 0 && pct === 0 ? '<1%' : `${pct}%`;
                  return (
                    <div key={s.label} style={{ display: 'flex', alignItems: 'flex-start', gap: 7, minWidth: 0 }}>
                      <span
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: '50%',
                          background: s.color,
                          marginTop: 4,
                          flexShrink: 0,
                        }}
                      />
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div
                          style={{
                            fontSize: 12,
                            fontWeight: 600,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {s.label}
                        </div>
                        <div className="tabular" style={{ fontSize: 10.5, color: 'var(--text-secondary)' }}>
                          {t('usage.donut.value_share', { usd: formatUsd(s.usd), pct: pctStr })}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', padding: '24px 0', textAlign: 'center' }}>
              {modelRows.length === 0 ? t('usage.donut.empty_calls') : t('usage.donut.zero_cost')}
            </div>
          )}

          {unpricedCount > 0 && (
            <div style={{ fontSize: 11, color: 'var(--warning)' }}>
              {t('usage.cost.unpriced_models_note', { count: unpricedCount })}
            </div>
          )}
        </div>

        {/* Right: Requests & Cache */}
        <div className="gb-card" style={{ padding: 15, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ fontSize: 13.5, fontWeight: 600 }}>{t('usage.section.requests_cache')}</span>
            <button type="button" className="gb-btn gb-btn-sm" onClick={() => setLogOpen(true)}>
              <FileText size={12} />
              <span>{t('usage.request_details_btn')}</span>
            </button>
          </div>

          <div className="gb-divider" />

          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'space-around', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
              <div>
                <div style={{ fontSize: 12.5, fontWeight: 600 }}>{t('usage.section.total_requests')}</div>
                <div className="tabular" style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
                  {requestCount > 0
                    ? t('usage.requests.avg_per_call', {
                        count: formatCompactTokens(Math.round(totalTokens / requestCount), locale, true),
                      })
                    : t('usage.requests.none')}
                </div>
              </div>
              <div className="tabular" style={{ fontSize: 22, fontWeight: 700 }}>
                {t('usage.requests.value', { count: formatInteger(requestCount, locale) })}
              </div>
            </div>

            <div className="gb-divider" />

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                <div>
                  <div style={{ fontSize: 12.5, fontWeight: 600 }}>{t('usage.section.cache_hit_rate')}</div>
                  <div className="tabular" style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
                    {t('usage.cache.read_detail', {
                      count: formatCompactTokens(cachedTokens, locale, true),
                    })}
                  </div>
                </div>
                <div className="tabular" style={{ fontSize: 21, fontWeight: 700 }}>
                  {cacheHitRate.toFixed(1)}%
                </div>
              </div>

              <div>
                <div style={{ height: 6.5, borderRadius: 999, background: 'var(--track)', overflow: 'hidden' }}>
                  <div
                    style={{
                      width: `${Math.max(0, Math.min(100, cacheHitRate))}%`,
                      height: '100%',
                      borderRadius: 999,
                      background: 'var(--blue-bright)',
                      transition: 'width 260ms ease',
                    }}
                  />
                </div>
                <div
                  className="tabular"
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontSize: 10,
                    color: 'var(--text-secondary)',
                    marginTop: 3,
                  }}
                >
                  <span>0%</span>
                  <span>100%</span>
                </div>
              </div>
            </div>

            <div className="gb-divider" />

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12.5, fontWeight: 600 }}>
                  <Gauge size={13} style={{ color: 'var(--blue)' }} />
                  <span>
                    {t('usage.section.output_speed', undefined, locale === 'en' ? 'Output Speed' : '输出速度')}
                  </span>
                </div>
                <div className="tabular" style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
                  {speedSampleCount > 0 && typeof medianOutputTps === 'number' && medianOutputTps > 0
                    ? t(
                        'usage.speed.median_desc',
                        { count: speedSampleCount },
                        locale === 'en'
                          ? `Median of last ${speedSampleCount} replies`
                          : `最近 ${speedSampleCount} 次回复中位数`,
                      )
                    : t(
                        'usage.speed.no_samples',
                        undefined,
                        locale === 'en' ? 'No streaming duration samples yet' : '暂无流式耗时样本',
                      )}
                </div>
              </div>
              <div className="tabular" style={{ fontSize: 19, fontWeight: 700 }}>
                {formatOutputTps(medianOutputTps)}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Model Breakdown List */}
      <div className="gb-card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 13.5, fontWeight: 600 }}>{t('usage.section.model_breakdown')}</span>
          <span className="tabular" style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
            {modelRows.length > 0 ? t('usage.models.count', { count: modelRows.length }) : ''}
          </span>
        </div>

        {modelRows.length === 0 ? (
          <div
            style={{
              padding: '28px 0',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 8,
              color: 'var(--text-secondary)',
            }}
          >
            <BarChart2 size={22} />
            <span style={{ fontSize: 13 }}>{t('usage.models.empty')}</span>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {modelRows.map((item, idx) => {
              const name = localizedModelLabel(item.model, locale);
              const sharePct =
                totalTokens > 0 ? Math.min(100, Math.max(0, Math.round((item.totalTokens / totalTokens) * 100))) : 0;
              const shareText = item.totalTokens > 0 && sharePct === 0 ? '<1%' : `${sharePct}%`;
              const costLabel =
                item.priced || item.partiallyPriced
                  ? `${item.partiallyPriced ? t('usage.models.partial_prefix') : ''}${formatUsd(item.estimatedUsd)}`
                  : item.totalTokens > 0
                  ? t('menu_panel.usage.unpriced')
                  : '$0.00';

              return (
                <div key={item.key}>
                  {idx > 0 && <div className="gb-divider" style={{ marginBottom: 12 }} />}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                      <div
                        className="gb-subcard"
                        style={{
                          width: 30,
                          height: 30,
                          borderRadius: 8,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexShrink: 0,
                        }}
                      >
                        <BrandIcons fallbackName={name} size={16} isDark={isDark} />
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                          <span
                            style={{
                              fontSize: 13.5,
                              fontWeight: 600,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {name}
                          </span>
                          {item.effortLabel && (
                            <span
                              className="gb-pill gb-pill-blue"
                              style={{ height: 18, padding: '0 6px', fontSize: 10, flexShrink: 0 }}
                            >
                              {item.effortLabel}
                            </span>
                          )}
                        </div>
                        <div
                          className="tabular"
                          style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 2, display: 'flex', gap: 10, flexWrap: 'wrap' }}
                        >
                          <span style={{ color: 'var(--text)', fontWeight: 600 }}>
                            {t('usage.model_row.tokens', {
                              tokens: formatCompactTokens(item.totalTokens, locale, true),
                            })}
                          </span>
                          <span>
                            {t('usage.model_row.requests', { count: formatInteger(item.requestCount, locale) })}
                          </span>
                          {item.medianOutputTps !== null && (
                            <span>{formatOutputTps(item.medianOutputTps)}</span>
                          )}
                        </div>
                      </div>
                    </div>

                    <div style={{ textAlign: 'right', flexShrink: 0 }}>
                      <div className="tabular" style={{ fontSize: 14, fontWeight: 700 }}>
                        {costLabel}
                      </div>
                      <div className="tabular" style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
                        {t('usage.model_row.share', { share: shareText })}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Warning / Scope Footer */}
      {hasFooterNotice && (
        <div
          className="gb-subcard"
          style={{
            padding: '10px 13px',
            fontSize: 11.5,
            color: 'var(--warning)',
          }}
        >
          {readError
            ? t('usage.error.read_keep_cached', { period, error: readError })
            : [
                summary.availability === 'cached' ? t('usage.status.cached_record') : '',
                usageScopeText(scannedDbs, discoveredDbs, failedDbs, skippedRecs, unknownRecs, locale),
                unpricedCount > 0 ? t('usage.status.unpriced_models', { count: unpricedCount }) : '',
              ]
                .filter(Boolean)
                .join(' · ')}
        </div>
      )}

      <UsageLogModal
        open={logOpen}
        initialPeriod={period}
        initialEnvironmentId={environmentId}
        initialStartDate={customStartDate}
        initialEndDate={customEndDate}
        onClose={() => setLogOpen(false)}
      />
      <PricingSyncModal open={pricingOpen} onClose={() => setPricingOpen(false)} />
    </div>
  );
}
