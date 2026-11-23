import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Modal } from '../components/Modal';
import { useApp } from '../context/AppContext';
import { backendRequest } from '../lib/tauri';
import { monitoredScopeChoices, monitoredScopeSubtitle } from '../lib/quota';

export function AccountPolicyModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { t, locale, autoSwitchConfig, fetchAutoSwitch, showToast } = useApp();
  const [strategy, setStrategy] = useState('priority');
  const [monitoredModel, setMonitoredModel] = useState('all');
  const [reserve, setReserve] = useState('10');
  const [candidateMin, setCandidateMin] = useState('30');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setStrategy(autoSwitchConfig.strategy || 'priority');
      setMonitoredModel(autoSwitchConfig.monitored_model || 'all');
      setReserve(String(autoSwitchConfig.reserve_percentage ?? 10));
      setCandidateMin(String(autoSwitchConfig.candidate_min_percentage ?? 30));
      setError('');
    }
  }, [open, autoSwitchConfig]);

  const choices = monitoredScopeChoices(locale);

  const handleSave = async () => {
    const low = Number.parseInt(reserve.trim(), 10);
    if (!Number.isInteger(low) || low < 1 || low > 98) {
      setError(t('policy.error.reserve_range'));
      return;
    }
    const min = Number.parseInt(candidateMin.trim(), 10);
    if (!Number.isInteger(min) || min < 2 || min > 100) {
      setError(t('policy.error.candidate_range'));
      return;
    }
    if (min <= low) {
      setError(t('policy.error.candidate_le_reserve'));
      return;
    }
    setError('');
    setSaving(true);
    try {
      await backendRequest({
        command: 'auto_switch_set',
        config: {
          reserve_percentage: low,
          candidate_min_percentage: min,
          strategy,
          monitored_model: monitoredModel,
        },
      });
      await fetchAutoSwitch();
      showToast(t('common.save'));
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} maxWidth={520}>
      <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
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
            <RefreshCw size={15} />
          </div>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>{t('policy.title')}</h3>
        </div>

        <div className="gb-card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600 }}>{t('policy.row.strategy.title')}</div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
                {t('policy.row.strategy.sub')}
              </div>
            </div>
            <select
              className="gb-select"
              style={{ width: 176 }}
              value={strategy}
              onChange={(e) => setStrategy(e.target.value)}
            >
              <option value="priority">{t('policy.strategy.priority')}</option>
              <option value="round_robin">{t('policy.strategy.round_robin')}</option>
            </select>
          </div>

          <div className="gb-divider" />

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600 }}>{t('policy.row.monitored.title')}</div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
                {monitoredScopeSubtitle(monitoredModel, locale)}
              </div>
            </div>
            <select
              className="gb-select"
              style={{ width: 176 }}
              value={monitoredModel}
              onChange={(e) => setMonitoredModel(e.target.value)}
            >
              {choices.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.title}
                </option>
              ))}
            </select>
          </div>

          <div className="gb-divider" />

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600 }}>{t('policy.row.reserve.title')}</div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
                {t('policy.row.reserve.sub')}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                type="number"
                min={1}
                max={98}
                className="gb-input tabular"
                style={{ width: 68, textAlign: 'center' }}
                value={reserve}
                onChange={(e) => setReserve(e.target.value)}
              />
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>%</span>
            </div>
          </div>

          <div className="gb-divider" />

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600 }}>{t('policy.row.candidate.title')}</div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
                {t('policy.row.candidate.sub')}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                type="number"
                min={2}
                max={100}
                className="gb-input tabular"
                style={{ width: 68, textAlign: 'center' }}
                value={candidateMin}
                onChange={(e) => setCandidateMin(e.target.value)}
              />
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>%</span>
            </div>
          </div>
        </div>

        <div className="gb-divider" />

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <div style={{ fontSize: 11.5, color: 'var(--danger)', flex: 1 }}>{error}</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="gb-btn" onClick={onClose}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="gb-btn gb-btn-primary"
              disabled={saving}
              onClick={handleSave}
            >
              {t('common.save')}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
