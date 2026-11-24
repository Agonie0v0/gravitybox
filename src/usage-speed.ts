import { bt } from './i18n.js';
import type { CustomDateRange } from './usage-types.js';

export const OUTPUT_SPEED_WINDOW_SIZE = 10;
export const MAX_CUSTOM_DATE_RANGE_DAYS = 3660;

export interface OutputSpeedSampleInput {
  output_tokens: number;
  streaming_duration_seconds?: number;
  timestamp_seconds?: number;
}

export interface OutputSpeedSummary {
  median_output_tps: number | null;
  speed_sample_count: number;
}

/**
 * Compute per-event output speed (tokens/second) only when output_tokens > 0
 * and streaming_duration_seconds is a positive finite number.
 */
export function computeEventOutputTps(
  ev: Pick<OutputSpeedSampleInput, 'output_tokens' | 'streaming_duration_seconds'> | null | undefined
): number | null {
  if (!ev) return null;
  const out = ev.output_tokens;
  const dur = ev.streaming_duration_seconds;
  if (
    typeof out !== 'number' ||
    !Number.isFinite(out) ||
    out <= 0 ||
    typeof dur !== 'number' ||
    !Number.isFinite(dur) ||
    dur <= 0
  ) {
    return null;
  }
  const tps = out / dur;
  return Number.isFinite(tps) && tps > 0 ? tps : null;
}

interface TrackedSpeedSample {
  tps: number;
  timestamp_seconds: number;
  seq: number;
}

/**
 * Retains the latest `limit` (default 10) positive finite TPS samples ordered by
 * `(timestamp_seconds DESC, seq DESC)` and computes their 2-decimal rounded median.
 */
export class RecentSpeedTracker {
  private readonly limit: number;
  private readonly samples: TrackedSpeedSample[] = [];
  private nextSeq = 0;

  constructor(limit = OUTPUT_SPEED_WINDOW_SIZE) {
    this.limit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : OUTPUT_SPEED_WINDOW_SIZE;
  }

  add(ev: OutputSpeedSampleInput, explicitSeq?: number): boolean {
    if (this.limit <= 0) return false;
    const tps = computeEventOutputTps(ev);
    if (tps === null) return false;
    const rawTs = ev.timestamp_seconds ?? 0;
    if (typeof rawTs !== 'number' || !Number.isFinite(rawTs) || rawTs < 0) return false;
    const seq =
      typeof explicitSeq === 'number' && Number.isSafeInteger(explicitSeq) && explicitSeq >= 0
        ? explicitSeq
        : this.nextSeq++;
    if (seq >= this.nextSeq) {
      this.nextSeq = seq + 1;
    }

    const candidate: TrackedSpeedSample = { tps, timestamp_seconds: rawTs, seq };
    if (this.samples.length < this.limit) {
      this.samples.push(candidate);
      return true;
    }

    let minIdx = 0;
    for (let i = 1; i < this.samples.length; i++) {
      const cur = this.samples[i]!;
      const min = this.samples[minIdx]!;
      if (
        cur.timestamp_seconds < min.timestamp_seconds ||
        (cur.timestamp_seconds === min.timestamp_seconds && cur.seq < min.seq)
      ) {
        minIdx = i;
      }
    }
    const oldest = this.samples[minIdx]!;
    if (
      candidate.timestamp_seconds > oldest.timestamp_seconds ||
      (candidate.timestamp_seconds === oldest.timestamp_seconds && candidate.seq > oldest.seq)
    ) {
      this.samples[minIdx] = candidate;
      return true;
    }
    return false;
  }

  summary(): OutputSpeedSummary {
    const count = this.samples.length;
    if (count === 0) {
      return { median_output_tps: null, speed_sample_count: 0 };
    }
    const sorted = this.samples.map((s) => s.tps).sort((a, b) => a - b);
    const mid = Math.floor(count / 2);
    const rawMedian =
      count % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
    return {
      median_output_tps: Math.round(rawMedian * 100) / 100,
      speed_sample_count: count,
    };
  }
}

const ISO_LOCAL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseCalendarDateParts(
  raw: unknown,
  label: string
): { dateStr: string; year: number; month: number; day: number; midnightMs: number } {
  const text = typeof raw === 'string' ? raw.trim() : '';
  const match = text.match(ISO_LOCAL_DATE_RE);
  if (!match) {
    throw new Error(
      bt('usage.err.invalid_date_format', { field: label }, `Invalid ${label}: expected YYYY-MM-DD`)
    );
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const d = new Date(year, month - 1, day, 0, 0, 0, 0);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) {
    throw new Error(
      bt('usage.err.invalid_calendar_date', { date: text }, `Invalid calendar date: ${text}`)
    );
  }
  return { dateStr: text, year, month, day, midnightMs: d.getTime() };
}

/**
 * Validate a YYYY-MM-DD local calendar date range and return local midnight half-open bounds
 * `[startSec, endExclusiveSec)`.
 */
export function parseLocalDateRange(startDate: unknown, endDate: unknown): CustomDateRange {
  const start = parseCalendarDateParts(startDate, 'startDate');
  const end = parseCalendarDateParts(endDate, 'endDate');
  if (start.dateStr > end.dateStr) {
    throw new Error(
      bt(
        'usage.err.invalid_date_range',
        undefined,
        'Start date must be on or before end date'
      )
    );
  }
  const utcStart = Date.UTC(start.year, start.month - 1, start.day);
  const utcEnd = Date.UTC(end.year, end.month - 1, end.day);
  const dayCount = Math.round((utcEnd - utcStart) / 86_400_000) + 1;
  if (dayCount > MAX_CUSTOM_DATE_RANGE_DAYS) {
    throw new Error(
      bt(
        'usage.err.date_range_too_large',
        { max: MAX_CUSTOM_DATE_RANGE_DAYS },
        `Custom date range cannot exceed ${MAX_CUSTOM_DATE_RANGE_DAYS} days`
      )
    );
  }
  const endExclusiveDate = new Date(end.year, end.month - 1, end.day + 1, 0, 0, 0, 0);
  return {
    startDate: start.dateStr,
    endDate: end.dateStr,
    startSec: Math.floor(start.midnightMs / 1000),
    endExclusiveSec: Math.floor(endExclusiveDate.getTime() / 1000),
    isSingleDay: dayCount === 1,
    dayCount,
  };
}
