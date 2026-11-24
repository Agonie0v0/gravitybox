import { useEffect, useState } from 'react';
import { CheckCircle2, DollarSign, ExternalLink, RotateCw } from 'lucide-react';
import { Modal } from '../components/Modal';
import { useApp } from '../context/AppContext';
import { backendRequest, openExternalUrl } from '../lib/tauri';
import type { PricingPayload } from '../lib/types';

function fmtRate(val: number | undefined): string {
  if (val === undefined || !Number.isFinite(val)) return '$0.00';
  const s = val.toFixed(4).replace(/0+$/, '');
  const parts = s.split('.');
  if (parts.length === 1) return `$${parts[0]}.00`;
  if (parts[1].length === 1) return `$${parts[0]}.${parts[1]}0`;
  return `$${s}`;
}

export function PricingSyncModal({
  open,
  initialPayload,
  onClose,
}: {
  open: boolean;
  initialPayload?: PricingPayload | null;
  onClose: () => void;
}) {
  const { t, fetchDashboard, fetchUsage, showToast } = useApp();
  const [payload, setPayload] = useState<PricingPayload | null>(initialPayload ?? null);
  const [checking, setChecking] = useState(false);
  const [retiredExpanded, setRetiredExpanded] = useState(false);

  useEffect(() => {
    if (open) {
      if (initialPayload) {
        setPayload(initialPayload);
      } else {
        setChecking(true);
        void backendRequest<PricingPayload>({ command: 'api_pricing_get' })
          .then(setPayload)
          .catch((e) => showToast(String(e), true))
          .finally(() => setChecking(false));
      }
    }
  }, [open, initialPayload, showToast]);

  const handleRecheck = async () => {
    setChecking(true);
    try {
      const res = await backendRequest<PricingPayload>({ command: 'pricing_sync_check' });
      setPayload(res);
      if (res.synced) {
        void fetchDashboard(true);
        void fetchUsage('today', true);
      }
    } catch (err) {
      showToast(t('pricing_sheet.check_failed', { error: err instanceof Error ? err.message : String(err) }), true);
    } finally {
      setChecking(false);
    }
  };

  const prices = payload?.prices ?? {};
  const retiredPrices = payload?.retiredPrices ?? {};
  const allRateEntries = { ...retiredPrices, ...prices };
  const catalogState = payload?.modelCatalogState ?? payload?.catalogState ?? {};
  const pricingStatus = payload?.pricingStatus ?? {};
  const unpricedLive = payload?.unpricedLiveModels ?? [];

  const allKeys = Object.keys(prices);
  const currentKeys: string[] = [];
  const otherTierKeys: string[] = [];
  const retiredKeySet = new Set<string>(Object.keys(retiredPrices));

  for (const key of allKeys) {
    const av = catalogState[key]?.availability;
    if (av === 'retired') retiredKeySet.add(key);
    else if (av === 'other_tier_only') otherTierKeys.push(key);
    else currentKeys.push(key);
  }
  const retiredKeys = Array.from(retiredKeySet);

  const sortKeys = (list: string[]) =>
    [...list].sort((a, b) => {
      const oa = catalogState[a]?.hostOrder ?? 9999;
      const ob = catalogState[b]?.hostOrder ?? 9999;
      if (oa !== ob) return oa - ob;
      return a.localeCompare(b);
    });

  const sortedCurrent = sortKeys(currentKeys);
  const sortedOther = sortKeys(otherTierKeys);
  const sortedRetired = sortKeys(retiredKeys);

  const modelCount = payload?.status?.modelCount ?? allKeys.length;
  const version = payload?.status?.feedVersion ?? payload?.status?.version;
  const healedRecords = payload?.healedCount ?? payload?.healedRecords ?? 0;

  const renderRateCard = (key: string, dimmed = false) => {
    const entry = allRateEntries[key];
    if (!entry) return null;
    const cat = catalogState[key];
    const displayName = cat?.displayName || entry.displayName || '';
    const state =
      pricingStatus[key] ||
      entry.provenance?.verification ||
      entry.provenance?.state ||
      entry.state ||
      cat?.state ||
      'confirmed';
    const checkedAt = entry.provenance?.checkedAt || '';
    const validUntil = entry.provenance?.validUntil || '';
    const sourceUrl = entry.provenance?.sourceUrl || '';

    const stateLabel =
      state === 'confirmed'
        ? t('pricing_sheet.state.confirmed')
        : state === 'user'
        ? t('pricing_sheet.state.user')
        : state === 'expired'
        ? t('pricing_sheet.state.expired')
        : t('pricing_sheet.state.historical');

    const rateParts = [
      t('pricing_sheet.rate.input', { rate: fmtRate(entry.input) }),
      t('pricing_sheet.rate.cache_read', { rate: fmtRate(entry.cached) }),
    ];
    if (entry.cacheWrite && entry.cacheWrite > 0) {
      rateParts.push(t('pricing_sheet.rate.cache_write', { rate: fmtRate(entry.cacheWrite) }));
    }
    rateParts.push(t('pricing_sheet.rate.output', { rate: fmtRate(entry.output) }));

    return (
      <div
        key={key}
        className="gb-subcard"
        style={{
          padding: '9px 12px',
          display: 'flex',
          flexDirection: 'column',
          gap: 5,
          opacity: dimmed ? 0.72 : 1,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, minWidth: 0 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
              {displayName && displayName.toLowerCase() !== key.toLowerCase() ? displayName : key}
            </span>
            {displayName && displayName.toLowerCase() !== key.toLowerCase() && (
              <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{key}</span>
            )}
          </div>
          {(state === 'expired' || state === 'user' || cat?.availability === 'tier_locked' || dimmed) && (
            <span
              className={`gb-pill ${
                state === 'expired'
                  ? 'gb-pill-warning'
                  : state === 'user'
                  ? 'gb-pill-blue'
                  : 'gb-pill-neutral'
              }`}
            >
              {cat?.availability === 'tier_locked'
                ? t('pricing_sheet.availability.tier_locked')
                : dimmed
                ? t('pricing_sheet.availability.retired')
                : stateLabel}
            </span>
          )}
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            flexWrap: 'wrap',
            fontSize: 11.5,
          }}
        >
          <span className="tabular" style={{ fontWeight: 500, color: 'var(--text)' }}>
            {rateParts.join(' · ')}
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 10.5, color: 'var(--text-secondary)' }}>
            {checkedAt && <span>{t('pricing_sheet.date.checked_at', { date: checkedAt })}</span>}
            {validUntil && <span>{t('pricing_sheet.date.valid_until', { date: validUntil.slice(0, 10) })}</span>}
            {sourceUrl.startsWith('https://') && (
              <button
                type="button"
                style={{
                  border: 'none',
                  background: 'transparent',
                  padding: 0,
                  color: 'var(--blue)',
                  cursor: 'pointer',
                  fontSize: 10.5,
                  fontWeight: 500,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 2,
                }}
                onClick={() =>
                  void openExternalUrl(sourceUrl).catch((e) =>
                    showToast(e instanceof Error ? e.message : String(e), true),
                  )
                }
              >
                <span>{t('pricing_sheet.source_link')}</span>
                <ExternalLink size={10} />
              </button>
            )}
          </div>
        </div>
      </div>
    );
  };

  return (
    <Modal open={open} onClose={onClose} maxWidth={650}>
      <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12, maxHeight: '85vh' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <div
              className="gb-icon-badge"
              style={{
                width: 32,
                height: 32,
                background: payload?.synced ? 'var(--success-soft)' : 'var(--blue-soft)',
                border: payload?.synced ? '0.5px solid var(--success-border)' : '0.5px solid var(--blue-border)',
                color: payload?.synced ? 'var(--success)' : 'var(--blue)',
              }}
            >
              {payload?.synced ? <CheckCircle2 size={16} /> : <DollarSign size={16} />}
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 16, fontWeight: 700 }}>{t('pricing_sheet.title')}</div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 1 }}>
                {payload?.error
                  ? t('pricing_sheet.check_hint', { error: payload.error })
                  : healedRecords > 0
                  ? t('pricing_sheet.healed_sub', { count: healedRecords })
                  : payload?.synced
                  ? t('pricing_sheet.synced')
                  : t('pricing_sheet.note')}
              </div>
            </div>
          </div>
          <span className="gb-pill gb-pill-blue">
            {version
              ? t('pricing_sheet.pill.version_count', { version, count: modelCount })
              : t('pricing_sheet.pill.active_count', { count: modelCount })}
          </span>
        </div>

        {/* Scrollable Model Pricing List */}
        <div
          className="gb-card"
          style={{
            flex: 1,
            minHeight: 280,
            overflowY: 'auto',
            padding: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          {unpricedLive.length > 0 && (
            <div
              style={{
                padding: '9px 11px',
                borderRadius: 9,
                background: 'var(--warning-soft)',
                border: '0.5px solid var(--warning-border)',
                fontSize: 11.5,
                color: 'var(--warning)',
              }}
            >
              {t('pricing_sheet.unpriced_summary_banner', { count: unpricedLive.length })}
            </div>
          )}

          {sortedCurrent.length > 0 && (
            <>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', paddingTop: 2 }}>
                {t('pricing_sheet.section.current')}
              </div>
              {sortedCurrent.map((k) => renderRateCard(k))}
            </>
          )}

          {unpricedLive.map((m) => (
            <div
              key={m.key}
              className="gb-subcard"
              style={{ padding: '9px 12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}
            >
              <div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{m.displayName || m.key}</div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
                  {t('pricing_sheet.unpriced_live_desc')}
                </div>
              </div>
              <span className="gb-pill gb-pill-warning">
                {m.disabled
                  ? t('pricing_sheet.availability.unpriced_locked')
                  : t('pricing_sheet.availability.unpriced_live')}
              </span>
            </div>
          ))}

          {sortedOther.length > 0 && (
            <>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', paddingTop: 6 }}>
                {t('pricing_sheet.section.other_tier')}
              </div>
              {sortedOther.map((k) => renderRateCard(k))}
            </>
          )}

          {sortedRetired.length > 0 && (
            <div style={{ paddingTop: 6 }}>
              <button
                type="button"
                className="gb-btn gb-btn-ghost gb-btn-sm"
                style={{ paddingLeft: 4 }}
                onClick={() => setRetiredExpanded((v) => !v)}
              >
                <span>
                  {retiredExpanded
                    ? t('pricing_sheet.retired.toggle_expanded', { count: sortedRetired.length })
                    : t('pricing_sheet.retired.toggle_collapsed', { count: sortedRetired.length })}
                </span>
              </button>
              {retiredExpanded && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginTop: 6 }}>
                  {sortedRetired.map((k) => renderRateCard(k, true))}
                </div>
              )}
            </div>
          )}

          {allKeys.length === 0 && sortedRetired.length === 0 && unpricedLive.length === 0 && !checking && (
            <div style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: 36 }}>
              {t('pricing_sheet.empty')}
            </div>
          )}
        </div>

        <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{t('pricing_sheet.note')}</div>

        <div className="gb-divider" />

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="gb-btn" disabled={checking} onClick={handleRecheck}>
            <RotateCw size={12} className={checking ? 'gb-spin' : undefined} />
            <span>{t('pricing_sheet.recheck')}</span>
          </button>
          <button type="button" className="gb-btn gb-btn-primary" onClick={onClose}>
            {t('pricing_sheet.done')}
          </button>
        </div>
      </div>
    </Modal>
  );
}
