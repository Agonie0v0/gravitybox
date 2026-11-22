import { useEffect, useMemo, useState } from 'react';
import { BarChart2, Download, FileText, RotateCw, Tag } from 'lucide-react';
import { DONUT_PALETTE, DonutChart, type DonutSlice } from '../components/DonutChart';
import { BrandIcons } from '../components/ModelIcon';
import { TrendChart, type TrendBarPoint } from '../components/TrendChart';
import { useApp } from '../context/AppContext';
import {
  foldThinkingVariants,
  formatCompactTokens,
  formatInteger,
  formatUsd,
  localizedModelLabel,
  parseHourIndex,
  sortModelsByUsage,
  usageScopeText,
} from '../lib/format';
import { pickSaveJsonPath, saveJsonFile } from '../lib/tauri';
import type { UsagePeriodKey } from '../lib/types';
import { PricingSyncModal } from '../sheets/PricingSyncModal';
import { UsageLogModal } from '../sheets/UsageLogModal';

const PERIODS: UsagePeriodKey[] = ['today', '7d', '30d', 'all'];

export function UsagePage() {
  const {
    t,
    locale,
    isDark,
    reachable,
    usageByPeriod,
    usageLoading,
    usageErrors,
    fetchUsage,
    showToast,
  } = useApp();

  const [period, setPeriod] = useState<UsagePeriodKey>('today');
  const [chartMetric, setChartMetric] = useState<'tokens' | 'requests' | 'cost'>('tokens');
  const [hoveredPt, setHoveredPt] = useState<TrendBarPoint | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [pricingOpen, setPricingOpen] = useState(false);

  useEffect(() => {
    if (reachable) {
      void fetchUsage(period, false);
    }
  }, [period, reachable, fetchUsage]);

  const report = usageByPeriod[period];
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

  const modelRows = useMemo(() => {
    const raw = report?.byModel ?? report?.models ?? [];
    return sortModelsByUsage(foldThinkingVariants(raw));
  }, [report]);

  const trendPoints = useMemo<TrendBarPoint[]>(() => {
    const costPerToken = totalTokens > 0 && estimatedUsd > 0 ? estimatedUsd / totalTokens : 0;

    if (period === 'today') {
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
          tooltipLabel: t('menu_panel.trend.today_key', { time: `${hh}:00` }),
          value: val,
          isFuture: val === 0 && hour > nowHour,
        };
      });
    }

    const daily = report?.dailyTrends ?? [];
    const limit = period === '7d' ? 7 : period === '30d' ? 30 : Math.max(30, daily.length);
    return daily.slice(-limit).map((d) => {
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
  }, [period, report, chartMetric, locale, t, totalTokens, estimatedUsd]);

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
          label: localizedModelLabel(m.model, locale),
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
  }, [modelRows, estimatedUsd, locale, t]);

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
    const defaultName = t('usage.models.export_filename', { period });
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div className="gb-segmented">
            {PERIODS.map((p) => (
              <button
                key={p}
                type="button"
                className={`gb-segmented-btn ${period === p ? 'active' : ''}`}
                onClick={() => setPeriod(p)}
              >
                {t(`usage.period.${p}`)}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="gb-btn gb-btn-sm"
            disabled={!reachable || loading}
            onClick={() => void fetchUsage(period, true)}
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
            <div style={{ fontSize: 13.5, fontWeight: 600 }}>{t(`usage.trend_title.${period}`)}</div>
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
                <div key={item.model}>
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
                        <div
                          style={{
                            fontSize: 13.5,
                            fontWeight: 600,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {name}
                        </div>
                        <div
                          className="tabular"
                          style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 2, display: 'flex', gap: 10 }}
                        >
                          <span style={{ color: 'var(--text)', fontWeight: 600 }}>
                            {t('usage.model_row.tokens', {
                              tokens: formatCompactTokens(item.totalTokens, locale, true),
                            })}
                          </span>
                          <span>
                            {t('usage.model_row.requests', { count: formatInteger(item.requestCount, locale) })}
                          </span>
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

      <UsageLogModal open={logOpen} initialPeriod={period} onClose={() => setLogOpen(false)} />
      <PricingSyncModal open={pricingOpen} onClose={() => setPricingOpen(false)} />
    </div>
  );
}
