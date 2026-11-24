export const THINKING_EFFORT_SUFFIX_RE =
  /(?:-(?:extra-high|extra-low|xhigh|extra|high|medium|low|minimal|max|thinking))+$/i;

export const THINKING_EFFORT_OR_LATEST_SUFFIX_RE =
  /(?:-(?:extra-high|extra-low|xhigh|extra|high|medium|low|minimal|max|thinking|latest))+$/i;

export const TIERED_OR_THINKING_EFFORT_SUFFIX_RE =
  /(?:-(?:tiered|extra-high|extra-low|xhigh|extra|high|medium|low|minimal|max|thinking))+$/i;

export type ThinkingEffortLevel =
  | 'minimal'
  | 'extra_low'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'
  | 'thinking';

const EFFORT_WORD_MAP: Readonly<Record<string, ThinkingEffortLevel>> = {
  minimal: 'minimal',
  extra_low: 'extra_low',
  extralow: 'extra_low',
  xlow: 'extra_low',
  x_low: 'extra_low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  x_high: 'xhigh',
  extra_high: 'xhigh',
  extrahigh: 'xhigh',
  extra: 'xhigh',
  max: 'max',
  thinking: 'thinking',
};

/** Normalize a raw thinking effort token or label suffix into a canonical ThinkingEffortLevel. */
export function normalizeThinkingEffort(raw: unknown): ThinkingEffortLevel | undefined {
  if (typeof raw !== 'string') return undefined;
  let text = raw.trim();
  if (!text) return undefined;
  const paren = text.match(/^[（(]\s*([^）)]+)\s*[）)]$/);
  if (paren?.[1]) text = paren[1].trim();
  const canonicalKey = text.toLowerCase().replace(/[\s-]+/g, '_').replace(/^_+|_+$/g, '');
  return Object.hasOwn(EFFORT_WORD_MAP, canonicalKey) ? EFFORT_WORD_MAP[canonicalKey] : undefined;
}

const TRAILING_PAREN_EFFORT_RE =
  /\s*[（(]\s*(extra[\s_-]*high|extra[\s_-]*low|x[\s_-]*high|x[\s_-]*low|extra|high|medium|low|minimal|thinking|max)\s*[）)]\s*$/i;
const TRAILING_SPACE_EFFORT_RE =
  /\s+(extra[\s_-]*high|extra[\s_-]*low|x[\s_-]*high|x[\s_-]*low|extra|high|medium|low|minimal|thinking|max)\s*$/i;
const TRAILING_HYPHEN_EFFORT_RE =
  /[-_](extra[-_]*high|extra[-_]*low|x[-_]*high|x[-_]*low|extra|high|medium|low|minimal|thinking|max)$/i;

function unwrapBalancedOrchestrator(text: string): string {
  const m = text.match(/^orchestrator\s*[（(]/i);
  if (!m) return text;
  const openIdx = m[0].length - 1;
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(' || ch === '（') depth += 1;
    else if (ch === ')' || ch === '）') {
      depth -= 1;
      if (depth === 0) {
        return i === text.length - 1 ? text.slice(openIdx + 1, i).trim() : text;
      }
    }
  }
  return text;
}

function collectLabelEfforts(rawLabel: string): ThinkingEffortLevel[] {
  let cur = rawLabel.trim().replace(/\s*[（(]\s*orchestrator\s*[）)]\s*$/i, '').trim();
  if (!cur) return [];
  const collected: ThinkingEffortLevel[] = [];
  for (let i = 0; i < 5; i++) {
    const parenMatch = cur.match(TRAILING_PAREN_EFFORT_RE);
    if (parenMatch?.[1]) {
      const norm = normalizeThinkingEffort(parenMatch[1]);
      if (norm) collected.push(norm);
      cur = cur.slice(0, cur.length - parenMatch[0].length).trim();
      continue;
    }
    const spaceMatch = cur.match(TRAILING_SPACE_EFFORT_RE);
    if (spaceMatch?.[1] && cur.length > spaceMatch[0].length) {
      const norm = normalizeThinkingEffort(spaceMatch[1]);
      if (norm) collected.push(norm);
      cur = cur.slice(0, cur.length - spaceMatch[0].length).trim();
      continue;
    }
    const unwrapped = unwrapBalancedOrchestrator(cur);
    if (unwrapped !== cur) {
      cur = unwrapped;
      continue;
    }
    break;
  }
  return collected;
}

function collectModelIdEfforts(rawModelId: string): ThinkingEffortLevel[] {
  const stripped = stripModelProviderPrefix(rawModelId)
    .replace(/(?:^|[-_])disabled$/i, '')
    .trim()
    .replace(/\s*[（(]\s*orchestrator\s*[）)]\s*$/i, '')
    .trim();
  if (!stripped) return [];
  const collected: ThinkingEffortLevel[] = [];
  let cur = stripped;
  for (let i = 0; i < 5; i++) {
    const parenOrSpace = cur.match(TRAILING_PAREN_EFFORT_RE) ?? cur.match(TRAILING_SPACE_EFFORT_RE);
    if (parenOrSpace?.[1] && cur.length > parenOrSpace[0].length) {
      const norm = normalizeThinkingEffort(parenOrSpace[1]);
      if (norm) collected.push(norm);
      cur = cur.slice(0, cur.length - parenOrSpace[0].length).trim();
      continue;
    }
    const hyphenMatch = cur.match(TRAILING_HYPHEN_EFFORT_RE);
    if (hyphenMatch?.[1] && cur.length > hyphenMatch[0].length) {
      const norm = normalizeThinkingEffort(hyphenMatch[1]);
      if (norm) collected.push(norm);
      cur = cur.slice(0, cur.length - hyphenMatch[0].length);
      continue;
    }
    const metaSuffix = cur.match(/[-_](?:tiered|latest)$/i);
    if (metaSuffix && cur.length > metaSuffix[0].length) {
      cur = cur.slice(0, cur.length - metaSuffix[0].length);
      continue;
    }
    const unwrapped = unwrapBalancedOrchestrator(cur);
    if (unwrapped !== cur) {
      cur = unwrapped;
      continue;
    }
    break;
  }
  return collected;
}

/**
 * Extract thinking effort from raw modelId suffixes and display label suffixes.
 * Prefers explicit specific effort levels (e.g. high, xhigh, medium) over generic 'thinking'.
 */
export function extractThinkingEffort(
  modelId?: string | null,
  label?: string | null
): ThinkingEffortLevel | undefined {
  const idEfforts = typeof modelId === 'string' && modelId.trim() ? collectModelIdEfforts(modelId) : [];
  const labelEfforts = typeof label === 'string' && label.trim() ? collectLabelEfforts(label) : [];
  const specificId = idEfforts.find((e) => e !== 'thinking');
  if (specificId) return specificId;
  const specificLabel = labelEfforts.find((e) => e !== 'thinking');
  if (specificLabel) return specificLabel;
  if (idEfforts.includes('thinking') || labelEfforts.includes('thinking')) {
    return 'thinking';
  }
  return undefined;
}

/** Strip Vertex AI / GCP / Cloud publisher prefixes and RPC method suffixes while preserving case. */
export function stripModelProviderPrefix(name: string): string {
  return name.trim()
    .replace(/^(?:projects\/[^/]+\/locations\/[^/]+\/)?(?:publishers\/[^/]+\/)?models\//i, '')
    .replace(/^publishers\/[^/]+\/models\//i, '')
    .replace(/^(?:vertex_ai|google|anthropic|openai)\//i, '')
    .replace(/^models\//i, '')
    .replace(/:(?:predict|generateContent|streamGenerateContent)$/i, '');
}

/** Normalize spelling only; this does not authorize a model to inherit a price. */
export function normalizeModelId(name: string): string {
  return stripModelProviderPrefix(name)
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '')
    .replace(/^claude-(opus|sonnet|haiku)-3\.([57])\b/, 'claude-3-$2-$1')
    .replace(/^claude-((?!thinking|preview|trial|latest|high|medium|low|max|minimal|xhigh|extra|tiered|fast|batch|exp)[a-z]{3,16})-(\d+)\.(\d+)/, 'claude-$1-$2-$3')
    .replace(/^claude-3\.([57])-(sonnet|haiku)/, 'claude-3-$1-$2')
    .replace(/^claude-(3)-(5|7)-(sonnet|haiku)/, 'claude-$1-$2-$3')
    .replace(/^claude-([4-9]|[1-9]\d+)\.(\d+)-((?!thinking|preview|trial|latest|high|medium|low|max|minimal|xhigh|extra|tiered|fast|batch|exp)[a-z]{3,16})/, 'claude-$3-$1-$2')
    .replace(/^claude-3\.([57])-/, 'claude-3-$1-');
}
