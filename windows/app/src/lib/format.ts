import modelCatalogJson from '@root-assets/model-catalog.json';
import type { ModelUsageRaw } from './types';
import { translate, type ResolvedLocale } from './i18n';

const CATALOG_NAMES: Record<string, string> =
  ((modelCatalogJson as { names?: Record<string, string> })?.names) ?? {};

const STANDALONE_GEMINI_RE = /^gemini-((?:3\.[5-9]|[4-9](?:\.[0-9]+)?))-([a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/i;
const THINKING_SUFFIX_RE = /(?:-(?:tiered|extra-high|extra-low|xhigh|extra|high|medium|low|minimal|thinking|max))+$/i;

const EFFORT_SET = new Set([
  'high', 'medium', 'low', 'extra low', 'extra-low',
  'xhigh', 'extra', 'extra high', 'extra-high',
  'minimal', 'max',
]);

function formatStandaloneGemini(stripped: string): string | null {
  const m = STANDALONE_GEMINI_RE.exec(stripped);
  if (!m) return null;
  const ver = m[1];
  const code = m[2]
    .split('-')
    .map((s) => (s ? s[0].toUpperCase() + s.slice(1) : s))
    .join(' ');
  return `Gemini ${ver} ${code}`;
}

export function modelDisplayName(identifier: string): string {
  const trimmed = identifier.trim();
  if (!trimmed) return identifier;
  const lower = trimmed.toLowerCase();
  if (CATALOG_NAMES[lower]) return CATALOG_NAMES[lower];
  if (lower.startsWith('google/') && CATALOG_NAMES[lower.slice(7)]) {
    return CATALOG_NAMES[lower.slice(7)];
  }

  for (const [open, close] of [[' (', ')'], ['（', '）'], ['(', ')']] as const) {
    if (trimmed.endsWith(close)) {
      const idx = trimmed.lastIndexOf(open);
      if (idx > 0) {
        const baseRaw = trimmed.slice(0, idx).trim();
        const innerRaw = trimmed.slice(idx + open.length, -close.length).trim();
        if (baseRaw && innerRaw) {
          const baseDisplay = CATALOG_NAMES[baseRaw.toLowerCase()] ?? baseRaw;
          if (EFFORT_SET.has(innerRaw.toLowerCase())) return baseDisplay;
          return `${baseDisplay} ${innerRaw}`;
        }
      }
    }
  }

  const suffixTable: Array<[string, string | null]> = [
    ['-extra-high-thinking', 'Thinking'],
    ['-extra-low-thinking', 'Thinking'],
    ['-xhigh-thinking', 'Thinking'],
    ['-extra-thinking', 'Thinking'],
    ['-high-thinking', 'Thinking'],
    ['-medium-thinking', 'Thinking'],
    ['-low-thinking', 'Thinking'],
    ['-minimal-thinking', 'Thinking'],
    ['-max-thinking', 'Thinking'],
    ['-thinking', 'Thinking'],
    ['-extra', null],
    ['-preview', 'Preview'],
  ];
  const stripped = lower.startsWith('google/') ? lower.slice(7) : lower;
  for (const [suffix, label] of suffixTable) {
    if (stripped.endsWith(suffix)) {
      const baseKey = stripped.slice(0, -suffix.length);
      const baseName = CATALOG_NAMES[baseKey] ?? formatStandaloneGemini(baseKey);
      if (baseName) return label ? `${baseName} ${label}` : baseName;
    }
  }

  const standalone = formatStandaloneGemini(stripped);
  if (standalone) return standalone;
  return trimmed;
}

export function localizedModelLabel(raw: string | undefined | null, locale: ResolvedLocale): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed || trimmed === '未知模型' || trimmed.toLowerCase() === 'unknown model') {
    return translate(locale, 'menu_panel.unknown_model');
  }
  return trimmed;
}

export function inferredBrands(title: string): Array<'gemini' | 'claude' | 'openai'> {
  const lower = title.toLowerCase();
  if (lower.includes('claude') && (lower.includes('gpt') || lower.includes('openai'))) {
    return ['claude', 'openai'];
  }
  if (
    lower.includes('gemini') ||
    lower.includes('orchestrator') ||
    lower.includes('argon') ||
    lower.includes('carbon') ||
    lower.includes('neon') ||
    lower.includes('hydrogen')
  ) {
    return ['gemini'];
  }
  if (lower.includes('claude')) return ['claude'];
  if (lower.includes('gpt') || lower.includes('openai') || /(?:^|\b)o[1-9](?:$|[-_\s])/.test(lower)) {
    return ['openai'];
  }
  return [];
}

export function formatInteger(value: number, locale: ResolvedLocale): string {
  const n = Number.isFinite(value) ? Math.round(value) : 0;
  return new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'zh-CN').format(n);
}

export function formatCompactTokens(count: number, locale: ResolvedLocale, formatSmallWithLocale = false): string {
  const value = Math.max(0, Math.round(Number.isFinite(count) ? count : 0));
  if (value < 1000) {
    return formatSmallWithLocale ? formatInteger(value, locale) : String(value);
  }
  const scale = Math.pow(10, Math.floor(Math.log10(value)) - 2);
  const rounded = Math.round(value / scale) * scale;
  const divisor = rounded >= 1e9 ? 1e9 : rounded >= 1e6 ? 1e6 : 1e3;
  const unit = divisor === 1e9 ? 'B' : divisor === 1e6 ? 'M' : 'K';
  const scaled = rounded / divisor;
  const decimals = Math.max(0, 2 - Math.floor(Math.log10(scaled)));
  let num = scaled.toFixed(decimals);
  if (num.includes('.')) {
    num = num.replace(/0+$/, '').replace(/\.$/, '');
  }
  return num + unit;
}

export function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '$0.00';
  if (value < 0.001) return '<$0.001';
  if (value < 0.01) return `$${value.toFixed(3)}`;
  if (value >= 1000) {
    return '$' + new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
  }
  return `$${value.toFixed(2)}`;
}

export function formatBytes(bytes: number): string {
  const b = Math.max(0, Number.isFinite(bytes) ? bytes : 0);
  if (b === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let val = b;
  let idx = 0;
  while (val >= 1000 && idx < units.length - 1) {
    val /= 1000;
    idx++;
  }
  const decimals = idx === 0 ? 0 : val >= 100 ? 0 : val >= 10 ? 1 : 2;
  const s = val.toFixed(decimals).replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1');
  return `${s} ${units[idx]}`;
}

export function formatShortDateTime(timestampSecOrMs: number | Date): string {
  const d = timestampSecOrMs instanceof Date
    ? timestampSecOrMs
    : new Date(timestampSecOrMs < 1e11 ? timestampSecOrMs * 1000 : timestampSecOrMs);
  if (Number.isNaN(d.getTime())) return '';
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${min}`;
}

export function formatShortTime(timestampSecOrMs: number | Date): string {
  const d = timestampSecOrMs instanceof Date
    ? timestampSecOrMs
    : new Date(timestampSecOrMs < 1e11 ? timestampSecOrMs * 1000 : timestampSecOrMs);
  if (Number.isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${min}`;
}

export function accountDisplayName(name: string | undefined | null, email: string | undefined | null, locale: ResolvedLocale): string {
  const cleanName = (name ?? '').trim();
  if (cleanName) return cleanName;
  const cleanEmail = (email ?? '').trim();
  if (cleanEmail) {
    const at = cleanEmail.indexOf('@');
    if (at > 0) return cleanEmail.slice(0, at);
    return cleanEmail;
  }
  return translate(locale, 'accounts.unnamed');
}

export function normalizeTier(raw: string | undefined | null, locale: ResolvedLocale): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return '';
  const upper = trimmed.toUpperCase();
  if (['FREE', 'PRO', 'ULTRA', 'ENTERPRISE', 'TEAM', 'PLUS'].includes(upper)) return upper;
  if (trimmed === '待确认' || upper === 'PENDING') {
    return translate(locale, 'overview.tier_pending');
  }
  return upper;
}

export function localizeCountdown(raw: string, locale: ResolvedLocale): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (locale === 'en') {
    if (trimmed === '即将重置') return translate(locale, 'quota.countdown.soon');
    if (trimmed === '已过' || trimmed === '重置时间已过') return translate(locale, 'quota.countdown.passed');
    const re = /([0-9]+)\s*(天|小时|分钟|分|秒)/g;
    const parts: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(trimmed)) !== null) {
      const unitMap: Record<string, string> = { 天: 'd', 小时: 'h', 分钟: 'm', 分: 'm', 秒: 's' };
      parts.push(`${m[1]}${unitMap[m[2]] ?? m[2]}`);
    }
    if (parts.length > 0) {
      const dur = parts.join(' ');
      return trimmed.includes('后重置') ? translate(locale, 'quota.countdown.resets_in', { duration: dur }) : dur;
    }
    return trimmed;
  }
  if (/resetting soon/i.test(trimmed)) return translate(locale, 'quota.countdown.soon');
  if (/^passed$/i.test(trimmed) || /time passed/i.test(trimmed)) return translate(locale, 'quota.countdown.passed');
  if (!/[天小时分钟秒]/.test(trimmed)) {
    const enRe = /([0-9]+)\s*(d|h|m|s)\b/gi;
    const parts: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = enRe.exec(trimmed)) !== null) {
      const unitMap: Record<string, string> = { d: '天', h: '小时', m: '分钟', s: '秒' };
      parts.push(`${m[1]} ${unitMap[m[2].toLowerCase()] ?? m[2]}`);
    }
    if (parts.length > 0) {
      const dur = parts.join(' ');
      return /reset/i.test(trimmed) ? translate(locale, 'quota.countdown.resets_in', { duration: dur }) : dur;
    }
  }
  return trimmed;
}

export function baseModelKey(rawModel: string): string {
  const trimmed = rawModel.trim();
  if (!trimmed || trimmed === '未知模型' || trimmed.toLowerCase() === 'unknown model') {
    return trimmed;
  }
  const stripped = trimmed.replace(THINKING_SUFFIX_RE, '').trim();
  return stripped || trimmed;
}

export interface FoldedModelUsage {
  model: string;
  modelId: string;
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
}

export function foldThinkingVariants(rows: ModelUsageRaw[]): FoldedModelUsage[] {
  const order: string[] = [];
  const map = new Map<string, {
    model: string;
    modelId: string;
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
    anyExpired: boolean;
    pricingStatus: string;
  }>();

  for (const item of rows) {
    const raw = (item.model ?? '').trim();
    const folded = baseModelKey(raw);
    const key = folded ? folded.toLowerCase() : `__empty__:${order.length}`;
    const total = Number(item.totalTokens ?? item.total_tokens ?? 0) || 0;
    const input = Number(item.promptTokens ?? item.input_tokens ?? 0) || 0;
    const output = Number(item.candidatesTokens ?? item.output_tokens ?? 0) || 0;
    const cached = Number(item.cachedTokens ?? item.cached_tokens ?? 0) || 0;
    const cacheWrite = Number(item.cacheWriteTokens ?? item.cache_write_tokens ?? 0) || 0;
    const req = Number(item.requestCount ?? item.request_count ?? 0) || 0;
    const usd = Number(item.estimatedUsd ?? item.estimated_usd ?? 0) || 0;
    const unpriced = Number(item.unpricedTokens ?? item.unpriced_tokens ?? 0) || 0;
    const itemPartial = item.partiallyPriced === true;
    const itemPriced = item.priced ?? (usd > 0 || (unpriced === 0 && total > 0 && item.priced === undefined));
    const effectivePriced = itemPriced || itemPartial;
    const status = String(item.pricingStatus ?? '');
    const itemExpired = status === 'expired';
    const rawId = String(item.modelId ?? item.model_id ?? raw);

    const existing = map.get(key);
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
      existing.anyExpired = existing.anyExpired || itemExpired;
      if (raw.toLowerCase() === folded.toLowerCase()) {
        existing.model = raw;
      }
      if ((!existing.pricingStatus || existing.pricingStatus === 'unpriced') && status && status !== 'unpriced') {
        existing.pricingStatus = status;
      }
    } else {
      order.push(key);
      map.set(key, {
        model: folded || raw,
        modelId: rawId || folded || raw,
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
        anyExpired: itemExpired,
        pricingStatus: status,
      });
    }
  }

  return order.map((k) => {
    const b = map.get(k)!;
    const partiallyPriced = b.anyPriced && (!b.allPriced || b.unpriced > 0);
    const priced = b.allPriced && b.unpriced === 0;
    return {
      model: b.model,
      modelId: b.modelId,
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
      pricingStatus: b.anyExpired ? 'expired' : b.pricingStatus,
    };
  });
}

export function sortModelsByUsage(rows: FoldedModelUsage[]): FoldedModelUsage[] {
  return [...rows].sort((a, b) => {
    if (a.totalTokens !== b.totalTokens) return b.totalTokens - a.totalTokens;
    if (Math.abs(a.estimatedUsd - b.estimatedUsd) > 1e-12) return b.estimatedUsd - a.estimatedUsd;
    return b.requestCount - a.requestCount;
  });
}

export function usageScopeText(
  scanned: number,
  discovered: number,
  failed: number,
  skipped: number,
  unknown: number,
  locale: ResolvedLocale,
): string {
  const parts: string[] = [
    discovered > scanned
      ? translate(locale, 'usage.scope.dbs_fraction', { scanned, discovered })
      : translate(locale, 'usage.scope.dbs_count', { scanned }),
  ];
  if (failed > 0) parts.push(translate(locale, 'usage.scope.failed_dbs', { count: failed }));
  if (skipped > 0) parts.push(translate(locale, 'usage.scope.skipped_records', { count: skipped }));
  if (unknown > 0) parts.push(translate(locale, 'usage.scope.unknown_time', { count: unknown }));
  return parts.join(' · ');
}

/**
 * Parse an hourly bucket index (0..23) from backend `todayHourly` rows.
 * Backend emits `hour: "YYYY-MM-DD HH:00"`, while tests/mocks may pass integer `hour` or `"00:00"`/`"00时"`.
 */
export function parseHourIndex(item: { hour?: number | string; label?: string }): number | null {
  if (typeof item.hour === 'number' && Number.isInteger(item.hour) && item.hour >= 0 && item.hour < 24) {
    return item.hour;
  }
  const raw = String(item.hour ?? item.label ?? '').trim();
  if (!raw) return null;
  const match = raw.match(/(?:^|[\sT])(\d{1,2})(?::\d{2}|时|h|$)/i);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isInteger(parsed) && parsed >= 0 && parsed < 24 ? parsed : null;
}
