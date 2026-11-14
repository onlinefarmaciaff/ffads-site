// Разбор и проверка параметров запросов API. Любое отклонение — ошибка 400,
// исходное значение в ответ не возвращается.
import { addDays, addMonths, addYears, diffDays, isIsoDate, monthEnd, monthStart } from './dates.js';
import { autoGranularity, GRANULARITIES } from './series.js';

export const PLATFORMS = ['meta', 'google', 'admixer'];
export const BRANDS = ['FF', 'DITA', 'OPTICA'];
export const MAX_RANGE_DAYS = 731;

export class BadRequest extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

function single(params, name) {
  const all = params.getAll(name);
  if (all.length > 1) throw new BadRequest(`Parameter ${name} is given more than once`);
  return all[0];
}

export function parsePlatforms(params) {
  const raw = single(params, 'platforms');
  if (raw === undefined) return [...PLATFORMS];
  const list = [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))];
  if (list.length === 0) throw new BadRequest('Select at least one platform');
  if (!list.every((p) => PLATFORMS.includes(p))) throw new BadRequest('Unknown platform');
  return PLATFORMS.filter((p) => list.includes(p));
}

export function parseBrand(params) {
  const raw = single(params, 'brand');
  if (raw === undefined || raw === '' || raw === 'all') return null;
  if (!BRANDS.includes(raw)) throw new BadRequest('Unknown brand');
  return raw;
}

// Период сравнения: prev — предыдущий период той же длины, yoy — те же даты год назад.
export const COMPARE_MODES = ['prev', 'yoy'];

export function parseCompare(params) {
  const raw = single(params, 'compare');
  if (raw === undefined || raw === '') return 'prev';
  if (!COMPARE_MODES.includes(raw)) throw new BadRequest('Unknown comparison mode');
  return raw;
}

// Период и период сравнения.
export function parsePeriod(params, today, { maxDays = MAX_RANGE_DAYS } = {}) {
  let from = single(params, 'from');
  let to = single(params, 'to');
  if (from === undefined && to === undefined) {
    from = monthStart(today);
    to = today;
  }
  if (!isIsoDate(from) || !isIsoDate(to)) throw new BadRequest('Invalid period: dates must be YYYY-MM-DD');
  if (from > to) throw new BadRequest('Invalid period: start date is after end date');
  const days = diffDays(from, to) + 1;
  if (days > maxDays) throw new BadRequest(`Invalid period: at most ${maxDays} days`);
  if (diffDays(today, to) > 366) throw new BadRequest('Invalid period: end date is too far in the future');
  const compare = parseCompare(params);
  if (compare === 'yoy') return { from, to, days, compare, prevFrom: addYears(from, -1), prevTo: addYears(to, -1) };
  const prevTo = addDays(from, -1);
  const prevFrom = addDays(prevTo, -(days - 1));
  return { from, to, days, compare, prevFrom, prevTo };
}

export function parseFilters(params, today, opts) {
  return { ...parsePeriod(params, today, opts), platforms: parsePlatforms(params), brand: parseBrand(params) };
}

// Шаг графика динамики: auto — по длине периода.
export function parseGranularity(params, from, to) {
  const raw = single(params, 'granularity');
  if (raw === undefined || raw === '' || raw === 'auto') return autoGranularity(from, to);
  if (!GRANULARITIES.includes(raw)) throw new BadRequest('Unknown chart step');
  return raw;
}

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function parseMonth(params, today) {
  const raw = single(params, 'month');
  const month = raw === undefined || raw === '' ? today.slice(0, 7) : raw;
  if (!MONTH.test(month)) throw new BadRequest('Invalid month: use YYYY-MM');
  const start = `${month}-01`;
  if (!isIsoDate(start)) throw new BadRequest('Invalid month');
  if (start < addMonths(today, -36) || start > addMonths(today, 12)) {
    throw new BadRequest('Month is out of range');
  }
  return { month, start, end: monthEnd(start) };
}
