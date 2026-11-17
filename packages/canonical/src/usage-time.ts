/**
 * Role: Timezone-aware date/week/month bucketing and time-window resolution for usage analytics.
 * Excludes model pricing and aggregation rollups (owned by usage-pricing.ts and usage.ts).
 */

import type { UsageTimePreset, UsageWeekMode } from "@cchistory/domain";

export interface LocalTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number; // 0 = Sun .. 6 = Sat
  dayKey: string; // YYYY-MM-DD
  monthKey: string; // YYYY-MM
}

export interface UsageTimeOptions {
  timezone?: string;
  week_mode?: UsageWeekMode;
  week_start_day?: number;
  week_reset_hour?: number;
  now_ms?: number;
}

const WEEKDAY_MAP: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();

export function resolveUsageTimezone(timezone?: string): string {
  const requested = timezone?.trim();
  const target = !requested || requested.toLowerCase() === "local"
    ? Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
    : requested.toUpperCase() === "UTC"
      ? "UTC"
      : requested;
  getDateFormatter(target); // validates IANA zone
  return target;
}

function getDateFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = FORMATTER_CACHE.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hourCycle: "h23",
    });
    FORMATTER_CACHE.set(timeZone, formatter);
  }
  return formatter;
}

export function extractLocalTimeParts(timestampMs: number, timeZone: string): LocalTimeParts {
  if (!Number.isFinite(timestampMs)) {
    return {
      year: 1970,
      month: 1,
      day: 1,
      hour: 0,
      minute: 0,
      weekday: 4,
      dayKey: "1970-01-01",
      monthKey: "1970-01",
    };
  }
  const parts = getDateFormatter(timeZone).formatToParts(new Date(timestampMs));
  let year = 1970;
  let month = 1;
  let day = 1;
  let hour = 0;
  let minute = 0;
  let weekday = 0;
  for (const part of parts) {
    if (part.type === "year") year = Number(part.value);
    else if (part.type === "month") month = Number(part.value);
    else if (part.type === "day") day = Number(part.value);
    else if (part.type === "hour") hour = Number(part.value) % 24;
    else if (part.type === "minute") minute = Number(part.value);
    else if (part.type === "weekday") weekday = WEEKDAY_MAP[part.value] ?? 0;
  }
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return {
    year,
    month,
    day,
    hour,
    minute,
    weekday,
    dayKey: `${year}-${mm}-${dd}`,
    monthKey: `${year}-${mm}`,
  };
}

export function localWallTimeToEpochMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  let estimate = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  for (let pass = 0; pass < 2; pass += 1) {
    const actual = extractLocalTimeParts(estimate, timeZone);
    const actualAsUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, 0, 0);
    const wantedAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
    const delta = actualAsUtc - wantedAsUtc;
    if (delta === 0) break;
    estimate -= delta;
  }
  return estimate;
}

export function resolveWeekBucket(
  timestampMs: number,
  options: {
    timeZone: string;
    weekMode: UsageWeekMode;
    weekStartDay?: number;
    weekResetHour?: number;
    nowMs: number;
  },
): { key: string; label: string } {
  const { timeZone, weekMode, nowMs } = options;
  if (weekMode === "rolling_7d") {
    const windowMs = 7 * 86_400_000;
    const offsetBuckets = Math.floor((nowMs - timestampMs) / windowMs);
    const endMs = nowMs - offsetBuckets * windowMs;
    const startMs = endMs - windowMs + 1;
    const startDay = extractLocalTimeParts(startMs, timeZone).dayKey;
    const endDay = extractLocalTimeParts(endMs, timeZone).dayKey;
    return {
      key: `${startDay}..${endDay}`,
      label: offsetBuckets === 0 ? `${startDay}..${endDay} (7d)` : `${startDay}..${endDay}`,
    };
  }

  if (weekMode === "custom_reset") {
    const startDay = options.weekStartDay ?? 1;
    const resetHour = options.weekResetHour ?? 0;
    const anchorMs = findLastResetBoundaryMs(timestampMs, timeZone, startDay, resetHour);
    const nextMs = anchorMs + 7 * 86_400_000 - 1;
    const startStr = extractLocalTimeParts(anchorMs, timeZone).dayKey;
    const endStr = extractLocalTimeParts(nextMs, timeZone).dayKey;
    return { key: `${startStr}..${endStr}`, label: `${startStr}..${endStr}` };
  }

  // iso_week: Monday 00:00 local time.
  const local = extractLocalTimeParts(timestampMs, timeZone);
  const mondayShift = (local.weekday + 6) % 7;
  const mondayEpoch = Date.UTC(local.year, local.month - 1, local.day - mondayShift);
  const sundayEpoch = Date.UTC(local.year, local.month - 1, local.day - mondayShift + 6);
  const mondayDate = new Date(mondayEpoch);
  const sundayDate = new Date(sundayEpoch);
  const { isoYear, isoWeek } = computeIsoWeek(mondayDate);
  const key = `${isoYear}-W${String(isoWeek).padStart(2, "0")}`;
  const startLabel = formatUtcDate(mondayDate).slice(5);
  const endLabel = formatUtcDate(sundayDate).slice(5);
  return { key, label: `${key} (${startLabel}..${endLabel})` };
}

export function resolveTimeWindowBounds(
  preset: UsageTimePreset,
  options: UsageTimeOptions = {},
): { after_ts?: number; before_ts?: number; after_date?: string; before_date?: string } {
  if (preset === "all") return {};
  const timeZone = resolveUsageTimezone(options.timezone);
  const nowMs = options.now_ms ?? Date.now();
  const localNow = extractLocalTimeParts(nowMs, timeZone);

  if (preset === "today") {
    return {
      after_ts: localWallTimeToEpochMs(localNow.year, localNow.month, localNow.day, 0, 0, timeZone),
      before_ts: nowMs,
      after_date: localNow.dayKey,
      before_date: localNow.dayKey,
    };
  }
  if (preset === "24h") {
    const afterTs = nowMs - 86_400_000;
    return {
      after_ts: afterTs,
      before_ts: nowMs,
      after_date: extractLocalTimeParts(afterTs, timeZone).dayKey,
      before_date: localNow.dayKey,
    };
  }
  if (preset === "7d") {
    const afterTs = nowMs - 7 * 86_400_000;
    return {
      after_ts: afterTs,
      before_ts: nowMs,
      after_date: extractLocalTimeParts(afterTs, timeZone).dayKey,
      before_date: localNow.dayKey,
    };
  }
  if (preset === "30d") {
    const afterTs = nowMs - 30 * 86_400_000;
    return {
      after_ts: afterTs,
      before_ts: nowMs,
      after_date: extractLocalTimeParts(afterTs, timeZone).dayKey,
      before_date: localNow.dayKey,
    };
  }
  if (preset === "week") {
    const weekMode = options.week_mode ?? "rolling_7d";
    if (weekMode === "rolling_7d") {
      const afterTs = nowMs - 7 * 86_400_000;
      return {
        after_ts: afterTs,
        before_ts: nowMs,
        after_date: extractLocalTimeParts(afterTs, timeZone).dayKey,
        before_date: localNow.dayKey,
      };
    }
    if (weekMode === "iso_week") {
      const mondayShift = (localNow.weekday + 6) % 7;
      const monday = new Date(Date.UTC(localNow.year, localNow.month - 1, localNow.day - mondayShift));
      const afterTs = localWallTimeToEpochMs(
        monday.getUTCFullYear(),
        monday.getUTCMonth() + 1,
        monday.getUTCDate(),
        0,
        0,
        timeZone,
      );
      return {
        after_ts: afterTs,
        before_ts: nowMs,
        after_date: formatUtcDate(monday),
        before_date: localNow.dayKey,
      };
    }
    const afterTs = findLastResetBoundaryMs(
      nowMs,
      timeZone,
      options.week_start_day ?? 1,
      options.week_reset_hour ?? 0,
    );
    return {
      after_ts: afterTs,
      before_ts: nowMs,
      after_date: extractLocalTimeParts(afterTs, timeZone).dayKey,
      before_date: localNow.dayKey,
    };
  }

  // month: 1st of current local month 00:00
  const afterTs = localWallTimeToEpochMs(localNow.year, localNow.month, 1, 0, 0, timeZone);
  return {
    after_ts: afterTs,
    before_ts: nowMs,
    after_date: `${localNow.monthKey}-01`,
    before_date: localNow.dayKey,
  };
}

export function parseDateOrRelativeStart(
  raw: string,
  options: UsageTimeOptions = {},
): { after_ts?: number; after_date?: string; before_ts?: number; before_date?: string; preset?: UsageTimePreset } {
  const value = raw.trim().toLowerCase();
  if (
    value === "all" ||
    value === "today" ||
    value === "24h" ||
    value === "7d" ||
    value === "30d" ||
    value === "week" ||
    value === "month"
  ) {
    return { ...resolveTimeWindowBounds(value, options), preset: value };
  }

  const relativeDaysMatch = /^(\d+)d$/u.exec(value);
  if (relativeDaysMatch) {
    const days = Number(relativeDaysMatch[1]);
    if (days >= 1 && Number.isSafeInteger(days)) {
      const timeZone = resolveUsageTimezone(options.timezone);
      const nowMs = options.now_ms ?? Date.now();
      const afterTs = nowMs - days * 86_400_000;
      return {
        after_ts: afterTs,
        before_ts: nowMs,
        after_date: extractLocalTimeParts(afterTs, timeZone).dayKey,
        before_date: extractLocalTimeParts(nowMs, timeZone).dayKey,
      };
    }
  }

  const relativeHoursMatch = /^(\d+)h$/u.exec(value);
  if (relativeHoursMatch) {
    const hours = Number(relativeHoursMatch[1]);
    if (hours >= 1 && Number.isSafeInteger(hours)) {
      const timeZone = resolveUsageTimezone(options.timezone);
      const nowMs = options.now_ms ?? Date.now();
      const afterTs = nowMs - hours * 3_600_000;
      return {
        after_ts: afterTs,
        before_ts: nowMs,
        after_date: extractLocalTimeParts(afterTs, timeZone).dayKey,
        before_date: extractLocalTimeParts(nowMs, timeZone).dayKey,
      };
    }
  }

  if (/^\d{4}-\d{2}-\d{2}$/u.test(raw.trim())) {
    const timeZone = resolveUsageTimezone(options.timezone);
    const [year, month, day] = raw.trim().split("-").map(Number) as [number, number, number];
    return {
      after_date: raw.trim(),
      after_ts: localWallTimeToEpochMs(year, month, day, 0, 0, timeZone),
    };
  }

  const parsedMs = Date.parse(raw.trim());
  if (Number.isFinite(parsedMs)) {
    const timeZone = resolveUsageTimezone(options.timezone);
    return {
      after_ts: parsedMs,
      after_date: extractLocalTimeParts(parsedMs, timeZone).dayKey,
    };
  }

  throw new Error(`Invalid time boundary: ${JSON.stringify(raw)}. Expected today|24h|7d|30d|week|month|Nd|Nh|YYYY-MM-DD|ISO.`);
}

export function parseDateEnd(raw: string, options: UsageTimeOptions = {}): { before_ts: number; before_date: string } {
  const trimmed = raw.trim();
  const timeZone = resolveUsageTimezone(options.timezone);
  if (/^\d{4}-\d{2}-\d{2}$/u.test(trimmed)) {
    const [year, month, day] = trimmed.split("-").map(Number) as [number, number, number];
    const nextMidnight = localWallTimeToEpochMs(year, month, day + 1, 0, 0, timeZone);
    return {
      before_ts: nextMidnight - 1,
      before_date: trimmed,
    };
  }
  const parsedMs = Date.parse(trimmed);
  if (Number.isFinite(parsedMs)) {
    return {
      before_ts: parsedMs,
      before_date: extractLocalTimeParts(parsedMs, timeZone).dayKey,
    };
  }
  throw new Error(`Invalid end date/time: ${JSON.stringify(raw)}. Expected YYYY-MM-DD or ISO timestamp.`);
}

function findLastResetBoundaryMs(
  targetMs: number,
  timeZone: string,
  weekStartDay: number,
  weekResetHour: number,
): number {
  const local = extractLocalTimeParts(targetMs, timeZone);
  const daysSinceResetDay = (local.weekday - weekStartDay + 7) % 7;
  let candidateDate = new Date(Date.UTC(local.year, local.month - 1, local.day - daysSinceResetDay));
  let boundaryMs = localWallTimeToEpochMs(
    candidateDate.getUTCFullYear(),
    candidateDate.getUTCMonth() + 1,
    candidateDate.getUTCDate(),
    weekResetHour,
    0,
    timeZone,
  );
  if (boundaryMs > targetMs) {
    candidateDate = new Date(Date.UTC(local.year, local.month - 1, local.day - daysSinceResetDay - 7));
    boundaryMs = localWallTimeToEpochMs(
      candidateDate.getUTCFullYear(),
      candidateDate.getUTCMonth() + 1,
      candidateDate.getUTCDate(),
      weekResetHour,
      0,
      timeZone,
    );
  }
  return boundaryMs;
}

function computeIsoWeek(localMondayDate: Date): { isoYear: number; isoWeek: number } {
  const thursday = new Date(Date.UTC(
    localMondayDate.getUTCFullYear(),
    localMondayDate.getUTCMonth(),
    localMondayDate.getUTCDate() + 3,
  ));
  const isoYear = thursday.getUTCFullYear();
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Weekday = (jan4.getUTCDay() + 6) % 7;
  const week1Monday = Date.UTC(isoYear, 0, 4 - jan4Weekday);
  const isoWeek = Math.floor((localMondayDate.getTime() - week1Monday) / (7 * 86_400_000)) + 1;
  return { isoYear, isoWeek };
}

function formatUtcDate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
