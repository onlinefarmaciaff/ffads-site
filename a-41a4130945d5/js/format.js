// Форматирование чисел и дат (русская локаль, часовой пояс Кишинёва).

const LOCALE = 'en-US';
const TZ = 'Europe/Chisinau';

const nf = (digits) => new Intl.NumberFormat(LOCALE, { minimumFractionDigits: digits, maximumFractionDigits: digits });
const N0 = nf(0);
const N1 = nf(1);
const N2 = nf(2);

const ok = (v) => typeof v === 'number' && Number.isFinite(v);

export const DASH = '—';

export function money(v) {
  return ok(v) ? `${N0.format(v)} MDL` : DASH;
}

export function money2(v) {
  return ok(v) ? `${N2.format(v)} MDL` : DASH;
}

// Суммы в валютах аккаунтов: { USD: 1234.5, EUR: 99 } → «1,234.50 USD · 99.00 EUR» (по убыванию).
// MDL не показывается — он и так в основной сумме; пусто, если других валют нет.
export function nativeMoney(map) {
  return Object.entries(map ?? {})
    .filter(([cur, v]) => cur !== 'MDL' && ok(v) && Math.abs(v) >= 0.005)
    .sort((a, b) => b[1] - a[1])
    .map(([cur, v]) => `${N2.format(v)} ${cur}`)
    .join(' · ');
}

export function int(v) {
  return ok(v) ? N0.format(v) : DASH;
}

export function num(v) {
  if (!ok(v)) return DASH;
  return Number.isInteger(v) ? N0.format(v) : N1.format(v);
}

export function pct(v, digits = 2) {
  return ok(v) ? `${nf(digits).format(v * 100)}%` : DASH;
}

export function ratio(v) {
  return ok(v) ? N2.format(v) : DASH;
}

export function signedPct(v) {
  if (!ok(v)) return DASH;
  const s = N1.format(Math.abs(v) * 100);
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${s}%`;
}

// Короткая запись больших чисел для осей: 12 тыс., 1,2 млн.
export function compact(v) {
  if (!ok(v)) return '';
  const a = Math.abs(v);
  if (a >= 1e6) return `${N1.format(v / 1e6)}M`;
  if (a >= 1e4) return `${N0.format(v / 1e3)}K`;
  return Number.isInteger(v) ? N0.format(v) : N2.format(v);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_SHORT = MONTHS.map((m) => m.slice(0, 3));

// Даты — как в Looker: «Oct 1, 2026», на осях — «Oct 1».
export function date(iso) {
  if (typeof iso !== 'string' || iso.length < 10) return DASH;
  return `${dateShort(iso)}, ${iso.slice(0, 4)}`;
}

export function dateShort(iso) {
  return `${MONTHS_SHORT[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;
}

export function monthName(ym) {
  return `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
}

export function bucketLabel(iso, granularity) {
  if (granularity === 'month') return `${MONTHS_SHORT[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
  if (granularity === 'week') return `wk ${dateShort(iso)}`;
  return dateShort(iso);
}

const DT = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const TIME = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

export function dateTime(ts) {
  if (!ts) return DASH;
  return DT.format(new Date(ts)).replace(',', '');
}

export function time(ts) {
  return TIME.format(ts instanceof Date ? ts : new Date(ts));
}
