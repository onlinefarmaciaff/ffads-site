// Календарная арифметика для дат YYYY-MM-DD (в UTC, без часовых поясов).

const DAY_MS = 86_400_000;

const toTs = (iso) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
const fromTs = (ts) => new Date(ts).toISOString().slice(0, 10);

export function isIsoDate(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  return fromTs(toTs(v)) === v;
}

export const addDays = (iso, n) => fromTs(toTs(iso) + n * DAY_MS);
export const diffDays = (a, b) => Math.round((toTs(b) - toTs(a)) / DAY_MS);
export const monthStart = (iso) => `${iso.slice(0, 7)}-01`;

export function addMonths(iso, n) {
  const d = new Date(toTs(monthStart(iso)));
  return fromTs(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
}

export const monthEnd = (iso) => addDays(addMonths(iso, 1), -1);

// Период по пресету. «7/30/90 дней» — последние полные дни, по вчера включительно;
// «N месяцев» — N календарных месяцев, включая текущий.
export function presetRange(preset, today) {
  if (preset === 'this_month') return { from: monthStart(today), to: today };
  if (preset === 'this_quarter') {
    const m = Number(today.slice(5, 7));
    const qStart = `${today.slice(0, 4)}-${String(m - ((m - 1) % 3)).padStart(2, '0')}-01`;
    return { from: qStart, to: today };
  }
  if (preset === '3m' || preset === '6m' || preset === '12m') {
    return { from: addMonths(today, -(Number(preset.slice(0, -1)) - 1)), to: today };
  }
  if (preset === 'this_year') return { from: `${today.slice(0, 4)}-01-01`, to: today };
  if (preset === 'last_year') {
    const y = Number(today.slice(0, 4)) - 1;
    return { from: `${y}-01-01`, to: `${y}-12-31` };
  }
  if (preset === 'last_month') {
    const start = addMonths(today, -1);
    return { from: start, to: monthEnd(start) };
  }
  const n = Number(preset);
  if ([7, 30, 90].includes(n)) {
    const to = addDays(today, -1);
    return { from: addDays(to, -(n - 1)), to };
  }
  return null;
}
