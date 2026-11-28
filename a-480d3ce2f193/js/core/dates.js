// Работа с датами в формате YYYY-MM-DD. Календарная арифметика — в UTC,
// «сегодня» — по часовому поясу Europe/Chisinau.

export const TZ = 'Europe/Chisinau';

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

// Строгий разбор даты: только YYYY-MM-DD и только существующие даты.
export function parseIsoDate(value) {
  if (typeof value !== 'string') return null;
  const m = ISO_DATE.exec(value);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1) return null;
  const ts = Date.UTC(y, mo - 1, d);
  if (new Date(ts).getUTCDate() !== d) return null;
  return ts;
}

export function isIsoDate(value) {
  return parseIsoDate(value) !== null;
}

function fromTs(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

function toTs(iso) {
  const ts = parseIsoDate(iso);
  if (ts === null) throw new RangeError('Некорректная дата');
  return ts;
}

export function addDays(iso, days) {
  return fromTs(toTs(iso) + days * DAY_MS);
}

// Количество дней от a до b (b − a).
export function diffDays(a, b) {
  return Math.round((toTs(b) - toTs(a)) / DAY_MS);
}

export function daysInMonth(iso) {
  const d = new Date(toTs(iso));
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
}

export function monthStart(iso) {
  return `${iso.slice(0, 7)}-01`;
}

export function monthEnd(iso) {
  return `${iso.slice(0, 7)}-${String(daysInMonth(iso)).padStart(2, '0')}`;
}

export function addMonths(iso, months) {
  const d = new Date(toTs(monthStart(iso)));
  return fromTs(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
}

// Та же дата n лет спустя; 29 февраля в невисокосном году — 28 февраля.
export function addYears(iso, years) {
  const y = Number(iso.slice(0, 4)) + years;
  const mo = Number(iso.slice(5, 7));
  const d = Math.min(Number(iso.slice(8, 10)), new Date(Date.UTC(y, mo, 0)).getUTCDate());
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// Все даты от from до to включительно.
export function dateRange(from, to) {
  const out = [];
  for (let ts = toTs(from), end = toTs(to); ts <= end; ts += DAY_MS) out.push(fromTs(ts));
  return out;
}

function partsInTz(now, tz) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const p = Object.fromEntries(fmt.formatToParts(now).map((x) => [x.type, x.value]));
  return p;
}

export function todayInTz(now = new Date(), tz = TZ) {
  const p = partsInTz(now, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

// Минуты с начала текущих суток в часовом поясе (0…1439).
export function minutesSinceMidnight(now = new Date(), tz = TZ) {
  const p = partsInTz(now, tz);
  return Number(p.hour) * 60 + Number(p.minute);
}
