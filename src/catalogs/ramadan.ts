// Ramadan date ranges. Computed from the Umm al-Qura calendar via Intl (no hard-coded dates),
// with optional env overrides because the real start depends on moon sighting (+/- 1 day).

export interface DateRange {
  start: string; // YYYY-MM-DD
  end: string;
  source: "override" | "umalqura";
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

function hijriParts(d: Date): { month: number; day: number } {
  const fmt = new Intl.DateTimeFormat("en-u-ca-islamic-umalqura-nu-latn", { month: "numeric", day: "numeric", timeZone: "UTC" });
  const parts = fmt.formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { month: get("month"), day: get("day") };
}

/** First and last Gregorian day of Ramadan (hijri month 9) that falls in Gregorian `year`. */
export function computeRamadan(year: number): DateRange | null {
  let start: Date | null = null;
  let end: Date | null = null;
  for (let day = Date.UTC(year, 0, 1); day <= Date.UTC(year, 11, 31); day += 86_400_000) {
    const d = new Date(day);
    const { month } = hijriParts(d);
    if (month === 9) {
      start ??= d;
      end = d;
    }
  }
  return start && end ? { start: iso(start), end: iso(end), source: "umalqura" } : null;
}

export function ramadanRange(year: number, overrides?: { start?: string; end?: string }): DateRange | null {
  if (year === 2026 && overrides?.start && overrides?.end) return { start: overrides.start, end: overrides.end, source: "override" };
  return computeRamadan(year);
}

/**
 * Series that belong to a Ramadan season usually premiere on/just before day 1, so the discover query uses
 * first_air_date from `lead` days before the start to the end of the month.
 */
export function ramadanQueryWindow(range: DateRange, leadDays = 10): { gte: string; lte: string } {
  const gte = new Date(Date.parse(range.start) - leadDays * 86_400_000);
  return { gte: iso(gte), lte: range.end };
}
