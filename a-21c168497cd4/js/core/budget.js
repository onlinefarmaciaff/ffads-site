// Освоение бюджета месяца: план, факт, «где должны быть сейчас», прогноз, статус.
//
// Для текущего месяца (сегодня — день N из D):
//   полные дни            = N − 1 (сегодняшний день ещё идёт)
//   факт                  = расход с 1-го числа по сегодня (включая неполный сегодняшний день)
//   средний дневной       = расход за 7 последних полных дней (сегодня−7 … вчера) / 7
//   оставшиеся дни        = D − полные дни (сегодня + дни до конца месяца)
//   прогноз               = расход за полные дни + средний дневной × оставшиеся дни
//   должны быть сейчас    = план × (полные дни + прошедшая доля сегодняшних суток) / D
//   остаток               = план − факт
//   допустимо в день      = (план − расход за полные дни) / оставшиеся дни, не меньше 0
// Статус по прогнозу к плану: < 90% — недоосвоение, 90–105% — в графике, > 105% — перерасход.
import { addDays, dateRange, daysInMonth, diffDays } from './dates.js';

export const UNDER_THRESHOLD = 0.9;
export const OVER_THRESHOLD = 1.05;

export function statusFor(value, plan) {
  if (!(plan > 0)) return 'no_plan';
  const pct = value / plan;
  if (pct > OVER_THRESHOLD) return 'over';
  if (pct < UNDER_THRESHOLD) return 'under';
  return 'on_track';
}

function sumWhere(daily, platform, from, to) {
  let s = 0;
  for (const r of daily) {
    if ((platform === null || r.platform === platform) && r.date >= from && r.date <= to) s += r.spend;
  }
  return s;
}

function pacingRow({ plan, daily, platform, ctx }) {
  const { mode, start, end, today, yesterday, D, fullDays, dayFraction } = ctx;
  if (mode === 'future') {
    return { plan, fact: 0, expected: 0, forecast: null, remaining: plan, allowedPerDay: plan / D,
      avg7: null, forecastPct: null, status: plan > 0 ? 'future' : 'no_plan' };
  }
  if (mode === 'past') {
    const fact = sumWhere(daily, platform, start, end);
    return { plan, fact, expected: plan, forecast: fact, remaining: plan - fact, allowedPerDay: null,
      avg7: null, forecastPct: plan > 0 ? fact / plan : null, status: statusFor(fact, plan) };
  }
  const fact = sumWhere(daily, platform, start, today);
  const factFull = fullDays > 0 ? sumWhere(daily, platform, start, yesterday) : 0;
  const avg7 = sumWhere(daily, platform, addDays(today, -7), yesterday) / 7;
  const remainingDays = D - fullDays;
  const forecast = factFull + avg7 * remainingDays;
  return {
    plan,
    fact,
    expected: (plan * (fullDays + dayFraction)) / D,
    forecast,
    remaining: plan - fact,
    allowedPerDay: Math.max(0, plan - factFull) / remainingDays,
    avg7,
    forecastPct: plan > 0 ? forecast / plan : null,
    status: statusFor(forecast, plan),
  };
}

// month: 'YYYY-MM'; today: 'YYYY-MM-DD'; minutes: минут с полуночи (Кишинёв);
// plans: { platform: сумма MDL }; daily: [{ date, platform, spend }] — расход в MDL
// за период от min(1-е число, сегодня−7) до конца месяца.
export function computePacing({ month, today, minutes = 0, plans, daily, platforms }) {
  const start = `${month}-01`;
  const D = daysInMonth(start);
  const end = addDays(start, D - 1);
  const mode = today < start ? 'future' : today > end ? 'past' : 'current';
  const fullDays = mode === 'current' ? diffDays(start, today) : mode === 'past' ? D : 0;
  const ctx = {
    mode, start, end, today, yesterday: addDays(today, -1), D, fullDays,
    dayFraction: Math.min(Math.max(minutes, 0), 1440) / 1440,
  };

  const rows = platforms.map((platform) => ({
    platform,
    ...pacingRow({ plan: plans[platform] ?? 0, daily, platform, ctx }),
  }));

  const totalPlan = rows.reduce((s, r) => s + r.plan, 0);
  const total = pacingRow({ plan: totalPlan, daily: daily.filter((r) => platforms.includes(r.platform)), platform: null, ctx });

  // Ряды для графика темпа: накопленный факт, равномерный план, прогноз.
  const dates = dateRange(start, end);
  const byDate = new Map();
  for (const r of daily) {
    if (platforms.includes(r.platform)) byDate.set(r.date, (byDate.get(r.date) ?? 0) + r.spend);
  }
  const factLimit = mode === 'past' ? end : mode === 'current' ? today : null;
  let acc = 0;
  const factSeries = dates.map((d) => {
    if (factLimit === null || d > factLimit) return null;
    acc += byDate.get(d) ?? 0;
    return acc;
  });
  const planSeries = dates.map((_, i) => (totalPlan * (i + 1)) / D);
  let forecastSeries = dates.map(() => null);
  if (mode === 'current') {
    const base = fullDays > 0 ? factSeries[fullDays - 1] : 0;
    forecastSeries = dates.map((_, i) => {
      if (i < fullDays - 1) return null;
      if (i === fullDays - 1) return base;
      return base + total.avg7 * (i - fullDays + 1);
    });
  }

  return {
    month,
    mode,
    daysInMonth: D,
    daysElapsed: fullDays,
    daysRemaining: mode === 'current' ? D - fullDays : mode === 'future' ? D : 0,
    thresholds: { under: UNDER_THRESHOLD, over: OVER_THRESHOLD },
    rows,
    total,
    series: { dates, fact: factSeries, plan: planSeries, forecast: forecastSeries },
  };
}
