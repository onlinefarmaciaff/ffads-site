// Ряды для графика динамики: дни, недели (с понедельника) или месяцы.
// rows: [{ date, platform, spend, revenue, conversions, impressions, clicks }] по дням.
import { addDays, dateRange, diffDays, parseIsoDate } from './dates.js';

export const GRANULARITIES = ['day', 'week', 'month'];
const SUMS = ['spend', 'revenue', 'conversions', 'impressions', 'clicks'];

// Шаг по длине периода: до 62 дней — дни, до 186 — недели, дальше — месяцы.
export function autoGranularity(from, to) {
  const days = diffDays(from, to) + 1;
  if (days <= 62) return 'day';
  if (days <= 186) return 'week';
  return 'month';
}

export function bucketOf(iso, granularity) {
  if (granularity === 'month') return `${iso.slice(0, 7)}-01`;
  if (granularity === 'week') {
    const dow = (new Date(parseIsoDate(iso)).getUTCDay() + 6) % 7; // 0 — понедельник
    return addDays(iso, -dow);
  }
  return iso;
}

export function bucketize(from, to, rows, granularity) {
  const buckets = [...new Set(dateRange(from, to).map((d) => bucketOf(d, granularity)))];
  if (granularity === 'day') return { granularity, dates: buckets, rows };
  const acc = new Map();
  for (const r of rows) {
    const key = `${bucketOf(r.date, granularity)}|${r.platform}`;
    let a = acc.get(key);
    if (!a) {
      a = { date: bucketOf(r.date, granularity), platform: r.platform };
      for (const k of SUMS) a[k] = 0;
      acc.set(key, a);
    }
    for (const k of SUMS) a[k] += r[k] ?? 0;
  }
  return { granularity, dates: buckets, rows: [...acc.values()] };
}
