// Расчёты дашборда в браузере по расшифрованным данным (вариант GitHub Pages).
// Отвечает на те же запросы, что и API сервера (dashboard/src/server.js), и использует
// те же модули: фильтры, бюджет, ряды графика (js/core — копии dashboard/src).
import { computePacing } from './core/budget.js';
import { addDays, addMonths, minutesSinceMidnight, monthEnd, todayInTz, TZ } from './core/dates.js';
import {
  BadRequest, BRANDS, parseBrand, parseFilters, parseGranularity, parseMonth, parsePlatforms, PLATFORMS,
} from './core/filters.js';
import { bucketize, bucketOf } from './core/series.js';

export const MAX_RANGE_DAYS = 1100;
export const REFRESH_SECONDS = 600;
export const CAMPAIGN_LIMIT = 2000;
export const PRODUCT_LIMIT = 5000;
export const PLACEMENT_LIMIT = 5000;
const SHOP_SUMS = ['total_sales', 'orders', 'gross_sales', 'discounts', 'returns', 'quantity_ordered', 'quantity_returned',
  'new_customers', 'sessions', 'sessions_that_completed_checkout'];
const SUMS = ['spend', 'revenue', 'conversions', 'impressions', 'clicks'];
const emptySums = () => Object.fromEntries(SUMS.map((k) => [k, 0]));

// Последний плановый запуск обновления (cron-job.org): будни — каждый час 8:00–17:00 по Кишинёву,
// выходные — в 10:00 и 18:00.
export function lastScheduledRun(now) {
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', hour: '2-digit', hourCycle: 'h23' });
  // Запуск может задержаться: слот считается пропущенным, если прошло больше 45 минут.
  let t = Math.floor((now.getTime() - 45 * 60_000) / 3_600_000) * 3_600_000;
  for (let i = 0; i < 24 * 8; i++, t -= 3_600_000) {
    const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    const hour = Number(p.hour);
    const weekend = ['Sat', 'Sun'].includes(p.weekday);
    if (weekend ? hour === 10 || hour === 18 : hour >= 8 && hour <= 17) return new Date(t);
  }
  return null;
}

const LABELS = {
  meta: 'Meta', google: 'Google', admixer: 'Admixer', budget: 'Budget', nbm: 'NBM rates', omnisend: 'Omnisend', ga4: 'GA4',
  meta_placement: 'Meta placements', meta_device: 'Meta devices', google_device: 'Google devices', google_age: 'Google age',
  admixer_placements: 'Admixer placements', admixer_creatives: 'Admixer creatives', shopify: 'Shopify', shopify_customers: 'Shopify customers', gsc: 'Search Console', dataedge: 'Data Edge', dataedge_sheet: 'Data Edge campaigns', gbp: 'Google Maps', onesignal: 'OneSignal', ahrefs: 'Ahrefs',
};

export function sourceStates(sources, now) {
  const slot = lastScheduledRun(now);
  return sources.map((s) => {
    const lastOkAt = s.last_ok_at ? new Date(s.last_ok_at) : null;
    let state;
    if (!s.last_run_at) state = 'never';
    else if (s.last_status === 'error') state = 'error';
    else if (s.last_status === 'backlog') state = 'stale';
    else if (!lastOkAt || (slot && lastOkAt < new Date(slot.getTime() - 10 * 60_000))) state = 'stale';
    else state = 'ok';
    return { source: s.source, label: LABELS[s.source] ?? s.source, state, lastOkAt: s.last_ok_at ?? null, lastRunAt: s.last_run_at ?? null };
  });
}

export function createEngine(payload, { now = () => new Date() } = {}) {
  const { days, rows: R } = payload;
  const campaigns = payload.campaigns.map(([platform, account_id, campaign_id, name, brand]) => ({ platform, account_id, campaign_id, name, brand }));
  const missing = new Set(payload.missingFx);
  const n = R.d.length;
  // Первая строка каждого дня (строки упорядочены по дню).
  const firstRow = new Int32Array(days.length + 1).fill(n);
  for (let i = n - 1; i >= 0; i--) firstRow[R.d[i]] = i;
  for (let d = days.length - 1; d >= 0; d--) if (firstRow[d] > firstRow[d + 1]) firstRow[d] = firstRow[d + 1];

  const lowerDay = (iso) => {
    let lo = 0;
    let hi = days.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (days[mid] < iso) lo = mid + 1; else hi = mid;
    }
    return lo;
  };

  // Обход строк периода с учётом платформ и бренда.
  function each(f, fn) {
    const platforms = new Set(f.platforms);
    const start = firstRow[lowerDay(f.from)];
    const end = firstRow[lowerDay(addDays(f.to, 1))];
    for (let i = start; i < end; i++) {
      const c = campaigns[R.c[i]];
      if (!platforms.has(c.platform) || (f.brand && c.brand !== f.brand)) continue;
      fn(i, c);
    }
  }

  const add = (acc, i) => {
    acc.spend += R.s[i];
    acc.revenue += R.r[i];
    acc.conversions += R.v[i];
    acc.impressions += R.i[i];
    acc.clicks += R.k[i];
  };

  // Расход в валютах аккаунтов (без пересчёта в MDL) — для сверки с кабинетами платформ.
  // В данных, собранных до появления R.u / R.o, сумм по валютам нет.
  const currencies = payload.currencies ?? [];
  const hasNative = Array.isArray(R.u) && Array.isArray(R.o);
  const addNative = (acc, i) => {
    const cur = currencies[R.u[i]];
    if (cur) acc[cur] = (acc[cur] ?? 0) + R.o[i];
  };

  function totals(f) {
    const byPlatform = Object.fromEntries(f.platforms.map((p) => [p, emptySums()]));
    const total = emptySums();
    const native = hasNative ? { total: {}, byPlatform: Object.fromEntries(f.platforms.map((p) => [p, {}])) } : null;
    let missingFx = 0;
    each(f, (i, c) => {
      add(byPlatform[c.platform], i);
      add(total, i);
      if (native) {
        addNative(native.total, i);
        addNative(native.byPlatform[c.platform], i);
      }
      if (missing.has(i)) missingFx++;
    });
    return { total, byPlatform, missingFx, native };
  }

  function daily(f) {
    const acc = new Map();
    each(f, (i, c) => {
      const k = `${days[R.d[i]]}|${c.platform}`;
      let a = acc.get(k);
      if (!a) acc.set(k, (a = { date: days[R.d[i]], platform: c.platform, ...emptySums() }));
      add(a, i);
    });
    return [...acc.values()];
  }

  function campaignRows(f) {
    const acc = new Map();
    each(f, (i, c) => {
      let a = acc.get(R.c[i]);
      if (!a) acc.set(R.c[i], (a = { ...c, ...emptySums() }));
      add(a, i);
    });
    return [...acc.values()].sort((a, b) => b.spend - a.spend || String(a.name).localeCompare(String(b.name)));
  }

  // Разбивки (площадка и устройство Meta, устройство и возраст Google Ads): суммы по значениям
  // за период с учётом бренда. Строки данных — суммы по дню × бренду × значению.
  const BREAKDOWN_PLATFORMS = { publisher_platform: 'meta', device_platform: 'meta', device: 'google', age_range: 'google' };
  const BD_SUMS = ['spend', 'conversions', 'impressions', 'clicks', 'clicksAll'];
  const BD_COLS = { spend: 's', conversions: 'v', impressions: 'i', clicks: 'k', clicksAll: 'a' };
  function breakdownTotals(bd, from, to, brand) {
    const sums = bd.values.map(() => Object.fromEntries(BD_SUMS.map((k) => [k, 0])));
    const B = bd.rows;
    for (let i = 0; i < B.d.length; i++) {
      const day = bd.days[B.d[i]];
      if (day < from || day > to) continue;
      if (brand && bd.brands[B.b[i]] !== brand) continue;
      const acc = sums[B.x[i]];
      for (const k of BD_SUMS) acc[k] += B[BD_COLS[k]][i];
    }
    return sums;
  }

  function plans(month, platforms, brand) {
    const out = {};
    for (const [m, platform, b, amount] of payload.budget) {
      if (m === month && platforms.includes(platform) && (!brand || b === brand)) out[platform] = (out[platform] ?? 0) + amount;
    }
    return out;
  }

  // ---------- Shopify ----------
  const sh = payload.shopify ?? null;

  // Суммы показателей магазина по дням периода (и по шагу графика, если bucket задан).
  function shopEach(from, to, fn) {
    if (!sh) return;
    for (let i = 0; i < sh.days.length; i++) {
      const d = sh.days[i];
      if (d >= from && d <= to) fn(i, d);
    }
  }
  const emptyShop = () => Object.fromEntries(SHOP_SUMS.map((k) => [k, 0]));
  function shopTotals(from, to) {
    const acc = emptyShop();
    shopEach(from, to, (i) => { for (const k of SHOP_SUMS) acc[k] += sh.daily[k]?.[i] ?? 0; });
    return acc;
  }
  function shopReferrer(from, to) {
    const acc = new Map();
    if (!sh) return acc;
    const R = sh.referrer.rows;
    for (let i = 0; i < R.d.length; i++) {
      const d = sh.days[R.d[i]];
      if (d < from || d > to) continue;
      const source = sh.referrer.sources[R.x[i]];
      const a = acc.get(source) ?? { sales: 0, orders: 0 };
      a.sales += R.s[i];
      a.orders += R.o[i];
      acc.set(source, a);
    }
    return acc;
  }
  // Товары: по дням, если период целиком в окне дневных данных; иначе — суммы по целым месяцам,
  // которые пересекаются с периодом.
  function shopProducts(from, to) {
    const P = sh.products;
    const dailyFrom = P.daily.keys[0];
    const useDaily = dailyFrom && from >= dailyFrom;
    const part = useDaily ? P.daily : P.monthly;
    const inRange = useDaily ? (k) => k >= from && k <= to : (k) => k >= from.slice(0, 7) && k <= to.slice(0, 7);
    const keys = part.keys.map(inRange);
    const acc = new Map();
    const R = part.rows;
    for (let i = 0; i < R.k.length; i++) {
      if (!keys[R.k[i]]) continue;
      const a = acc.get(R.p[i]) ?? { title: P.titles[R.p[i]], orders: 0, quantity: 0, sales: 0 };
      a.orders += R.o[i];
      a.quantity += R.q[i];
      a.sales += R.s[i];
      acc.set(R.p[i], a);
    }
    const months = useDaily ? null : part.keys.filter(inRange);
    return { mode: useDaily ? 'daily' : 'monthly', months: months && months.length ? [months[0], months.at(-1)] : null, dailyFrom, rows: [...acc.values()] };
  }

  // ---------- Площадки Admixer ----------
  const pl = payload.placements ?? null;

  // Профили по сайтам: по дням, если период целиком в окне дневных данных; иначе — суммы
  // по целым месяцам, которые пересекаются с периодом (как товары Shopify).
  const cr = payload.creatives ?? null;
  function placements(from, to, brand, ds = pl) {
    const pl = ds;
    const dailyFrom = pl.daily.keys[0];
    const useDaily = dailyFrom && from >= dailyFrom;
    const part = useDaily ? pl.daily : pl.monthly;
    const inRange = useDaily ? (k) => k >= from && k <= to : (k) => k >= from.slice(0, 7) && k <= to.slice(0, 7);
    const keys = part.keys.map(inRange);
    const acc = new Map();
    const R = part.rows;
    for (let i = 0; i < R.k.length; i++) {
      if (!keys[R.k[i]]) continue;
      const [profile, b, campaign] = pl.profiles[R.p[i]];
      if (brand && b !== brand) continue;
      const key = R.p[i] * 1e6 + R.x[i];
      const a = acc.get(key) ?? {
        domain: pl.domains[R.x[i]], profile, campaign, brand: b, impressions: 0, clicks: 0, spend: 0, spendNative: 0, viewable: 0,
      };
      a.impressions += R.i[i];
      a.clicks += R.c[i];
      a.spend += R.s[i];
      a.spendNative += R.o[i];
      a.viewable += R.w[i];
      acc.set(key, a);
    }
    const months = useDaily ? null : part.keys.filter(inRange);
    return {
      mode: useDaily ? 'daily' : 'monthly', months: months && months.length ? [months[0], months.at(-1)] : null,
      dailyFrom, dataFrom: pl.monthly.keys[0] ?? null, currency: pl.currency, rows: [...acc.values()],
    };
  }

  // ---------- Omnisend (push-кампании) ----------
  const om = payload.omnisend ?? null;
  const OM_KEYS = ['sent', 'opened', 'clicked', 'failed', 'unsubscribed', 'spam', 'orders', 'revenue'];
  const OM_COLS = ['s', 'o', 'k', 'f', 'u', 'm', 'n', 'r'];
  const emptyOm = () => Object.fromEntries(OM_KEYS.map((k) => [k, 0]));
  // Строки кампаний по дню отправки в периоде: fn(индекс строки, день).
  function omEach(from, to, fn) {
    const R = om.rows;
    for (let i = 0; i < R.d.length; i++) {
      const d = om.days[R.d[i]];
      if (d >= from && d <= to) fn(i, d);
    }
  }
  const omAdd = (acc, i) => { OM_KEYS.forEach((k, j) => { acc[k] += om.rows[OM_COLS[j]][i]; }); };
  function omTotals(from, to) {
    const acc = emptyOm();
    const ids = new Set();
    omEach(from, to, (i) => {
      omAdd(acc, i);
      if (om.rows.s[i] > 0) ids.add(om.rows.c[i]);
    });
    return { ...acc, campaigns: ids.size };
  }
  function omDevices(from, to) {
    const acc = new Map();
    const D = om.devices;
    for (let i = 0; i < D.rows.d.length; i++) {
      const d = D.days[D.rows.d[i]];
      if (d < from || d > to) continue;
      const type = D.types[D.rows.t[i]];
      const a = acc.get(type) ?? { opened: 0, clicked: 0 };
      a.opened += D.rows.o[i];
      a.clicked += D.rows.k[i];
      acc.set(type, a);
    }
    return acc;
  }

  // ---------- Search Console ----------
  const gsc = payload.gsc ?? null;
  const gscIndex = new Map((gsc?.days ?? []).map((d, i) => [d, i]));
  const GSC_DEVICES = ['MOBILE', 'DESKTOP', 'TABLET'];
  const gscZero = () => ({ clicks: 0, impressions: 0, pos: 0 });
  const gscAdd = (s, v) => { s.clicks += v[0]; s.impressions += v[1]; s.pos += v[2]; return s; };
  function gscSum(from, to, list) {
    const s = gscZero();
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const i = gscIndex.get(d);
      if (i !== undefined) gscAdd(s, list[i]);
    }
    return s;
  }
  function gscDevices(from, to) {
    const acc = GSC_DEVICES.map(gscZero);
    const D = gsc.devices;
    for (let i = 0; i < D.d.length; i++) {
      const d = gsc.days[D.d[i]];
      if (d >= from && d <= to) gscAdd(acc[D.t[i]], D.v[i]);
    }
    return acc;
  }
  // Месяцы, которые пересекаются с периодом: таблицы запросов, страниц и стран — суммы по ним.
  const gscMonths = (from, to) => Object.keys(gsc.months).filter((m) => m >= from.slice(0, 7) && m <= to.slice(0, 7)).sort();
  function gscTable(months, dim) {
    const acc = new Map();
    for (const m of months) {
      for (const [key, c, i, p] of gsc.months[m][dim].rows) {
        const s = acc.get(key) ?? gscZero();
        gscAdd(s, [c, i, p]);
        acc.set(key, s);
      }
    }
    return acc;
  }
  const gscCount = (months, dim) => (months.length
    ? Math.round(months.reduce((n, m) => n + gsc.months[m][dim].n, 0) / months.length) : null);

  // ---------- Ahrefs ----------
  const ah = payload.ahrefs ?? null;
  const AH_FIELDS = ['sov', 'avgPos', 'top3', 'top4_10', 'top11_20', 'top21_50', 'top51', 'noRank', 'traffic', 'aiOverview'];
  const ahStats = (row) => (row ? Object.fromEntries(AH_FIELDS.map((k, i) => [k, row[i]])) : null);
  const ahDayAtOrBefore = (days, d) => { let best = null; for (const x of days) if (x <= d) best = x; return best; };

  // ---------- Data Edge (SMS, Viber) ----------
  const de = payload.dataedge ?? null;
  const DE_CHANNELS = ['sms', 'viber'];
  // Строка: [канал, день, название, отправлено, доставлено, прочитано, стоимость MDL, стоимость в валюте счёта, частей SMS, переходов].
  const deZero = () => ({ mailings: 0, sent: 0, delivered: 0, read: 0, clicks: 0, clickSent: 0, cost: 0, costNative: 0, parts: 0 });
  function deSums(from, to) {
    const acc = DE_CHANNELS.map(deZero);
    for (const r of de.rows) {
      if (r[1] < from || r[1] > to) continue;
      const a = acc[r[0]];
      a.mailings++;
      a.sent += r[3];
      a.delivered += r[4];
      a.read += r[5] ?? 0;
      // clickSent — отправлено в рассылках с данными о переходах (для CTR; без ссылки — null).
      if (r[9] !== null && r[9] !== undefined) { a.clicks += r[9]; a.clickSent += r[3]; }
      a.cost += r[6];
      a.costNative += r[7];
      a.parts += r[8] ?? 0;
    }
    return acc;
  }
  // Итог по каналам; viberDelivered — для доли прочтений (прочтения есть только у Viber).
  const deTotal = (acc) => ({
    ...acc.reduce((t, a) => {
      for (const k of Object.keys(t)) t[k] += a[k];
      return t;
    }, deZero()),
    viberDelivered: acc[1].delivered,
  });

  // ---------- OneSignal (пуши приложения FF) ----------
  const os = payload.onesignal ?? null;
  const OS_KINDS = { campaign: 0, automated: 3, api: 1 };
  const osZero = () => ({ messages: 0, recipients: 0, sent: 0, received: 0, clicks: 0, undelivered: 0, iosSent: 0, iosClicks: 0, androidSent: 0, androidClicks: 0 });
  // Outcomes (все пуши, включая Journeys): суммы по дням периода; подтверждённые — только дни, где они известны.
  function osOutcomeSums(from, to) {
    // null — показатель недоступен (тариф OneSignal): считаются только дни, где он есть.
    const a = { days: 0, clicks: 0, clicksDays: 0, confirmed: 0, confirmedDays: 0, sessions: 0, direct: 0, influenced: 0, sessionDays: 0 };
    for (const [d, clicks, confirmed, sessions, direct, influenced] of os.outcomes ?? []) {
      if (d < from || d > to) continue;
      a.days++;
      if (clicks !== null) { a.clicks += clicks; a.clicksDays++; }
      if (confirmed !== null) { a.confirmed += confirmed; a.confirmedDays++; }
      if (direct !== null || influenced !== null) { a.direct += direct ?? 0; a.influenced += influenced ?? 0; a.sessions += sessions ?? 0; a.sessionDays++; }
    }
    return a;
  }
  function osOutcomes(f, granularity, dates) {
    const buckets = new Map();
    for (const [d, clicks, confirmed, sessions] of os.outcomes ?? []) {
      if (d < f.from || d > f.to) continue;
      const b = bucketOf(d, granularity);
      const a = buckets.get(b) ?? { date: b, clicks: 0, confirmed: 0, sessions: 0 };
      a.clicks += clicks ?? 0; a.confirmed += confirmed ?? 0; a.sessions += sessions ?? 0;
      buckets.set(b, a);
    }
    const m = os.month;
    return {
      dataFrom: os.outcomes?.[0]?.[0] ?? null,
      current: osOutcomeSums(f.from, f.to),
      previous: osOutcomeSums(f.prevFrom, f.prevTo),
      series: { granularity, rows: dates.map((d) => buckets.get(d) ?? { date: d, clicks: 0, confirmed: 0, sessions: 0 }) },
      month: m ? { day: m.day, clicks: m.values[0], confirmed: m.values[1], sessions: m.values[2], direct: m.values[3], influenced: m.values[4] } : null,
    };
  }
  // Journeys: всего — последний снимок не позже конца периода; за период — разница со снимком до начала периода
  // (нет такого снимка — null: снимки копятся с первой загрузки).
  function osJourneys(f) {
    const at = (snaps, day) => { let r = null; for (const s of snaps) if (s[0] <= day) r = s; return r; };
    return (os.journeys ?? []).map(([id, name, status, snaps]) => {
      const end = at(snaps, f.to) ?? snaps.at(-1) ?? null;
      const start = at(snaps, addDays(f.from, -1));
      const total = end ? { sent: end[1], delivered: end[2], clicks: end[3], failed: end[4], started: end[5], completed: end[6] } : null;
      const period = end && start ? { sent: end[1] - start[1], delivered: end[2] - start[2], clicks: end[3] - start[3] } : null;
      return { id, name, status, total, period };
    });
  }
  // each(день, отправлено, клики, получено) — для рядов; rows — сообщения периода.
  function osSums(from, to, kind, each, rows) {
    const a = osZero();
    for (const r of os.messages) {
      if (r[0] !== kind || r[1] < from || r[1] > to) continue;
      a.messages++; a.recipients += r[13] ?? 0; a.sent += r[5]; a.received += r[6]; a.clicks += r[7]; a.undelivered += r[8];
      a.iosSent += r[9]; a.iosClicks += r[10]; a.androidSent += r[11]; a.androidClicks += r[12];
      if (each) each(r[1], r[5], r[7], r[6]);
      if (rows) rows.push(r);
    }
    return a;
  }

  // ---------- Google Business Profile (Google Карты) ----------
  // Показатели строк: [показы Карты моб., Карты комп., Поиск моб., Поиск комп., сайт, звонки, маршруты, сообщения].
  const gbp = payload.gbp ?? null;
  const GBP_KEYS = ['mapsMobile', 'mapsDesktop', 'searchMobile', 'searchDesktop', 'website', 'calls', 'directions', 'messages'];
  const gbpZero = () => Object.fromEntries(GBP_KEYS.map((k) => [k, 0]));
  const gbpLoc = (row) => ({
    id: row[0], title: row[1], city: row[2], address: row[3], brand: row[4], mapsUri: row[5], status: row[6], rating: row[7], total: row[8],
  });
  const gbpLocs = gbp ? gbp.locations.map(gbpLoc) : [];
  const gbpBrandOk = (i, brand) => !brand || gbpLocs[i]?.brand === brand;
  function gbpFinish(a) {
    a.impressions = a.mapsMobile + a.mapsDesktop + a.searchMobile + a.searchDesktop;
    a.maps = a.mapsMobile + a.mapsDesktop;
    a.search = a.searchMobile + a.searchDesktop;
    a.actions = a.website + a.calls + a.directions + a.messages;
    return a;
  }
  // Суммы за период: по аптекам и всего; each(день, аптека, значения) — для рядов.
  function gbpSums(from, to, brand, each) {
    const byLoc = new Map();
    const total = gbpZero();
    const R = gbp.rows;
    for (let i = 0; i < R.d.length; i++) {
      const d = gbp.days[R.d[i]];
      if (d < from || d > to || !gbpBrandOk(R.l[i], brand)) continue;
      const a = byLoc.get(R.l[i]) ?? gbpZero();
      R.v[i].forEach((v, k) => { a[GBP_KEYS[k]] += v; total[GBP_KEYS[k]] += v; });
      byLoc.set(R.l[i], a);
      if (each) each(d, R.v[i]);
    }
    for (const a of byLoc.values()) gbpFinish(a);
    return { byLoc, total: gbpFinish(total) };
  }
  // Рейтинг на день: последний снимок не позже дня (по брендам) — средний, взвешенный по числу отзывов.
  function gbpRatingAt(day, brand) {
    let snap = null;
    for (const [d, s] of gbp.ratingDays) if (d <= day) snap = s;
    if (!snap) return { rating: null, reviewsTotal: null };
    let sum = 0;
    let n = 0;
    for (const [b, [s, c]] of Object.entries(snap)) if (!brand || b === brand) { sum += s; n += c; }
    return { rating: n ? sum / n : null, reviewsTotal: n || null };
  }
  function gbpReviewSums(from, to, brand) {
    const a = { newReviews: 0, starsSum: 0, replied: 0, lowReviews: 0 };
    for (const r of gbp.reviews) {
      if (r[1] < from || r[1] > to || !gbpBrandOk(r[0], brand)) continue;
      a.newReviews++;
      a.starsSum += r[2];
      a.replied += r[3];
      if (r[2] && r[2] <= 3) a.lowReviews++;
    }
    return a;
  }
  // Посты: один и тот же пост (день и текст) в разных аптеках — одной строкой со списком аптек.
  function gbpPostGroups(from, to, brand) {
    const groups = new Map();
    for (const p of gbp.posts) {
      if (p[1] < from || p[1] > to || !gbpBrandOk(p[0], brand)) continue;
      const key = `${p[1]}|${p[3]}`;
      const g = groups.get(key) ?? { date: p[1], type: p[2], summary: p[3], url: p[4], places: [] };
      const l = gbpLocs[p[0]];
      g.places.push({ location: l?.title ?? '', city: l?.city ?? '', address: l?.address ?? '', mapsUri: l?.mapsUri ?? '' });
      groups.set(key, g);
    }
    return [...groups.values()].slice(0, 500);
  }
  const gbpPostCount = (from, to, brand) => gbp.posts.filter((p) => p[1] >= from && p[1] <= to && gbpBrandOk(p[0], brand)).length;

  // ---------- GA4 ----------
  const ga = payload.ga4 ?? null;
  function gaGroups(from, to) {
    const acc = ga.groups.map(() => ({ sessions: 0, purchases: 0, revenue: 0 }));
    const R = ga.rows;
    for (let i = 0; i < R.d.length; i++) {
      const d = ga.days[R.d[i]];
      if (d < from || d > to) continue;
      const a = acc[R.g[i]];
      a.sessions += R.s[i];
      a.purchases += R.p[i];
      a.revenue += R.r[i];
    }
    return acc;
  }
  function gaFunnel(from, to) {
    const acc = ga.funnel.events.map(() => 0);
    ga.funnel.days.forEach((d, i) => {
      if (d >= from && d <= to) ga.funnel.counts[i].forEach((v, j) => { acc[j] += v; });
    });
    return acc;
  }
  const gaSum = (list) => list.reduce((t, a) => ({
    sessions: t.sessions + a.sessions, purchases: t.purchases + a.purchases, revenue: t.revenue + a.revenue,
  }), { sessions: 0, purchases: 0, revenue: 0 });

  const today = () => todayInTz(now(), TZ);
  const opts = { maxDays: MAX_RANGE_DAYS };

  const routes = {
    '/api/config': () => ({
      today: today(),
      timezone: TZ,
      currency: 'MDL',
      refreshSeconds: REFRESH_SECONDS,
      platforms: PLATFORMS,
      brands: BRANDS,
      metaPurchaseConfigured: payload.metaPurchaseConfigured,
      fxGaps: payload.fxGaps ?? {},
      dataFrom: days[0] ?? null,
      generatedAt: payload.generatedAt,
      features: {
        yoy: true, granularity: true, monthly: true, budgetMonthsBack: 36, maxRangeDays: MAX_RANGE_DAYS, shopify: Boolean(payload.shopify),
        placements: Boolean(pl), creatives: Boolean(cr), omnisend: Boolean(om), ga4: Boolean(ga), gsc: Boolean(gsc), dataedge: Boolean(de), ahrefs: Boolean(ah), maps: Boolean(gbp), onesignal: Boolean(os),
      },
    }),

    '/api/status': () => ({ now: now().toISOString(), generatedAt: payload.generatedAt, sources: sourceStates(payload.sources, now()) }),

    '/api/summary': (params) => {
      const f = parseFilters(params, today(), opts);
      return {
        period: { from: f.from, to: f.to, days: f.days, prevFrom: f.prevFrom, prevTo: f.prevTo, compare: f.compare },
        current: totals(f),
        previous: totals({ ...f, from: f.prevFrom, to: f.prevTo }),
      };
    },

    '/api/daily': (params) => {
      const f = parseFilters(params, today(), opts);
      return bucketize(f.from, f.to, daily(f), parseGranularity(params, f.from, f.to));
    },

    '/api/campaigns': (params) => {
      const rows = campaignRows(parseFilters(params, today(), opts));
      return { truncated: rows.length > CAMPAIGN_LIMIT, rows: rows.slice(0, CAMPAIGN_LIMIT) };
    },

    // Разбивка: dimension — publisher_platform, device_platform (Meta), device, age_range (Google Ads).
    // platformTotal — итог платформы за период (для доли статистики, попавшей в разбивку).
    // Нет данных — available: false.
    '/api/breakdown': (params) => {
      const dimension = params.get('dimension');
      if (!Object.hasOwn(BREAKDOWN_PLATFORMS, dimension ?? '')) throw new BadRequest('Unknown dimension');
      const f = parseFilters(params, today(), opts);
      const bd = payload.breakdowns?.[dimension];
      if (!bd) return { dimension, available: false, rows: [] };
      const cur = breakdownTotals(bd, f.from, f.to, f.brand);
      const prev = breakdownTotals(bd, f.prevFrom, f.prevTo, f.brand);
      const rows = bd.values.map((value, x) => ({ value, current: cur[x], previous: prev[x] }))
        .filter((r) => r.current.impressions > 0 || r.previous.impressions > 0 || r.current.clicks > 0 || r.current.spend > 0)
        .sort((a, b) => b.current.impressions - a.current.impressions || a.value.localeCompare(b.value));
      const platformTotal = totals({ ...f, platforms: [BREAKDOWN_PLATFORMS[dimension]] }).total;
      return { dimension, available: true, dataFrom: bd.days[0] ?? null, rows, platformTotal };
    },

    // Shopify: суммы за период и период сравнения, покупатели (только для стандартных периодов —
    // уникальные покупатели не суммируются по дням), рекламный расход всех платформ (для MER и
    // стоимости заказа), ряды графика, продажи по источникам. Нет данных — available: false.
    '/api/shopify': (params) => {
      if (!sh) return { available: false };
      const f = parseFilters(params, today(), opts);
      const adSpend = (from, to) => totals({ ...f, from, to, platforms: PLATFORMS, brand: '' }).total.spend;
      const sums = (from, to) => ({
        ...shopTotals(from, to), customers: sh.customers[`${from}|${to}`] ?? null, ad_spend: adSpend(from, to),
      });
      const granularity = parseGranularity(params, f.from, f.to);
      const buckets = new Map();
      shopEach(f.from, f.to, (i, d) => {
        const b = bucketOf(d, granularity);
        const a = buckets.get(b) ?? { date: b, ...emptyShop() };
        for (const k of SHOP_SUMS) a[k] += sh.daily[k]?.[i] ?? 0;
        buckets.set(b, a);
      });
      const dates = [];
      for (let d = f.from; d <= f.to; d = addDays(d, 1)) {
        const b = bucketOf(d, granularity);
        if (dates.at(-1) !== b) dates.push(b);
      }
      const cur = shopReferrer(f.from, f.to);
      const prev = shopReferrer(f.prevFrom, f.prevTo);
      const referrer = [...new Set([...cur.keys(), ...prev.keys()])]
        .map((source) => ({ source, current: cur.get(source) ?? { sales: 0, orders: 0 }, previous: prev.get(source) ?? { sales: 0, orders: 0 } }))
        .sort((a, b) => b.current.sales - a.current.sales);
      return {
        available: true,
        dataFrom: sh.days[0] ?? null,
        period: { from: f.from, to: f.to, days: f.days, prevFrom: f.prevFrom, prevTo: f.prevTo, compare: f.compare },
        current: sums(f.from, f.to),
        previous: sums(f.prevFrom, f.prevTo),
        series: { granularity, dates, rows: [...buckets.values()] },
        referrer,
      };
    },

    // Товары Shopify за период: по продажам, не больше PRODUCT_LIMIT.
    '/api/shopify/products': (params) => {
      if (!sh) return { available: false, rows: [] };
      const f = parseFilters(params, today(), opts);
      const p = shopProducts(f.from, f.to);
      p.rows.sort((a, b) => b.sales - a.sales || a.title.localeCompare(b.title));
      return { available: true, ...p, total: p.rows.length, truncated: p.rows.length > PRODUCT_LIMIT, rows: p.rows.slice(0, PRODUCT_LIMIT) };
    },

    // GA4: сессии и покупки по группам источников, воронка событий, ряд по дням, источники «Other».
    '/api/ga4': (params) => {
      if (!ga) return { available: false };
      const f = parseFilters(params, today(), opts);
      const granularity = parseGranularity(params, f.from, f.to);
      const cur = gaGroups(f.from, f.to);
      const prev = gaGroups(f.prevFrom, f.prevTo);
      const buckets = new Map();
      const R = ga.rows;
      for (let i = 0; i < R.d.length; i++) {
        const d = ga.days[R.d[i]];
        if (d < f.from || d > f.to) continue;
        const b = bucketOf(d, granularity);
        const a = buckets.get(b) ?? { date: b, sessions: 0, purchases: 0, revenue: 0 };
        a.sessions += R.s[i];
        a.purchases += R.p[i];
        a.revenue += R.r[i];
        buckets.set(b, a);
      }
      const dates = [];
      for (let d = f.from; d <= f.to; d = addDays(d, 1)) {
        const b = bucketOf(d, granularity);
        if (dates.at(-1) !== b) dates.push(b);
      }
      // Источники «Other» — за месяцы, которые пересекаются с периодом.
      const other = new Map();
      for (const [m, bySm] of Object.entries(ga.other ?? {})) {
        if (m < f.from.slice(0, 7) || m > f.to.slice(0, 7)) continue;
        for (const [sm, n] of Object.entries(bySm)) other.set(sm, (other.get(sm) ?? 0) + n);
      }
      // Признаки неполных данных GA4 за месяцы периода.
      const quality = { otherRow: false, thresholding: false, sampling: false };
      for (const [m, flags] of Object.entries(ga.quality ?? {})) {
        if (m < f.from.slice(0, 7) || m > f.to.slice(0, 7)) continue;
        ['otherRow', 'thresholding', 'sampling'].forEach((k, i) => { if (flags[i]) quality[k] = true; });
      }
      return {
        available: true,
        quality,
        dataFrom: ga.days[0] ?? null,
        dimension: ga.dimension,
        period: { from: f.from, to: f.to, days: f.days, prevFrom: f.prevFrom, prevTo: f.prevTo, compare: f.compare },
        groups: ga.groups.map(([key, label, media, ai], i) => ({ key, label, media, ai: Boolean(ai), current: cur[i], previous: prev[i] })),
        current: gaSum(cur),
        previous: gaSum(prev),
        funnel: { events: ga.funnel.events, current: gaFunnel(f.from, f.to), previous: gaFunnel(f.prevFrom, f.prevTo) },
        series: { granularity, dates, rows: dates.map((d) => buckets.get(d) ?? { date: d, sessions: 0, purchases: 0, revenue: 0 }) },
        otherSources: [...other].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([source, sessions]) => ({ source, sessions })),
      };
    },

    // Omnisend: push-кампании за период — суммы, ряд по дням отправки, кампании, устройства, дни недели.
    // Search Console: период — по последний день с данными (последние 2–3 дня Google ещё досчитывает):
    // иначе неполные дни сравнивались бы с полными днями прошлого периода.
    '/api/gsc': (params) => {
      if (!gsc) return { available: false };
      const dataTo = gsc.days.at(-1) ?? null;
      let f = parseFilters(params, today(), opts);
      const requestedTo = f.to;
      if (dataTo && f.to > dataTo && dataTo >= f.from) {
        const p = new URLSearchParams(params);
        p.set('to', dataTo);
        f = parseFilters(p, today(), opts);
      }
      const granularity = parseGranularity(params, f.from, f.to);
      const buckets = new Map();
      const dates = [];
      for (let d = f.from; d <= f.to; d = addDays(d, 1)) {
        const b = bucketOf(d, granularity);
        if (dates.at(-1) !== b) dates.push(b);
        const i = gscIndex.get(d);
        if (i === undefined) continue;
        const a = buckets.get(b) ?? { date: b, ...gscZero(), brandClicks: 0, brandImpressions: 0 };
        gscAdd(a, gsc.totals[i]);
        a.brandClicks += gsc.brand[i][0];
        a.brandImpressions += gsc.brand[i][1];
        buckets.set(b, a);
      }
      const curMonths = gscMonths(f.from, f.to);
      const prevMonths = gscMonths(f.prevFrom, f.prevTo);
      const table = (dim) => {
        const cur = gscTable(curMonths, dim);
        const prev = gscTable(prevMonths, dim);
        return {
          n: gscCount(curMonths, dim),
          rows: [...cur].map(([key, s]) => ({ key, current: s, previous: prev.get(key) ?? null })),
        };
      };
      const devCur = gscDevices(f.from, f.to);
      const devPrev = gscDevices(f.prevFrom, f.prevTo);
      const current = { ...gscSum(f.from, f.to, gsc.totals), queries: gscCount(curMonths, 'query') };
      const previous = { ...gscSum(f.prevFrom, f.prevTo, gsc.totals), queries: gscCount(prevMonths, 'query') };
      return {
        available: true,
        site: gsc.site,
        brandRegex: gsc.brandRegex,
        dataFrom: gsc.days[0] ?? null,
        dataTo,
        period: { from: f.from, to: f.to, requestedTo, days: f.days, prevFrom: f.prevFrom, prevTo: f.prevTo, compare: f.compare },
        current,
        previous,
        brand: { current: gscSum(f.from, f.to, gsc.brand), previous: gscSum(f.prevFrom, f.prevTo, gsc.brand) },
        devices: GSC_DEVICES.map((type, t) => ({ type, current: devCur[t], previous: devPrev[t] })),
        series: { granularity, rows: dates.map((d) => buckets.get(d) ?? { date: d, ...gscZero(), brandClicks: 0, brandImpressions: 0 }) },
        tables: { months: curMonths, prevMonths, query: table('query'), page: table('page'), country: table('country') },
      };
    },

    // Ahrefs: сила сайта — помесячно (месяц конца периода против предыдущего), позиции Rank Tracker — по дням
    // (последний день периода против последнего дня периода сравнения), слова и страницы — последний снимок.
    '/api/ahrefs': (params) => {
      if (!ah) return { available: false };
      const f = parseFilters(params, today(), opts);
      const device = params.get('device') === 'desktop' ? 'desktop' : 'mobile';
      const months = Object.keys(ah.monthly).sort();
      const monthRow = (m) => {
        const r = ah.monthly[m];
        return { month: m, dr: r[0], refdomains: r[1], traffic: r[2], cost: r[3], top3: r[4], top4_10: r[5], top11: r[6] };
      };
      const endMonth = ahDayAtOrBefore(months, f.to.slice(0, 7));
      const prevMonth = endMonth ? ahDayAtOrBefore(months.filter((m) => m < endMonth), endMonth) : null;
      const days = Object.keys(ah.rank).filter((d) => ah.rank[d][device]).sort();
      const own = ah.target;
      const curDay = ahDayAtOrBefore(days, f.to);
      const prevDay = ahDayAtOrBefore(days, f.prevTo);
      const cur = curDay ? ah.rank[curDay][device] : {};
      const prev = prevDay ? ah.rank[prevDay][device] : {};
      const series = days.filter((d) => d >= f.from && d <= f.to).map((d) => ({ date: d, ...ahStats(ah.rank[d][device][own]) }));
      return {
        available: true,
        target: own,
        device,
        period: { from: f.from, to: f.to, days: f.days, prevFrom: f.prevFrom, prevTo: f.prevTo, compare: f.compare },
        monthly: { rows: months.map(monthRow), current: endMonth ? monthRow(endMonth) : null, previous: prevMonth ? monthRow(prevMonth) : null },
        rank: {
          day: curDay, prevDay, series,
          current: ahStats(cur[own]), previous: ahStats(prev[own]),
          competitors: Object.keys(cur).filter((k) => k !== own).map((name) => ({ name, current: ahStats(cur[name]), previous: ahStats(prev[name]) })),
        },
        keywords: ah.keywords ? { date: ah.keywords.date, compared: ah.keywords.compared, rows: (ah.keywords[device] ?? []).map((r) => ({
          keyword: r[0], position: r[1], previous: r[2], volume: r[3], traffic: r[4], url: r[5], branded: Boolean(r[6]),
        })) } : null,
        pages: ah.pages ? { date: ah.pages.date, rows: ah.pages.rows.map((r) => ({ url: r[0], traffic: r[1], previous: r[2], keywords: r[3], topKeyword: r[4] })) } : null,
      };
    },

    // Data Edge: кампании из кабинета по дате отправки.
    '/api/dataedge': (params) => {
      if (!de) return { available: false };
      const f = parseFilters(params, today(), opts);
      const granularity = parseGranularity(params, f.from, f.to);
      const cur = deSums(f.from, f.to);
      const prev = deSums(f.prevFrom, f.prevTo);
      const buckets = new Map();
      const dates = [];
      for (let d = f.from; d <= f.to; d = addDays(d, 1)) {
        const b = bucketOf(d, granularity);
        if (dates.at(-1) !== b) dates.push(b);
      }
      const empty = (date) => ({ date, smsSent: 0, viberSent: 0, smsDelivered: 0, viberDelivered: 0, viberRead: 0, cost: 0 });
      const mailings = [];
      for (const r of de.rows) {
        if (r[1] < f.from || r[1] > f.to) continue;
        const b = bucketOf(r[1], granularity);
        const a = buckets.get(b) ?? empty(b);
        if (r[0] === 0) { a.smsSent += r[3]; a.smsDelivered += r[4]; } else { a.viberSent += r[3]; a.viberDelivered += r[4]; a.viberRead += r[5] ?? 0; }
        a.cost += r[6];
        buckets.set(b, a);
        const hasClicks = r[9] !== null && r[9] !== undefined;
        mailings.push({
          channel: DE_CHANNELS[r[0]], date: r[1], name: r[2], sent: r[3], delivered: r[4], read: r[5],
          cost: r[6], costNative: r[7], parts: r[8], clicks: hasClicks ? r[9] : null, clickSent: hasClicks ? r[3] : 0,
        });
      }
      return {
        available: true,
        currency: de.currency,
        balance: de.balance,
        sheet: de.sheet ?? null,
        dataFrom: de.rows[0]?.[1] ?? null,
        period: { from: f.from, to: f.to, days: f.days, prevFrom: f.prevFrom, prevTo: f.prevTo, compare: f.compare },
        current: deTotal(cur),
        previous: deTotal(prev),
        channels: DE_CHANNELS.map((channel, i) => ({ channel, current: cur[i], previous: prev[i] })),
        series: { granularity, dates, rows: dates.map((d) => buckets.get(d) ?? empty(d)) },
        mailings,
      };
    },

    // OneSignal: пуши приложения по дню отправки; kind — campaign (кампании, по умолчанию), automated, api.
    '/api/onesignal': (params) => {
      if (!os) return { available: false };
      const f = parseFilters(params, today(), opts);
      const raw = String(params.get('kind') ?? 'api').toLowerCase();
      const kindName = raw in OS_KINDS ? raw : 'api';
      const kind = OS_KINDS[kindName];
      const granularity = parseGranularity(params, f.from, f.to);
      const dates = [];
      for (let d = f.from; d <= f.to; d = addDays(d, 1)) {
        const b = bucketOf(d, granularity);
        if (dates.at(-1) !== b) dates.push(b);
      }
      const buckets = new Map();
      const rows = [];
      const current = osSums(f.from, f.to, kind, (d, sent, clicks, received) => {
        const b = bucketOf(d, granularity);
        const a = buckets.get(b) ?? { date: b, sent: 0, clicks: 0, received: 0 };
        a.sent += sent; a.clicks += clicks; a.received += received;
        buckets.set(b, a);
      }, rows);
      const previous = osSums(f.prevFrom, f.prevTo, kind);
      const first = os.messages.find((r) => r[0] === kind)?.[1];
      return {
        available: true,
        kind: kindName,
        dataFrom: first ?? null,
        historyDone: kind === 1 ? os.apiCaughtUp : os.historyDone,
        period: { from: f.from, to: f.to, days: f.days, prevFrom: f.prevFrom, prevTo: f.prevTo, compare: f.compare },
        current,
        previous,
        series: { granularity, rows: dates.map((d) => buckets.get(d) ?? { date: d, sent: 0, clicks: 0, received: 0 }) },
        outcomes: osOutcomes(f, granularity, dates),
        journeys: osJourneys(f),
        messages: rows.map((r) => ({
          date: r[1], name: r[2], title: r[3], text: r[4], sent: r[5], received: r[6], clicks: r[7], undelivered: r[8],
          iosSent: r[9], iosClicks: r[10], androidSent: r[11], androidClicks: r[12], recipients: r[13] ?? null,
        })),
      };
    },

    // Google Карты: показы и действия за период — по последний день с данными (Google досчитывает последние дни);
    // рейтинг — снимок на конец периода; отзывы, посты — по дате публикации; фразы — за месяцы периода.
    '/api/maps': (params) => {
      if (!gbp) return { available: false };
      const brandRaw = String(params.get('brand') ?? '').toUpperCase();
      const brand = ['FF', 'DITA', 'OPTICA'].includes(brandRaw) ? brandRaw : '';
      const dataTo = gbp.days.at(-1) ?? null;
      let f = parseFilters(params, today(), opts);
      const requestedTo = f.to;
      if (dataTo && f.to > dataTo && dataTo >= f.from) {
        const p = new URLSearchParams(params);
        p.set('to', dataTo);
        f = parseFilters(p, today(), opts);
      }
      const granularity = parseGranularity(params, f.from, f.to);
      const dates = [];
      for (let d = f.from; d <= f.to; d = addDays(d, 1)) {
        const b = bucketOf(d, granularity);
        if (dates.at(-1) !== b) dates.push(b);
      }
      const buckets = new Map();
      const cur = gbpSums(f.from, f.to, brand, (d, v) => {
        const b = bucketOf(d, granularity);
        const a = buckets.get(b) ?? { date: b, impressions: 0, website: 0, calls: 0, directions: 0 };
        a.impressions += v[0] + v[1] + v[2] + v[3];
        a.website += v[4];
        a.calls += v[5];
        a.directions += v[6];
        buckets.set(b, a);
      });
      const prev = gbpSums(f.prevFrom, f.prevTo, brand);
      const open = gbpLocs.filter((l, i) => gbpBrandOk(i, brand) && l.status === 'OPEN').length;
      const summary = (sums, from, to, ratingDay) => {
        const r = gbpReviewSums(from, to, brand);
        const rating = gbpRatingAt(ratingDay, brand);
        return { ...sums.total, ...r, ...rating, posts: gbpPostCount(from, to, brand) };
      };
      // Рейтинг: период до вчера — последний снимок (он делается в день загрузки), иначе — снимок на конец периода.
      const ratingDay = requestedTo >= addDays(today(), -2) ? today() : requestedTo;
      const current = { ...summary(cur, f.from, requestedTo, ratingDay), locations: open };
      const previous = summary(prev, f.prevFrom, f.prevTo, f.prevTo);
      const locRev = new Map();
      for (const r of gbp.reviews) {
        if (r[1] < f.from || r[1] > requestedTo || !gbpBrandOk(r[0], brand)) continue;
        const a = locRev.get(r[0]) ?? { newReviews: 0, starsSum: 0, replied: 0 };
        a.newReviews++;
        a.starsSum += r[2];
        a.replied += r[3];
        locRev.set(r[0], a);
      }
      const locPosts = new Map();
      for (const p of gbp.posts) if (p[1] >= f.from && p[1] <= requestedTo && gbpBrandOk(p[0], brand)) locPosts.set(p[0], (locPosts.get(p[0]) ?? 0) + 1);
      const locations = gbpLocs.flatMap((l, i) => {
        if (!gbpBrandOk(i, brand)) return [];
        const c = cur.byLoc.get(i) ?? gbpFinish(gbpZero());
        const p = prev.byLoc.get(i) ?? null;
        return [{ ...l, ...c, previousActions: p ? p.actions : null, ...(locRev.get(i) ?? { newReviews: 0, starsSum: 0, replied: 0 }), posts: locPosts.get(i) ?? 0 }];
      });
      let months = Object.keys(gbp.keywords).filter((m) => m >= f.from.slice(0, 7) && m <= f.to.slice(0, 7)).sort();
      // Месяц периода ещё не закончен (фразы — только за полные месяцы) — последний полный месяц до конца периода.
      const latest = !months.length;
      if (latest) months = Object.keys(gbp.keywords).filter((m) => m <= f.to.slice(0, 7)).sort().slice(-1);
      const kw = new Map();
      for (const m of months) {
        for (const [b, list] of Object.entries(gbp.keywords[m])) {
          if (brand && b !== brand) continue;
          for (const [k, n] of list) kw.set(k, (kw.get(k) ?? 0) + n);
        }
      }
      const keywords = [...kw].sort((a, b) => b[1] - a[1]).slice(0, 300).map(([keyword, impressions]) => ({ keyword, impressions }));
      const name = (i) => gbpLocs[i]?.title ?? '';
      const city = (i) => gbpLocs[i]?.city ?? '';
      return {
        available: true,
        brand,
        syncedDay: gbp.syncedDay,
        dataFrom: gbp.days[0] ?? null,
        dataTo,
        period: { from: f.from, to: f.to, requestedTo, days: f.days, prevFrom: f.prevFrom, prevTo: f.prevTo, compare: f.compare },
        current,
        previous,
        series: { granularity, rows: dates.map((d) => buckets.get(d) ?? { date: d, impressions: 0, website: 0, calls: 0, directions: 0 }) },
        locations,
        reviews: gbp.reviews.filter((r) => r[1] >= f.from && r[1] <= requestedTo && gbpBrandOk(r[0], brand)).slice(0, 1000)
          .map((r) => ({ location: name(r[0]), city: city(r[0]), address: gbpLocs[r[0]]?.address ?? '', mapsUri: gbpLocs[r[0]]?.mapsUri ?? '', date: r[1], stars: r[2], replied: Boolean(r[3]), text: r[4] })),
        posts: gbpPostGroups(f.from, requestedTo, brand),
        keywords: { months, latest: latest && months.length > 0, rows: keywords },
      };
    },

    '/api/omnisend': (params) => {
      if (!om) return { available: false };
      const f = parseFilters(params, today(), opts);
      const granularity = parseGranularity(params, f.from, f.to);
      const buckets = new Map();
      const byCampaign = new Map();
      const week = Array.from({ length: 7 }, (_, w) => ({ weekday: w, ids: new Set(), ...emptyOm() }));
      omEach(f.from, f.to, (i, d) => {
        const b = bucketOf(d, granularity);
        const a = buckets.get(b) ?? { date: b, ...emptyOm() };
        omAdd(a, i);
        buckets.set(b, a);
        const c = om.rows.c[i];
        const [id, name] = om.campaigns[c];
        const r = byCampaign.get(c) ?? { id, name, date: d, ...emptyOm() };
        if (d < r.date) r.date = d;
        omAdd(r, i);
        byCampaign.set(c, r);
        // День недели отправки: 0 — понедельник.
        const w = week[(new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7];
        omAdd(w, i);
        if (om.rows.s[i] > 0) w.ids.add(c);
      });
      const dates = [];
      for (let d = f.from; d <= f.to; d = addDays(d, 1)) {
        const b = bucketOf(d, granularity);
        if (dates.at(-1) !== b) dates.push(b);
      }
      const cur = omDevices(f.from, f.to);
      const prev = omDevices(f.prevFrom, f.prevTo);
      const devices = [...new Set([...cur.keys(), ...prev.keys()])]
        .map((type) => ({ type, current: cur.get(type) ?? { opened: 0, clicked: 0 }, previous: prev.get(type) ?? { opened: 0, clicked: 0 } }))
        .sort((a, b) => b.current.opened - a.current.opened);
      return {
        available: true,
        dataFrom: om.days[0] ?? null,
        currency: om.currency,
        period: { from: f.from, to: f.to, days: f.days, prevFrom: f.prevFrom, prevTo: f.prevTo, compare: f.compare },
        current: omTotals(f.from, f.to),
        previous: omTotals(f.prevFrom, f.prevTo),
        // Дни без отправок — нули (линия отправок опускается до нуля, как в Looker; доли — пропуски).
        series: { granularity, dates, rows: dates.map((d) => buckets.get(d) ?? { date: d, ...emptyOm() }) },
        campaigns: [...byCampaign.values()].sort((a, b) => b.sent - a.sent || a.name.localeCompare(b.name)),
        devices,
        weekdays: week.map(({ ids, ...w }) => ({ ...w, campaigns: ids.size })),
      };
    },

    // Площадки Admixer за период: профиль × сайт, по показам, не больше PLACEMENT_LIMIT.
    '/api/admixer/placements': (params) => {
      if (!pl) return { available: false, rows: [] };
      const f = parseFilters(params, today(), opts);
      const p = placements(f.from, f.to, f.brand);
      p.rows.sort((a, b) => b.impressions - a.impressions || a.domain.localeCompare(b.domain));
      return { available: true, ...p, total: p.rows.length, truncated: p.rows.length > PLACEMENT_LIMIT, rows: p.rows.slice(0, PLACEMENT_LIMIT) };
    },

    // Креативы Admixer: те же правила, что у площадок; «domain» — размер креатива, «profile» — креатив.
    '/api/admixer/creatives': (params) => {
      if (!cr) return { available: false, rows: [] };
      const f = parseFilters(params, today(), opts);
      const p = placements(f.from, f.to, f.brand, cr);
      p.rows.sort((a, b) => b.impressions - a.impressions);
      return { available: true, ...p, total: p.rows.length, truncated: p.rows.length > PLACEMENT_LIMIT, rows: p.rows.slice(0, PLACEMENT_LIMIT) };
    },

    '/api/budget': (params) => {
      const t = today();
      const { month, start, end } = parseMonth(params, t);
      const platforms = parsePlatforms(params);
      const brand = parseBrand(params);
      const from = addDays(t, -7) < start ? addDays(t, -7) : start;
      const spend = daily({ from, to: end, platforms, brand }).map((r) => ({ date: r.date, platform: r.platform, spend: r.spend }));
      return computePacing({ month, today: t, minutes: minutesSinceMidnight(now(), TZ), plans: plans(start, platforms, brand), daily: spend, platforms });
    },

    // По месяцам: факт за дни периода, план — за весь месяц.
    '/api/monthly': (params) => {
      const f = parseFilters(params, today(), opts);
      const out = [];
      for (let m = `${f.from.slice(0, 7)}-01`; m <= f.to; m = addMonths(m, 1)) {
        const from = m < f.from ? f.from : m;
        const end = monthEnd(m);
        const to = end > f.to ? f.to : end;
        const t = totals({ ...f, from, to });
        const plan = Object.values(plans(m, f.platforms, f.brand)).reduce((s, v) => s + v, 0);
        out.push({
          month: m,
          partial: from !== m || to !== end,
          ...t.total,
          plan,
          byPlatform: Object.fromEntries(f.platforms.map((p) => [p, t.byPlatform[p].spend])),
        });
      }
      const total = { ...emptySums(), plan: 0, byPlatform: Object.fromEntries(f.platforms.map((p) => [p, 0])) };
      for (const r of out) {
        for (const k of [...SUMS, 'plan']) total[k] += r[k];
        for (const p of f.platforms) total.byPlatform[p] += r.byPlatform[p];
      }
      return { rows: out, total };
    },
  };

  return {
    handle(path, params) {
      const route = routes[path];
      if (!route) throw new BadRequest('Not found');
      return route(params);
    },
  };
}
