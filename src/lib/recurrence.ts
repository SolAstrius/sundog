/**
 * Human-readable rendering of JSCalendar recurrence (RFC 8984 §4.3): recurrenceRules,
 * excludedRecurrenceRules, and RDATE-style override-only series.
 */

export interface RecRule {
  frequency?: string;
  interval?: number;
  rscale?: string;
  skip?: string;
  byDay?: { day?: string; nthOfPeriod?: number }[];
  byMonthDay?: number[];
  byMonth?: string[];
  byYearDay?: number[];
  byWeekNo?: number[];
  byHour?: number[];
  byMinute?: number[];
  bySetPosition?: number[];
  count?: number;
  until?: string;
  [key: string]: unknown;
}

const DAY_NAMES: Record<string, string> = {
  mo: "Mon",
  tu: "Tue",
  we: "Wed",
  th: "Thu",
  fr: "Fri",
  sa: "Sat",
  su: "Sun",
};

const FREQ_UNIT: Record<string, [string, string]> = {
  yearly: ["year", "years"],
  monthly: ["month", "months"],
  weekly: ["week", "weeks"],
  daily: ["day", "days"],
  hourly: ["hour", "hours"],
  minutely: ["minute", "minutes"],
  secondly: ["second", "seconds"],
};

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function ordinal(n: number): string {
  if (n === -1) return "last";
  if (n === -2) return "2nd-to-last";
  if (n < 0) return `${-n}th-to-last`;
  const suffix = n % 100 >= 11 && n % 100 <= 13
    ? "th"
    : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${suffix}`;
}

function list(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} & ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} & ${items[items.length - 1]}`;
}

function fmtUntil(until: string): string {
  const dayPart = until.split("T")[0];
  const [y, m, d] = dayPart.split("-").map(Number);
  if (!y || !m || !d) return until;
  return `${MONTH_NAMES[m - 1]?.slice(0, 3)} ${d}, ${y}`;
}

/** One rule → one English sentence fragment. */
export function describeRule(rule: RecRule): string {
  const freq = rule.frequency ?? "yearly";
  const interval = rule.interval ?? 1;
  const [one, many] = FREQ_UNIT[freq] ?? [freq, freq];
  const gregorian = !rule.rscale || rule.rscale === "gregorian";

  let out = interval === 1
    ? { yearly: "Every year", monthly: "Every month", weekly: "Every week", daily: "Every day" }[
      freq
    ] ?? `Every ${one}`
    : `Every ${interval} ${many}`;

  if (rule.byDay?.length) {
    const days = rule.byDay.map((nd) => {
      const name = DAY_NAMES[nd.day ?? ""] ?? nd.day ?? "?";
      return nd.nthOfPeriod ? `the ${ordinal(nd.nthOfPeriod)} ${name}` : name;
    });
    out += ` on ${list(days)}`;
  }
  if (rule.byMonthDay?.length) {
    out += ` on day ${list(rule.byMonthDay.map((d) => (d < 0 ? `${ordinal(d)}` : String(d))))}`;
  }
  if (rule.byMonth?.length) {
    const names = rule.byMonth.map((m) => {
      const leap = m.endsWith("L");
      const num = parseInt(m, 10);
      const base = gregorian ? (MONTH_NAMES[num - 1] ?? `month ${num}`) : `month ${num}`;
      return leap ? `${base} (leap)` : base;
    });
    out += ` in ${list(names)}`;
  }
  if (rule.byWeekNo?.length) out += ` in week ${list(rule.byWeekNo.map(String))}`;
  if (rule.byYearDay?.length) out += ` on year-day ${list(rule.byYearDay.map(String))}`;
  if (rule.bySetPosition?.length) {
    out += `, keeping the ${list(rule.bySetPosition.map(ordinal))} match`;
  }
  if (rule.byHour?.length) {
    const mins = rule.byMinute?.length ? rule.byMinute : [0];
    const times = rule.byHour.flatMap((h) =>
      mins.map((m) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`)
    );
    out += ` at ${list(times)}`;
  }
  if (rule.count !== undefined) out += `, ${rule.count} times`;
  if (rule.until) out += `, until ${fmtUntil(rule.until)}`;
  if (!gregorian) out += ` (${rule.rscale} calendar)`;
  if (rule.skip && rule.skip !== "omit") {
    out += `, rolling ${rule.skip} over missing dates`;
  }
  return out;
}

/**
 * Whole-series description: rules + exclusions, or an RDATE-style "N selected dates" series
 * when only overrides exist.
 */
export function describeRecurrence(
  rules: RecRule[] | undefined,
  excludedRules: RecRule[] | undefined,
  overrides: Record<string, Record<string, unknown>> | undefined,
): string[] {
  const lines: string[] = [];
  for (const rule of rules ?? []) lines.push(describeRule(rule));
  for (const rule of excludedRules ?? []) lines.push(`Except ${describeRule(rule).toLowerCase()}`);
  if (lines.length === 0 && overrides) {
    const keys = Object.keys(overrides);
    const included = keys.filter((k) => overrides[k]?.excluded !== true);
    if (included.length) lines.push(`On ${included.length} selected dates`);
  } else if (overrides) {
    const excluded = Object.values(overrides).filter((p) => p?.excluded === true).length;
    if (excluded) lines.push(`${excluded} occurrence${excluded === 1 ? "" : "s"} cancelled`);
  }
  return lines;
}
