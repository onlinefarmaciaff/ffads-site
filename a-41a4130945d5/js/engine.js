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

// Последний плановый запуск обновления: будни, каждый час 8:00–17:00 по Кишинёву.
export function lastScheduledRun(now) {
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', hour: '2-digit', hourCycle: 'h23' });
  // Запуск может задержаться: слот считается пропущенным, если прошло больше 45 минут.
  let t = Math.floor((now.getTime() - 45 * 60_000) / 3_600_000) * 3_600_000;
  for (let i = 0; i < 24 * 8; i++, t -= 3_600_000) {
    const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    const hour = Number(p.hour);
    if (!['Sat', 'Sun'].includes(p.weekday) && hour >= 8 && hour <= 17) return new Date(t);
  }
  return null;
}

const LABELS = { meta: 'Meta', google: 'Google', admixer: 'Admixer', budget: 'Budget', nbm: 'NBM rates', omnisend: 'Omnisend' };

export function sourceStates(sources, now) {
  const slot = lastScheduledRun(now);
  return sources.map((s) => {
    const lastOkAt = s.last_ok_at ? new Date(s.last_ok_at) : null;
    let state;
    if (!s.last_run_at) state = 'never';
    else if (s.last_status === 'error') state = 'error';
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
  function placements(from, to, brand) {
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
      dataFrom: days[0] ?? null,
      generatedAt: payload.generatedAt,
      features: {
        yoy: true, granularity: true, monthly: true, budgetMonthsBack: 36, maxRangeDays: MAX_RANGE_DAYS, shopify: Boolean(payload.shopify),
        placements: Boolean(pl), omnisend: Boolean(om),
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

    // Omnisend: push-кампании за период — суммы, ряд по дням отправки, кампании, устройства, дни недели.
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
