// FF Ads Dashboard — сценарий страницы: вкладки (обзор и платформы), фильтры, загрузка данных,
// главные показатели, карточки платформ, воронка, бюджет, графики, таблица кампаний,
// помесячная таблица, CSV, автообновление.
// Данные вставляются в страницу только через textContent (без innerHTML).
// Источник данных — ./api.js: API сервера или расшифрованный файл данных (GitHub Pages).
import { api } from './api.js';
import * as charts from './charts.js';
import { buildCsv } from './csv.js';
import { addMonths, diffDays, isIsoDate, presetRange } from './dates.js';
import * as fmt from './format.js';
import {
  AGE_ORDER, breakdownLabel, BUBBLE_METRICS, extraMetric, shopifyValue, delta, KPI_ORDER, METRICS, PLATFORM_LABELS, SUM_METRICS, tone, value,
} from './metrics.js';

const $ = (id) => document.getElementById(id);

const BRAND_LABELS = { FF: 'FF', DITA: 'DITA', OPTICA: 'OPTICA' };

// Вкладки: обзор всех платформ или страница одной платформы. На странице платформы — свои
// главные показатели и подписи (как в отчётах Looker по каждой платформе).
const ALL_METRICS = KPI_ORDER;
const TRAFFIC_METRICS = ['spend', 'impressions', 'clicks', 'ctr', 'cpc', 'cpm'];
const VIEWS = {
  // Обзор: ряд показателей — группами Visibility / Engagement / Conversion (BL_ROWS), как в Looker.
  overview: {
    hero: ['roas', 'revenue'], kpis: ['revenue', 'impressions', 'clicks', 'ctr', 'cpc', 'cpm'], rows: true,
    metrics: ALL_METRICS, results: ['conversions', 'cpa'], labels: {},
  },
  meta: {
    hero: ['roas', 'cpa', 'conversions'], kpis: ['revenue', 'impressions', 'clicks', 'ctr', 'cpc', 'cpm'],
    metrics: ALL_METRICS, results: ['conversions', 'cpa'],
    labels: { spend: 'Amount spent', conversions: 'Purchases', cpa: 'Cost per purchase', clicks: 'Link clicks', cpc: 'CPC (link)', ctr: 'CTR (link)', revenue: 'Purchase value' },
  },
  google: {
    hero: ['roas', 'cpa', 'conversions'], kpis: ['revenue', 'impressions', 'clicks', 'ctr', 'cpc', 'cpm'],
    metrics: ALL_METRICS, results: ['conversions', 'cpa'],
    labels: { spend: 'Cost', cpc: 'Avg. CPC', cpa: 'Cost / conv.', revenue: 'Conv. value' },
  },
  admixer: {
    hero: ['cpm', 'ctr', 'clicks'], kpis: ['impressions', 'cpc', 'active'],
    metrics: TRAFFIC_METRICS, results: ['clicks', 'cpc'], labels: {},
  },
};
// Вкладка Shopify: свои блоки (renderShopify); для общих функций — как обзор.
VIEWS.shopify = { ...VIEWS.overview, rows: false };
// Вкладка Omnisend (push-кампании): свои блоки (renderOmnisend).
VIEWS.omnisend = { ...VIEWS.overview, rows: false };
// Вкладка SEO (Search Console): свои блоки (renderSeo).
VIEWS.seo = { ...VIEWS.overview, rows: false };
// Вкладка SMS / Viber (Data Edge): свои блоки (renderDataEdge).
VIEWS.dataedge = { ...VIEWS.overview, rows: false };
// Вкладки не рекламных платформ: свои данные и блоки, фильтры платформ и бренда не действуют.
const OWN_VIEWS = ['shopify', 'omnisend', 'seo', 'dataedge'];

const PLATFORM_CARD_METRICS = { meta: ['roas', 'cpa', 'ctr'], google: ['roas', 'cpa', 'ctr'], admixer: ['cpm', 'ctr', 'cpc'] };

const view = () => VIEWS[state.view];
const label = (k) => view().labels[k] ?? METRICS[k]?.label ?? k;
const labelsFor = (keys) => Object.fromEntries(keys.map((k) => [k, label(k)]));

const STATUS_LABELS = {
  current: { on_track: 'On track', over: 'Forecast: overspend', under: 'Forecast: underspend', no_plan: 'No plan' },
  past: { on_track: 'Result: on plan', over: 'Result: overspend', under: 'Result: underspend', no_plan: 'No plan' },
  future: { future: 'Month not started', no_plan: 'No plan' },
};

const state = {
  view: 'overview',
  config: null,
  filters: null,
  summary: null,
  daily: null,
  days: null,
  campaigns: null,
  budget: null,
  monthly: null,
  breakdowns: null, // разбивки Meta: { publisher_platform, device_platform } из /api/breakdown
  shopify: null, // /api/shopify — вкладка Shopify
  shopProducts: null, // /api/shopify/products
  shopSearch: '',
  omnisend: null, // /api/omnisend — вкладка Omnisend
  omSearch: '',
  omSort: { key: 'sent', dir: 'desc' },
  ga: null, // /api/ga4 — раздел GA4 на обзоре
  gsc: null, // /api/gsc — вкладка SEO
  dataedge: null, // /api/dataedge — вкладка SMS / Viber
  ahrefs: null, // /api/ahrefs — раздел Ahrefs на вкладке SEO
  ahSearch: '',
  ahSort: { key: 'traffic', dir: 'desc' },
  deSearch: '',
  deSort: { key: 'date', dir: 'desc' },
  gscMetrics: ['gsc_clicks', 'gsc_impressions'],
  gscSearch: '',
  gscSort: { query: { key: 'impressions', dir: 'desc' }, page: { key: 'impressions', dir: 'desc' }, country: { key: 'impressions', dir: 'desc' } },
  placements: null, // /api/admixer/placements — вкладка Admixer
  placementsSearch: '',
  placementsSort: { key: 'impressions', dir: 'desc' },
  creatives: null, // /api/admixer/creatives — вкладка Admixer
  creativesSearch: '',
  creativesSort: { key: 'impressions', dir: 'desc' },
  status: null,
  sort: { key: 'spend', dir: 'desc' },
  search: '',
  errors: [],
  lastLoad: 0,
};

// ---------- Утилиты DOM ----------

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const child of children) if (child !== null && child !== undefined) node.append(child);
  return node;
}

function fillSelect(select, keys, selected) {
  const keep = keys.includes(select.value) ? select.value : selected;
  select.replaceChildren(...keys.map((k) => el('option', { value: k, text: label(k), selected: k === keep })));
}

function fillMetricSelects() {
  const keys = view().metrics;
  fillSelect($('daily-metric'), keys, 'spend');
  fillSelect($('share-metric'), keys.filter((k) => SUM_METRICS.includes(k)), 'spend');
  fillSelect($('compare-metric'), keys, 'spend');
  fillSelect($('bubble-metric'), BUBBLE_METRICS.filter((k) => keys.includes(k)), keys.includes('cpa') ? 'cpa' : 'cpm');
}

// ---------- Фильтры ----------

function readFilters() {
  const preset = $('period').value;
  const today = state.config.today;
  let range = presetRange(preset, today);
  if (preset === 'custom') range = { from: $('from').value, to: $('to').value };
  // Shopify: рекламный расход для MER — все платформы.
  const platforms = state.view === 'overview'
    ? [...document.querySelectorAll('input[name="platform"]:checked')].map((i) => i.value)
    : OWN_VIEWS.includes(state.view) ? Object.keys(PLATFORM_LABELS) : [state.view];
  const compare = features().yoy ? $('compare').value : 'prev';
  return { preset, ...range, platforms, brand: OWN_VIEWS.includes(state.view) ? '' : $('brand').value, compare };
}

const features = () => state.config?.features ?? {};
const maxRangeDays = () => features().maxRangeDays ?? 731;

function validateFilters(f) {
  if (!isIsoDate(f.from) || !isIsoDate(f.to)) return 'Enter both period dates.';
  if (f.from > f.to) return 'Start date is after end date.';
  if (diffDays(f.from, f.to) + 1 > maxRangeDays()) return `The period cannot be longer than ${maxRangeDays()} days.`;
  if (f.platforms.length === 0) return 'Select at least one platform.';
  return null;
}

function apiParams(f) {
  const p = { from: f.from, to: f.to, platforms: f.platforms.join(',') };
  if (f.brand) p.brand = f.brand;
  if (f.compare === 'yoy') p.compare = 'yoy';
  return p;
}

// GA4: свой шаг графика; бренд и платформы GA4 не делит.
function gaParams(params) {
  const g = $('ga-granularity').value;
  return g === 'auto' ? params : { ...params, granularity: g };
}

function dailyParams(f) {
  const g = features().granularity ? $('granularity').value : 'day';
  return g === 'auto' ? apiParams(f) : { ...apiParams(f), granularity: g };
}

// Фильтры сохраняются в адресе страницы — ссылкой можно поделиться.
function saveFiltersToUrl(f) {
  const p = new URLSearchParams({ period: f.preset });
  if (state.view === 'overview') p.set('platforms', f.platforms.join(','));
  else p.set('view', state.view);
  if (f.preset === 'custom') { p.set('from', f.from); p.set('to', f.to); }
  if (f.brand) p.set('brand', f.brand);
  if (f.compare === 'yoy') p.set('compare', 'yoy');
  if (features().granularity && $('granularity').value !== 'auto') p.set('step', $('granularity').value);
  window.history.replaceState(null, '', `?${p}`);
}

function restoreViewFromUrl() {
  const v = new URLSearchParams(window.location.search).get('view');
  if (Object.hasOwn(VIEWS, v)) state.view = v;
}

function restoreFiltersFromUrl() {
  const p = new URLSearchParams(window.location.search);
  const period = p.get('period');
  if ([...$('period').options].some((o) => o.value === period)) $('period').value = period;
  if (isIsoDate(p.get('from'))) $('from').value = p.get('from');
  if (isIsoDate(p.get('to'))) $('to').value = p.get('to');
  if (p.has('platforms')) {
    const list = p.get('platforms').split(',');
    for (const box of document.querySelectorAll('input[name="platform"]')) box.checked = list.includes(box.value);
  }
  const brand = p.get('brand');
  if (brand && Object.hasOwn(BRAND_LABELS, brand)) $('brand').value = brand;
  if (features().yoy && p.get('compare') === 'yoy') $('compare').value = 'yoy';
  const step = p.get('step');
  if (features().granularity && ['day', 'week', 'month'].includes(step)) $('granularity').value = step;
}

function syncPeriodInputs() {
  const custom = $('period').value === 'custom';
  $('from-field').hidden = !custom;
  $('to-field').hidden = !custom;
  if (custom && (!$('from').value || !$('to').value)) {
    const r = presetRange('this_month', state.config.today);
    $('from').value ||= r.from;
    $('to').value ||= r.to;
  }
  const f = readFilters();
  $('period-hint').textContent = isIsoDate(f.from) && isIsoDate(f.to) ? `${fmt.date(f.from)} — ${fmt.date(f.to)}` : '';
}

// ---------- Отрисовка ----------

// Свежесть данных: один значок «All sources» со временем последнего обновления (все источники и их
// время — в подсказке); отдельно — только источники с ошибкой или давно не обновлявшиеся.
// Неподключённые (no runs yet) — только в подсказке.
function renderSources() {
  const list = $('sources');
  if (!state.status) return;
  const STATE_TEXT = { ok: 'up to date', stale: 'not updated for a while', error: 'last run failed', never: 'not connected' };
  const line = (s) => `${s.label}: ${STATE_TEXT[s.state]}${s.lastOkAt ? `, last update ${fmt.dateTime(s.lastOkAt)}` : ''}`;
  const sources = state.status.sources;
  const problems = sources.filter((s) => s.state === 'error' || s.state === 'stale');
  const ok = sources.filter((s) => s.state === 'ok');
  const last = ok.map((s) => s.lastOkAt).filter(Boolean).sort().at(-1);
  const chips = problems.map((s) => {
    const title = line(s);
    return el('li', { class: 'source', dataset: { state: s.state }, title, 'aria-label': title },
      el('span', { class: 'dot', 'aria-hidden': 'true' }),
      el('span', { text: s.label }),
      el('span', { class: 'state', text: s.state === 'error' ? 'error' : `since ${s.lastOkAt ? fmt.dateTime(s.lastOkAt) : '—'}` }));
  });
  if (ok.length) {
    const title = sources.map(line).join('\n');
    chips.push(el('li', { class: 'source', dataset: { state: 'ok' }, title, 'aria-label': title.replace(/\n/g, '; ') },
      el('span', { class: 'dot', 'aria-hidden': 'true' }),
      el('span', { text: problems.length ? 'Other sources' : 'All sources' }),
      el('span', { class: 'state', text: last ? fmt.time(last) : '' })));
  }
  list.replaceChildren(...chips);
}

function renderAlerts() {
  const alerts = [];
  const f = state.filters;
  const s = state.summary;
  // Покупки Meta проверяются по данным: предупреждение — только если за период (от 3 дней,
  // иначе утром «сегодня» ещё без покупок) был расход, но ни одной покупки.
  if (s && f.platforms.includes('meta') && state.view !== 'shopify') {
    const meta = s.current.byPlatform.meta;
    if (meta && meta.spend > 0 && meta.conversions === 0 && s.period.days >= 3) {
      alerts.push(['warn', state.config.metaPurchaseConfigured
        ? 'Meta: no purchases in the period despite spend — check the Purchase event. Meta ROAS and CPA may not be meaningful.'
        : 'Meta: no purchases in the period despite spend — the Purchase event may not be configured. Meta ROAS and CPA are not meaningful.']);
    }
  }
  if (state.view === 'dataedge' && state.dataedge?.smsError) {
    alerts.push(['warn', `Data Edge SMS data is not updating since ${fmt.dateTime(state.dataedge.smsError.since)}: the Data Edge API returns an error for the SMS mailing list (on their side). Viber data is up to date.`]);
  }
  const gaps = Object.entries(state.config?.fxGaps ?? {}).filter(([, n]) => n > 0);
  if (gaps.length) {
    const names = { breakdowns: 'breakdowns', placements: 'Admixer placements', omnisend: 'Omnisend' };
    alerts.push(['warn', `Some ${gaps.map(([k]) => names[k] ?? k).join(', ')} data has no NBM exchange rate — those amounts are not counted in MDL. Check the “NBM rates” source.`]);
  }
  if (s && s.current.missingFx > 0 && state.view !== 'shopify') {
    alerts.push(['warn', `${fmt.int(s.current.missingFx)} statistics rows have no NBM exchange rate — their spend and revenue are not counted in MDL. Check the “NBM rates” source.`]);
  }
  if (state.campaigns?.truncated && state.view !== 'shopify') {
    alerts.push(['warn', 'More than 2,000 campaigns — the table shows the 2,000 with the highest spend. Narrow the period or filters.']);
  }
  for (const e of state.errors) alerts.push(['error', e]);
  $('alerts').replaceChildren(...alerts.map(([kind, text]) => el('div', { class: 'alert', dataset: { kind }, role: kind === 'error' ? 'alert' : null },
    el('span', { class: 'icon', 'aria-hidden': 'true', text: kind === 'error' ? '×' : '!' }),
    el('span', { text }))));
}

function deltaInfo(key, cur, prev) {
  const d = delta(cur, prev);
  const arrow = d === null || d === 0 ? '' : d > 0 ? '▲ ' : '▼ ';
  const page = { shopify: state.shopify, omnisend: state.omnisend, seo: state.gsc, dataedge: state.dataedge }[state.view] ?? state.summary;
  const yoy = page?.period?.compare === 'yoy';
  return {
    tone: tone(key, d),
    text: d === null ? 'no data to compare' : `${arrow}${fmt.signedPct(d)} ${yoy ? 'vs last year' : 'vs previous period'}`,
    short: d === null ? fmt.DASH : `${arrow}${fmt.signedPct(d)}`,
  };
}

// Активные кампании — с расходом или показами за период (только по таблице кампаний).
function activeCampaigns() {
  return state.campaigns ? state.campaigns.rows.filter((r) => r.spend > 0 || r.impressions > 0).length : null;
}

function prevTitle(key, prev) {
  const s = state.summary.period;
  return `${s.compare === 'yoy' ? 'Last year' : 'Previous period'} (${fmt.date(s.prevFrom)} — ${fmt.date(s.prevTo)}): ${METRICS[key].format(prev)}`;
}

const NATIVE_TITLE = 'Spend in the ad account currency, without conversion — the same amount as in Meta, Google Ads or Admixer';

function renderHero() {
  const s = state.summary;
  if (!s) return;
  const spend = s.current.total.spend;
  const sub = el('div', { class: 'hero-sub' });
  const d = deltaInfo('spend', spend, s.previous.total.spend);
  sub.append(el('span', { class: 'delta', dataset: { tone: d.tone }, text: d.text }));
  const b = state.budget;
  if (b && b.mode === 'current' && b.total.plan > 0 && state.filters.to.slice(0, 7) === b.month?.slice(0, 7)) {
    sub.append(' · ', el('b', { text: `${fmt.pct(b.total.fact / b.total.plan, 0)} of monthly plan` }),
      ` · ${STATUS_LABELS.current[b.total.status] ?? ''}`);
  }
  const native = fmt.nativeMoney(s.current.native?.total);
  const main = el('div', { class: 'hero-main' },
    el('div', { class: 'hero-label', text: `${label('spend')} · ${fmt.date(s.period.from)} — ${fmt.date(s.period.to)}` }),
    el('div', { class: 'hero-value', title: prevTitle('spend', s.previous.total.spend) }, fmt.int(Math.round(spend)), el('small', { text: 'MDL' })),
    native ? el('div', { class: 'hero-native', title: NATIVE_TITLE, text: `${native} — in ad account currencies` }) : null,
    sub);
  const kpis = el('div', { class: 'hero-kpis' }, ...view().hero.map((key) => {
    const cur = value(key, s.current.total);
    const prev = value(key, s.previous.total);
    const info = deltaInfo(key, cur, prev);
    return el('div', { class: 'hero-kpi', title: prevTitle(key, prev) },
      el('div', { class: 'label', text: label(key) }),
      el('div', { class: 'value', text: METRICS[key].format(cur) }),
      el('div', { class: 'delta', dataset: { tone: info.tone }, text: info.text }));
  }));
  $('hero').replaceChildren(main, kpis);
}

function renderKpis() {
  const s = state.summary;
  if (!s) return;
  if (view().rows) {
    $('kpis').className = 'bl-rows';
    $('kpis').replaceChildren(...BL_ROWS.map(([title, keys]) => el('div', { class: 'bl-row' },
      el('h3', { text: title }), el('div', { class: 'kpis' }, ...keys.map((key) => adsKpi(key, s))))));
    return;
  }
  $('kpis').className = 'kpis';
  const cards = view().kpis.map((key) => {
    if (key === 'active') {
      const n = activeCampaigns();
      return el('article', { class: 'kpi' },
        el('div', { class: 'label', text: 'Active campaigns' }),
        el('div', { class: 'value', text: n === null ? fmt.DASH : fmt.int(n) }),
        el('div', { class: 'delta', text: 'with spend or impressions' }));
    }
    const cur = value(key, s.current.total);
    const prev = value(key, s.previous.total);
    const info = deltaInfo(key, cur, prev);
    return el('article', { class: 'kpi', title: prevTitle(key, prev) },
      el('div', { class: 'label', text: label(key) }),
      el('div', { class: 'value', text: METRICS[key].format(cur) }),
      el('div', { class: 'delta', dataset: { tone: info.tone }, text: info.text }));
  });
  $('kpis').replaceChildren(...cards);
}

function renderPlatforms() {
  const s = state.summary;
  $('platforms-section').hidden = state.view !== 'overview';
  if (!s || state.view !== 'overview') return;
  const total = s.current.total.spend;
  $('platforms').replaceChildren(...state.filters.platforms.map((p) => {
    const cur = s.current.byPlatform[p];
    const prev = s.previous.byPlatform[p];
    const share = total > 0 ? cur.spend / total : 0;
    const info = deltaInfo('spend', cur.spend, prev.spend);
    const native = fmt.nativeMoney(s.current.native?.byPlatform?.[p]);
    const fill = el('div', { class: `swatch-${p}` });
    fill.style.width = `${(share * 100).toFixed(1)}%`;
    const card = el('button', { class: 'platform-card', type: 'button', dataset: { view: p }, title: `Open the ${PLATFORM_LABELS[p]} page` },
      el('div', { class: 'head' },
        el('span', { class: `swatch swatch-${p}`, 'aria-hidden': 'true' }),
        el('span', { class: 'name', text: PLATFORM_LABELS[p] }),
        el('span', { class: 'share', text: fmt.pct(share, 1) })),
      el('div', {}, el('div', { class: 'spend', text: fmt.money(cur.spend) }),
        native ? el('div', { class: 'native', title: NATIVE_TITLE, text: native }) : null,
        el('div', { class: 'delta', dataset: { tone: info.tone }, text: info.text })),
      el('div', { class: 'track', 'aria-hidden': 'true' }, fill),
      el('div', { class: 'metrics' }, ...PLATFORM_CARD_METRICS[p].map((k) => el('div', {},
        el('div', { class: 'label', text: METRICS[k].label }),
        el('div', { class: 'value', text: METRICS[k].format(value(k, cur)) })))));
    return card;
  }));
}

// ---------- Разбивки: площадки и устройства Meta, устройства и возраст Google Ads ----------

// metric — показатель диаграммы и доли на карточках. Клики — как в отчётах Looker: у площадок Meta
// «Clicks (all)», у устройств Meta — клики по ссылке. group — объединение значений в карточки
// (Google Ads: Mobile и Others), order — порядок значений (возраст — по возрасту), table — значения
// таблицей, а не карточками (возраст: 7 групп).
const BREAKDOWNS = {
  publisher_platform: { view: 'meta', metric: 'impressions', clicksKey: 'clicksAll', clicksLabel: 'Clicks (all)' },
  device_platform: { view: 'meta', metric: 'impressions', clicksKey: 'clicks', clicksLabel: 'Link clicks' },
  device: { view: 'google', metric: 'impressions', clicksKey: 'clicks', clicksLabel: 'Clicks', group: (v) => (v === 'mobile' ? 'mobile' : 'others') },
  age_range: { view: 'google', metric: 'clicks', clicksKey: 'clicks', clicksLabel: 'Clicks', order: AGE_ORDER, table: true },
};
const breakdownsFor = (view) => Object.keys(BREAKDOWNS).filter((dim) => BREAKDOWNS[dim].view === view);

const BD_MIN_SHARE = 0.0001;

// Сумма строк разбивки в одну (объединение значений в карточку).
function sumBreakdownRows(value, rows) {
  const sum = (part) => rows.reduce((acc, r) => {
    for (const [k, v] of Object.entries(r[part])) acc[k] = (acc[k] ?? 0) + v;
    return acc;
  }, {});
  return { value, current: sum('current'), previous: sum('previous') };
}

// Показатель карточки: подпись, значение и изменение к прошлому периоду.
function bdMetric(labelText, key, cur, prev) {
  const info = deltaInfo(key, cur, prev);
  return el('div', {},
    el('div', { class: 'label', text: labelText }),
    el('div', { class: 'value', text: METRICS[key].format(cur) }),
    el('div', { class: 'delta', dataset: { tone: info.tone }, text: info.short }));
}

// Карточка — как карточка платформы на обзоре: маркер, название, доля, полоса доли, показатели.
function bdCard(dim, cfg, r, share) {
  const color = charts.breakdownCssColor(r.value);
  const swatch = el('span', { class: 'swatch', 'aria-hidden': 'true' });
  swatch.style.background = color;
  const fill = el('div');
  fill.style.width = `${(share * 100).toFixed(1)}%`;
  fill.style.background = color;
  const ctr = (x) => (x.impressions > 0 ? x[cfg.clicksKey] / x.impressions : null);
  const ctrInfo = deltaInfo('ctr', ctr(r.current), ctr(r.previous));
  return el('div', { class: 'platform-card static' },
    el('div', { class: 'head' },
      swatch,
      el('span', { class: 'name', text: breakdownLabel(r.value, dim) }),
      el('span', { class: 'share', text: fmt.pct(share, 1) })),
    el('div', { class: 'track', 'aria-hidden': 'true' }, fill),
    el('div', { class: 'metrics' },
      bdMetric('Impressions', 'impressions', r.current.impressions, r.previous.impressions),
      bdMetric(cfg.clicksLabel, 'clicks', r.current[cfg.clicksKey], r.previous[cfg.clicksKey]),
      el('div', {},
        el('div', { class: 'label', text: 'CTR' }),
        el('div', { class: 'value', text: METRICS.ctr.format(ctr(r.current)) }),
        el('div', { class: 'delta', dataset: { tone: ctrInfo.tone }, text: ctrInfo.short }))));
}

// Строка таблицы разбивки (возраст): значение, клики, доля, изменение кликов, показы, CTR.
function bdTableRow(dim, r, total) {
  const swatch = el('span', { class: 'swatch', 'aria-hidden': 'true' });
  swatch.style.background = charts.breakdownCssColor(r.value);
  const info = deltaInfo('clicks', r.current.clicks, r.previous.clicks);
  return el('tr', {},
    el('td', {}, swatch, ` ${breakdownLabel(r.value, dim)}`),
    el('td', { text: fmt.int(r.current.clicks) }),
    el('td', { text: fmt.pct(total > 0 ? r.current.clicks / total : null, 1) }),
    el('td', {}, el('span', { class: 'delta', dataset: { tone: info.tone }, text: info.short })),
    el('td', { text: fmt.int(r.current.impressions) }),
    el('td', { text: METRICS.ctr.format(r.current.impressions > 0 ? r.current.clicks / r.current.impressions : null) }));
}

function renderBreakdowns() {
  const bd = state.breakdowns;
  const dims = breakdownsFor(state.view);
  const show = dims.length > 0 && bd && dims.some((dim) => bd[dim]?.available);
  $('breakdown-section').hidden = !show;
  if (!show) return;
  let dataFrom = null;
  let hidden = 0;
  let ageCoverage = null;
  for (const card of document.querySelectorAll('[data-breakdown]')) card.hidden = !dims.includes(card.dataset.breakdown);
  for (const dim of dims) {
    const cfg = BREAKDOWNS[dim];
    const b = bd[dim];
    const all = b?.available ? [...b.rows] : [];
    if (cfg.order) all.sort((x, y) => cfg.order.indexOf(x.value) - cfg.order.indexOf(y.value));
    if (b?.dataFrom && (!dataFrom || b.dataFrom > dataFrom)) dataFrom = b.dataFrom;
    const m = cfg.metric;
    const total = all.reduce((sum, r) => sum + r.current[m], 0);
    // Значения с долей меньше BD_MIN_SHARE (единичные показы «Other», Messenger без показов) — шум.
    const rows = all.filter((r) => total > 0 && r.current[m] / total >= BD_MIN_SHARE);
    hidden += all.length - rows.length;
    if (dim === 'age_range' && b?.platformTotal?.clicks > 0) ageCoverage = total / b.platformTotal.clicks;
    charts.breakdown(`chart-bd-${dim}`, m, rows, dim);
    // Подписи диаграммы — название и доля (значения — на карточках, в таблице и в подсказке диаграммы).
    $(`bd-legend-${dim}`).replaceChildren(...rows.map((r) => {
      const swatch = el('span', { class: 'swatch', 'aria-hidden': 'true' });
      swatch.style.background = charts.breakdownCssColor(r.value);
      return el('li', {}, swatch, el('span', { text: breakdownLabel(r.value, dim) }),
        el('span', { class: 'num', text: fmt.pct(r.current[m] / total, 1) }));
    }));
    if (cfg.table) {
      $(`bd-table-${dim}`).tBodies[0].replaceChildren(...rows.map((r) => bdTableRow(dim, r, total)));
      continue;
    }
    let cards = rows;
    if (cfg.group) {
      const groups = new Map();
      for (const r of all) groups.set(cfg.group(r.value), [...(groups.get(cfg.group(r.value)) ?? []), r]);
      cards = [...groups].map(([value, list]) => sumBreakdownRows(value, list)).filter((r) => r.current[m] > 0);
    }
    $(`bd-${dim}`).hidden = cards.length === 0;
    $(`bd-${dim}`).replaceChildren(...cards.map((r) => bdCard(dim, cfg, r, total > 0 ? r.current[m] / total : 0)));
  }
  const f = state.filters;
  const prev = state.summary?.period.compare === 'yoy' ? 'last year' : 'the previous period';
  const parts = state.view === 'google'
    ? ['Device: share of impressions; Others — computers, tablets and TV screens.',
      `Age: share of clicks${ageCoverage === null ? '' : `; age data covers ${fmt.pct(Math.min(ageCoverage, 1), 0)} of Google Ads clicks in the period — campaigns without age reporting are not included`}.`]
    : ['Share of impressions.'];
  parts.push(`Changes vs ${prev}.`);
  if (hidden) parts.push(`Values under ${fmt.pct(BD_MIN_SHARE, 2)} are not shown.`);
  parts.push(`Breakdown data is available from ${fmt.date(dataFrom)}${dataFrom && f.from < dataFrom ? ' — the beginning of the period is not included' : ''}.`);
  $('breakdown-note').textContent = parts.join(' ');
}

// ---------- Площадки Admixer (вкладка Admixer) ----------

const PLACEMENTS_ROWS = 500;
const ratioOf = (a, b) => (b > 0 ? a / b : null);

// Строки по выбранной группировке: сайт × профиль, сайты или профили.
function placementRows() {
  const p = state.placements;
  if (!p?.available) return [];
  const group = $('placements-group').value;
  let rows = p.rows;
  if (group !== 'pair') {
    const acc = new Map();
    for (const r of rows) {
      const k = group === 'domain' ? r.domain : `${r.profile}|${r.campaign}`;
      const a = acc.get(k) ?? {
        domain: group === 'domain' ? r.domain : '', profile: group === 'profile' ? r.profile : '', campaign: group === 'profile' ? r.campaign : '',
        sites: 0, impressions: 0, clicks: 0, spend: 0, spendNative: 0, viewable: 0,
      };
      a.sites++;
      for (const f of ['impressions', 'clicks', 'spend', 'spendNative', 'viewable']) a[f] += r[f];
      acc.set(k, a);
    }
    rows = [...acc.values()];
  }
  const q = state.placementsSearch.trim().toLocaleLowerCase('ru');
  if (q) rows = rows.filter((r) => r.domain.includes(q) || r.profile.toLocaleLowerCase('ru').includes(q));
  const col = placementColumns().find((c) => c.key === state.placementsSort.key) ?? placementColumns().find((c) => c.key === 'impressions');
  const dir = state.placementsSort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = col.get(a);
    const vb = col.get(b);
    if (va === null || va === undefined) return 1;
    if (vb === null || vb === undefined) return -1;
    if (col.type === 'text') return dir * String(va).localeCompare(String(vb), 'ru');
    return dir * (va - vb);
  });
}

function placementColumns() {
  const group = $('placements-group').value;
  const cur = state.placements?.currency ?? 'EUR';
  const cols = [];
  if (group !== 'profile') {
    cols.push({ key: 'domain', title: 'Site', type: 'text', get: (r) => r.domain, cell: (r) => el('td', { class: 'text name', text: r.domain }) });
  }
  if (group !== 'domain') {
    cols.push({
      key: 'profile', title: 'Profile', type: 'text', get: (r) => r.profile,
      cell: (r) => el('td', { class: 'text name', text: r.profile, title: r.campaign ? `Campaign: ${r.campaign}` : undefined }),
    });
  }
  if (group !== 'pair') {
    cols.push({ key: 'sites', title: group === 'domain' ? 'Profiles' : 'Sites', type: 'number', get: (r) => r.sites, cell: (r) => el('td', { text: fmt.int(r.sites) }) });
  }
  const metric = (key, title, get, format) => ({ key, title, type: 'number', get, cell: (r) => el('td', { text: format(get(r)) }) });
  cols.push(
    metric('impressions', 'Impressions', (r) => r.impressions, fmt.int),
    metric('clicks', 'Clicks', (r) => r.clicks, fmt.int),
    metric('ctr', 'CTR', (r) => ratioOf(r.clicks, r.impressions), METRICS.ctr.format),
    metric('cpm', 'CPM', (r) => ratioOf(r.spend * 1000, r.impressions), fmt.money2),
    metric('cpc', 'CPC', (r) => ratioOf(r.spend, r.clicks), fmt.money2),
    metric('viewability', 'Viewability', (r) => ratioOf(r.viewable, r.impressions), (v) => fmt.pct(v, 1)),
    metric('spend', 'Spend', (r) => r.spend, fmt.money2),
    metric('spendNative', `Spend, ${cur}`, (r) => r.spendNative, (v) => (typeof v === 'number' ? `${fmt.ratio(v)} ${cur}` : fmt.DASH)),
  );
  return cols;
}

function renderPlacements() {
  const p = state.placements;
  const show = state.view === 'admixer' && Boolean(p?.available);
  $('placements-section').hidden = !show;
  if (!show) return;
  const columns = placementColumns();
  $('placements-table').tHead.rows[0].replaceChildren(...columns.map((c) => {
    const sorted = state.placementsSort.key === c.key;
    return el('th', {
      scope: 'col',
      class: `sortable${c.type === 'text' ? ' text' : ''}`,
      'aria-sort': sorted ? (state.placementsSort.dir === 'asc' ? 'ascending' : 'descending') : 'none',
    }, el('button', { type: 'button', dataset: { key: c.key }, text: c.title }));
  }));
  const rows = placementRows();
  const body = $('placements-table').tBodies[0];
  if (rows.length === 0) {
    body.replaceChildren(el('tr', {}, el('td', { colspan: columns.length, class: 'text muted', text: 'No placement data for the selected period' })));
  } else {
    const frag = document.createDocumentFragment();
    for (const r of rows.slice(0, PLACEMENTS_ROWS)) frag.append(el('tr', {}, ...columns.map((c) => c.cell(r))));
    body.replaceChildren(frag);
  }
  $('placements-count').textContent = `(${fmt.int(rows.length)})`;
  const notes = ['Admixer statistics of profiles (ad sets) by site. Spend, CPM and CPC — in MDL at the NBM rate; '
    + `Spend, ${p.currency} — as in the Admixer account. Viewability — share of viewable impressions.`];
  if (p.mode === 'monthly' && p.months) {
    notes.push(`Totals for whole months: ${fmt.monthName(p.months[0])} — ${fmt.monthName(p.months[1])} (data by day is available from ${fmt.date(p.dailyFrom)}).`);
  }
  if (rows.length > PLACEMENTS_ROWS) notes.push(`Showing the first ${fmt.int(PLACEMENTS_ROWS)} rows — use search or download CSV for the full list.`);
  if (p.truncated) notes.push(`More than ${fmt.int(p.rows.length)} rows — the list is limited to the ones with the most impressions.`);
  if (p.dataFrom && state.filters.from.slice(0, 7) < p.dataFrom) notes.push(`Placement data is available from ${fmt.monthName(p.dataFrom)}.`);
  $('placements-note').textContent = notes.join(' ');
}

// ---------- Креативы Admixer (баннеры) ----------

function creativeColumns() {
  const cur = state.creatives?.currency ?? 'EUR';
  const metric = (key, title, get, format) => ({ key, title, type: 'number', get, cell: (r) => el('td', { text: format(get(r)) }) });
  return [
    { key: 'creative', title: 'Creative', type: 'text', get: (r) => r.profile, cell: (r) => el('td', { class: 'text name', text: r.profile, title: r.profile }) },
    { key: 'size', title: 'Size', type: 'text', get: (r) => r.domain, cell: (r) => el('td', { class: 'text', text: r.domain }) },
    { key: 'campaign', title: 'Campaign', type: 'text', get: (r) => r.campaign, cell: (r) => el('td', { class: 'text name', text: r.campaign || fmt.DASH, title: r.campaign || undefined }) },
    { key: 'brand', title: 'Brand', type: 'text', get: (r) => r.brand, cell: (r) => el('td', { class: 'text', text: BRAND_LABELS[r.brand] ?? r.brand ?? fmt.DASH }) },
    metric('impressions', 'Impressions', (r) => r.impressions, fmt.int),
    metric('clicks', 'Clicks', (r) => r.clicks, fmt.int),
    metric('ctr', 'CTR', (r) => ratioOf(r.clicks, r.impressions), METRICS.ctr.format),
    metric('cpm', 'CPM', (r) => ratioOf(r.spend * 1000, r.impressions), fmt.money2),
    metric('cpc', 'CPC', (r) => ratioOf(r.spend, r.clicks), fmt.money2),
    metric('viewability', 'Viewability', (r) => ratioOf(r.viewable, r.impressions), (v) => fmt.pct(v, 1)),
    metric('spend', 'Spend', (r) => r.spend, fmt.money2),
    metric('spendNative', `Spend, ${cur}`, (r) => r.spendNative, (v) => (typeof v === 'number' ? `${fmt.ratio(v)} ${cur}` : fmt.DASH)),
  ];
}

function creativeRows() {
  const p = state.creatives;
  if (!p?.available) return [];
  const q = state.creativesSearch.trim().toLocaleLowerCase('ru');
  const rows = q ? p.rows.filter((r) => `${r.profile} ${r.domain} ${r.campaign}`.toLocaleLowerCase('ru').includes(q)) : p.rows;
  const col = creativeColumns().find((c) => c.key === state.creativesSort.key) ?? creativeColumns()[4];
  const dir = state.creativesSort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = col.get(a);
    const vb = col.get(b);
    if (va === null || va === undefined) return 1;
    if (vb === null || vb === undefined) return -1;
    if (col.type === 'text') return dir * String(va).localeCompare(String(vb), 'ru');
    return dir * (va - vb);
  });
}

function renderCreatives() {
  const p = state.creatives;
  const show = state.view === 'admixer' && Boolean(p?.available);
  $('creatives-section').hidden = !show;
  if (!show) return;
  const columns = creativeColumns();
  $('creatives-table').tHead.rows[0].replaceChildren(...columns.map((c) => el('th', {
    scope: 'col', class: `sortable${c.type === 'text' ? ' text' : ''}`,
    'aria-sort': state.creativesSort.key === c.key ? (state.creativesSort.dir === 'asc' ? 'ascending' : 'descending') : 'none',
  }, el('button', { type: 'button', dataset: { key: c.key }, text: c.title }))));
  const rows = creativeRows();
  const body = $('creatives-table').tBodies[0];
  if (!rows.length) {
    body.replaceChildren(el('tr', {}, el('td', { colspan: columns.length, class: 'text muted', text: 'No creative data for the selected period' })));
  } else {
    const frag = document.createDocumentFragment();
    for (const r of rows.slice(0, PLACEMENTS_ROWS)) frag.append(el('tr', {}, ...columns.map((c) => c.cell(r))));
    body.replaceChildren(frag);
  }
  $('creatives-count').textContent = `(${fmt.int(rows.length)})`;
  const notes = ['Admixer statistics by creative (banner). Campaign — through the profile (ad set) with the most impressions of the creative. '
    + `Spend, CPM and CPC — in MDL at the NBM rate; Spend, ${p.currency} — as in the Admixer account. Viewability — share of viewable impressions.`];
  if (p.mode === 'monthly' && p.months) {
    notes.push(`Totals for whole months: ${fmt.monthName(p.months[0])} — ${fmt.monthName(p.months[1])} (data by day is available from ${fmt.date(p.dailyFrom)}).`);
  }
  if (p.dataFrom && state.filters.from.slice(0, 7) < p.dataFrom) notes.push(`Creative data is available from ${fmt.monthName(p.dataFrom)}.`);
  $('creatives-note').textContent = notes.join(' ');
}

function exportCreativesCsv() {
  const columns = creativeColumns().map((c) => (c.type === 'text'
    ? { title: c.title, type: 'text', value: c.get }
    : { title: ['spend', 'cpm', 'cpc'].includes(c.key) ? `${c.title}, MDL` : c.title, type: 'number', digits: ['impressions', 'clicks'].includes(c.key) ? 0 : 4, value: c.get }));
  download(buildCsv(columns, creativeRows()), `ff-ads-admixer-creatives_${state.filters.from}_${state.filters.to}.csv`);
}

function exportPlacementsCsv() {
  const rows = placementRows();
  const columns = placementColumns().map((c) => (c.type === 'text'
    ? { title: c.title, type: 'text', value: c.get }
    : { title: ['spend', 'cpm', 'cpc'].includes(c.key) ? `${c.title}, MDL` : c.title, type: 'number', digits: ['impressions', 'clicks', 'sites'].includes(c.key) ? 0 : 4, value: c.get }));
  download(buildCsv(columns, rows), `ff-ads-admixer-placements_${state.filters.from}_${state.filters.to}.csv`);
}

// ---------- Вкладка Shopify ----------

// Как в Looker: главный блок — продажи, заказы, средний чек и MER; ряд — остальные показатели магазина;
// ниже — реклама и трафик.
const SHOP_HERO = ['shop_orders', 'shop_aov', 'shop_mer'];
const SHOP_KPIS = ['shop_qty', 'shop_discounts', 'shop_customers', 'shop_returns', 'shop_qty_returned', 'shop_new_customers'];
const SHOP_ADS = ['shop_ad_spend', 'shop_cpo', 'shop_sessions', 'shop_cr'];
const SHOP_TABLE_ROWS = 300;
const SOURCE_LABELS = { direct: 'Direct', search: 'Search', social: 'Social', email: 'Email', unknown: 'Other' };
const sourceLabel = (v) => SOURCE_LABELS[v] ?? v.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
const CUSTOMERS_TITLE = 'Unique customers are counted for standard periods (This month, Last month, Last 7/30/90 days, '
  + 'This quarter, Last 3/6/12 months, This year, Last year); for a custom period — not available';

function shopPrevTitle(key, prev) {
  const p = ({ omnisend: state.omnisend, overview: state.ga, seo: state.gsc, dataedge: state.dataedge }[state.view] ?? state.shopify).period;
  return `${p.compare === 'yoy' ? 'Last year' : 'Previous period'} (${fmt.date(p.prevFrom)} — ${fmt.date(p.prevTo)}): ${extraMetric(key).format(prev)}`;
}

function shopKpi(key, s, cls = 'kpi') {
  const cur = shopifyValue(key, s.current);
  const prev = shopifyValue(key, s.previous);
  const info = deltaInfo(key, cur, prev);
  const title = key === 'shop_customers' && cur === null ? CUSTOMERS_TITLE : shopPrevTitle(key, prev);
  return el(cls === 'kpi' ? 'article' : 'div', { class: cls, title },
    el('div', { class: 'label', text: extraMetric(key).label }),
    el('div', { class: 'value', text: extraMetric(key).format(cur) }),
    el('div', { class: 'delta', dataset: { tone: info.tone }, text: cur === null ? 'standard periods only' : info.text }));
}

function visibleProducts() {
  const rows = state.shopProducts?.rows ?? [];
  const q = state.shopSearch.trim().toLowerCase();
  return q ? rows.filter((r) => r.title.toLowerCase().includes(q)) : rows;
}

function renderShopProducts() {
  const p = state.shopProducts;
  const rows = visibleProducts();
  $('shop-products-count').textContent = p?.available ? `(${fmt.int(rows.length)})` : '';
  $('shop-products').tBodies[0].replaceChildren(...rows.slice(0, SHOP_TABLE_ROWS).map((r) => el('tr', {},
    el('td', { class: 'name', text: r.title }),
    el('td', { text: fmt.int(r.orders) }),
    el('td', { text: fmt.int(r.quantity) }),
    el('td', { text: fmt.money2(r.sales) }))));
  const notes = [];
  if (p?.mode === 'monthly' && p.months) {
    notes.push(`Totals for whole months: ${fmt.monthName(p.months[0])} — ${fmt.monthName(p.months[1])} (product data by day is available from ${fmt.date(p.dailyFrom)}).`);
  }
  if (rows.length > SHOP_TABLE_ROWS) notes.push(`Showing ${fmt.int(SHOP_TABLE_ROWS)} products with the highest sales — use search or download CSV for the full list.`);
  if (p?.truncated) notes.push(`More than ${fmt.int(p.rows.length)} products — the list is limited to the ones with the highest sales.`);
  $('shop-products-note').textContent = notes.join(' ');
}

function renderShopifyCharts() {
  const s = state.shopify;
  if (state.view !== 'shopify' || !s?.available) return;
  charts.shopCombo('chart-shop-sales', s.series, 'shop_sales', 'shop_orders');
  charts.shopLines('chart-shop-orders', s.series, ['shop_orders']);
  charts.shopLines('chart-shop-aov', s.series, ['shop_aov']);
  charts.shopLines('chart-shop-returns', s.series, ['shop_sales', 'shop_returns']);
  const sources = s.referrer.filter((r) => r.current.sales > 0);
  charts.shopSources('chart-shop-sources', sources, sourceLabel);
  const total = sources.reduce((sum, r) => sum + r.current.sales, 0);
  $('shop-sources-legend').replaceChildren(...sources.map((r, i) => {
    const swatch = el('span', { class: 'swatch', 'aria-hidden': 'true' });
    swatch.style.background = charts.shopSourceCssColor(i);
    return el('li', { title: `${fmt.money(r.current.sales)} · ${fmt.int(r.current.orders)} orders` }, swatch,
      el('span', { text: sourceLabel(r.source) }), el('span', { class: 'num', text: fmt.pct(r.current.sales / total, 1) }));
  }));
}

function renderShopify() {
  const s = state.shopify;
  $('shopify-section').hidden = false;
  if (!s?.available) {
    $('hero').replaceChildren(el('div', { class: 'hero-main' },
      el('div', { class: 'hero-label', text: 'Shopify' }),
      el('div', { class: 'hero-sub', text: 'No Shopify data yet — the store is not connected or the first update has not run.' })));
    $('kpis').replaceChildren();
    $('shopify-section').hidden = true;
    return;
  }
  const sales = s.current.total_sales;
  const d = deltaInfo('shop_sales', sales, s.previous.total_sales);
  $('hero').replaceChildren(
    el('div', { class: 'hero-main' },
      el('div', { class: 'hero-label', text: `Total sales · ${fmt.date(s.period.from)} — ${fmt.date(s.period.to)}` }),
      el('div', { class: 'hero-value', title: shopPrevTitle('shop_sales', s.previous.total_sales) }, fmt.int(Math.round(sales)), el('small', { text: 'MDL' })),
      el('div', { class: 'hero-sub' }, el('span', { class: 'delta', dataset: { tone: d.tone }, text: d.text }))),
    el('div', { class: 'hero-kpis' }, ...SHOP_HERO.map((key) => shopKpi(key, s, 'hero-kpi'))));
  $('kpis').replaceChildren(...SHOP_KPIS.map((key) => shopKpi(key, s)));
  $('shop-kpis-ads').replaceChildren(...SHOP_ADS.map((key) => shopKpi(key, s)));
  renderShopifyCharts();
  renderShopProducts();
  $('shop-note').textContent = 'Store metrics — as in Shopify Analytics (MDL). Avg. order value — (gross sales − discounts) / orders. '
    + 'Discounts and returns are shown as positive amounts. MER — total sales per 1 MDL of ad spend (Meta, Google Ads, Admixer, all brands). '
    + `Conversion rate — sessions that completed checkout / sessions. Shopify data is available from ${fmt.date(s.dataFrom)}.`;
}

function exportShopProductsCsv() {
  const f = state.filters;
  const columns = [
    { title: 'Product', type: 'text', value: (r) => r.title },
    { title: 'Orders', type: 'number', digits: 0, value: (r) => r.orders },
    { title: 'Ordered quantity', type: 'number', digits: 0, value: (r) => r.quantity },
    { title: 'Total sales, MDL', type: 'number', digits: 2, value: (r) => r.sales },
  ];
  download(buildCsv(columns, visibleProducts()), `ff-shopify-produse_${f.from}_${f.to}.csv`);
}

// Воронка: показы → клики → конверсии. Ширина полос — в логарифмической шкале,
// иначе клики и конверсии на фоне миллионов показов не видны.
// ---------- Вкладка Omnisend (push-кампании) ----------

// Как в Looker: главный блок — отправки, открытия, open rate, click rate; ряд — остальные показатели;
// ниже — заказы и выручка, графики, таблица кампаний, доли, дни недели и устройства.
const OM_HERO = ['om_opened', 'om_open_rate', 'om_click_rate'];
const OM_KPIS = ['om_campaigns', 'om_clicked', 'om_ctor', 'om_unsub_rate', 'om_bounces', 'om_complaint_rate'];
const OM_SALES = ['om_orders', 'om_revenue', 'om_rps', 'om_unsubscribed'];
const OM_SHARE_TOP = 9;
const OM_DEVICE_LABELS = { Mobile: 'Mobile', Desktop: 'Desktop', Tablet: 'Tablet' };
const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function omColumns() {
  const num = (key, title, get, format) => ({ key, title, type: 'number', get, cell: (r) => el('td', { text: format(get(r)) }) });
  const m = (key) => extraMetric(key);
  return [
    { key: 'name', title: 'Campaign name', type: 'text', get: (r) => r.name, cell: (r) => el('td', { class: 'text name', text: r.name, title: `ID ${r.id}` }) },
    { key: 'date', title: 'Sent', type: 'text', get: (r) => r.date, cell: (r) => el('td', { text: fmt.date(r.date) }) },
    num('sent', 'Sends', (r) => r.sent, fmt.int),
    num('opened', 'Opens', (r) => r.opened, fmt.int),
    num('openRate', 'Open rate', (r) => m('om_open_rate').calc(r), fmt.pct),
    num('clicked', 'Clicks', (r) => r.clicked, fmt.int),
    num('clickRate', 'Click rate', (r) => m('om_click_rate').calc(r), fmt.pct),
    num('ctor', 'CTOR', (r) => m('om_ctor').calc(r), fmt.pct),
    num('unsubscribed', 'Unsubscribes', (r) => r.unsubscribed, fmt.int),
    num('failed', 'Bounces', (r) => r.failed, fmt.int),
    num('orders', 'Orders', (r) => r.orders, fmt.int),
    num('revenue', 'Revenue', (r) => r.revenue, fmt.money),
  ];
}

function omRows() {
  const q = state.omSearch.trim().toLocaleLowerCase('ru');
  const rows = (state.omnisend?.campaigns ?? []).filter((r) => !q || r.name.toLocaleLowerCase('ru').includes(q));
  const col = omColumns().find((c) => c.key === state.omSort.key) ?? omColumns().find((c) => c.key === 'sent');
  const dir = state.omSort.dir === 'asc' ? 1 : -1;
  return rows.sort((a, b) => {
    const va = col.get(a);
    const vb = col.get(b);
    if (va === null || va === undefined) return 1;
    if (vb === null || vb === undefined) return -1;
    if (col.type === 'text') return dir * String(va).localeCompare(String(vb), 'ru');
    return dir * (va - vb);
  });
}

function renderOmCampaigns() {
  const columns = omColumns();
  $('om-campaigns').tHead.rows[0].replaceChildren(...columns.map((c) => {
    const sorted = state.omSort.key === c.key;
    return el('th', {
      scope: 'col',
      class: `sortable${c.type === 'text' ? ' text' : ''}`,
      'aria-sort': sorted ? (state.omSort.dir === 'asc' ? 'ascending' : 'descending') : 'none',
    }, el('button', { type: 'button', dataset: { key: c.key }, text: c.title }));
  }));
  const rows = omRows();
  const body = $('om-campaigns').tBodies[0];
  if (rows.length === 0) {
    body.replaceChildren(el('tr', {}, el('td', { colspan: columns.length, class: 'text muted', text: 'No push campaigns sent in the selected period' })));
  } else {
    const frag = document.createDocumentFragment();
    for (const r of rows) frag.append(el('tr', {}, ...columns.map((c) => c.cell(r))));
    body.replaceChildren(frag);
  }
  const total = state.omnisend?.campaigns.length ?? 0;
  $('om-campaigns-count').textContent = rows.length === total ? `(${total})` : `(${rows.length} of ${total})`;
}

// Устройства — как «Platform performance» в Looker: открытия и клики, доли — от всех отправок периода.
function omDeviceCard(d, s, total) {
  const color = charts.omCampaignColor({ Mobile: 0, Desktop: 1, Tablet: 2 }[d.type] ?? 4);
  const swatch = el('span', { class: 'swatch', 'aria-hidden': 'true' });
  swatch.style.background = color;
  const share = total > 0 ? d.current.opened / total : 0;
  const fill = el('div');
  fill.style.width = `${(share * 100).toFixed(1)}%`;
  fill.style.background = color;
  const rate = (x, sent) => (sent > 0 ? x / sent : null);
  const metric = (labelText, key, cur, prev, format) => {
    const info = deltaInfo(key, cur, prev);
    return el('div', {},
      el('div', { class: 'label', text: labelText }),
      el('div', { class: 'value', text: format(cur) }),
      el('div', { class: 'delta', dataset: { tone: info.tone }, text: info.short }));
  };
  return el('div', { class: 'platform-card static' },
    el('div', { class: 'head' }, swatch, el('span', { class: 'name', text: OM_DEVICE_LABELS[d.type] ?? 'Other' }),
      el('span', { class: 'share', title: 'Share of opens', text: fmt.pct(share, 1) })),
    el('div', { class: 'track', 'aria-hidden': 'true' }, fill),
    el('div', { class: 'metrics two' },
      metric('Opens', 'om_opened', d.current.opened, d.previous.opened, fmt.int),
      metric('Open rate', 'om_open_rate', rate(d.current.opened, s.current.sent), rate(d.previous.opened, s.previous.sent), fmt.pct),
      metric('Clicks', 'om_clicked', d.current.clicked, d.previous.clicked, fmt.int),
      metric('Click rate', 'om_click_rate', rate(d.current.clicked, s.current.sent), rate(d.previous.clicked, s.previous.sent), fmt.pct)));
}

function renderOmnisendCharts() {
  const s = state.omnisend;
  if (state.view !== 'omnisend' || !s?.available) return;
  charts.shopCombo('chart-om-sends', s.series, 'om_opened', 'om_sent');
  charts.shopLines('chart-om-open-rate', s.series, ['om_open_rate'], { spanGaps: true });
  charts.shopLines('chart-om-click-rate', s.series, ['om_click_rate'], { spanGaps: true });
  charts.shopLines('chart-om-bounce-rate', s.series, ['om_bounce_rate'], { spanGaps: true });
  // Доли открытий: первые OM_SHARE_TOP кампаний и «Other».
  const sorted = [...s.campaigns].filter((r) => r.opened > 0).sort((a, b) => b.opened - a.opened);
  const share = sorted.slice(0, OM_SHARE_TOP).map((r) => ({ label: r.name, value: r.opened }));
  const rest = sorted.slice(OM_SHARE_TOP).reduce((sum, r) => sum + r.opened, 0);
  if (rest > 0) share.push({ label: 'Other', value: rest });
  charts.omCampaigns('chart-om-share', share);
  const total = share.reduce((sum, r) => sum + r.value, 0);
  $('om-share-legend').replaceChildren(...share.map((r, i) => {
    const swatch = el('span', { class: 'swatch', 'aria-hidden': 'true' });
    swatch.style.background = charts.omCampaignColor(i);
    return el('li', { title: `${r.label}: ${fmt.int(r.value)} opens` }, swatch,
      el('span', { text: r.label }), el('span', { class: 'num', text: fmt.pct(r.value / total, 1) }));
  }));
}

function renderOmnisend() {
  const s = state.omnisend;
  $('omnisend-section').hidden = false;
  if (!s?.available) {
    $('hero').replaceChildren(el('div', { class: 'hero-main' },
      el('div', { class: 'hero-label', text: 'Omnisend' }),
      el('div', { class: 'hero-sub', text: 'No Omnisend data yet — the API key is not set or the first update has not run.' })));
    $('kpis').replaceChildren();
    $('omnisend-section').hidden = true;
    return;
  }
  const sent = s.current.sent;
  const d = deltaInfo('om_sent', sent, s.previous.sent);
  $('hero').replaceChildren(
    el('div', { class: 'hero-main' },
      el('div', { class: 'hero-label', text: `Push sends · ${fmt.date(s.period.from)} — ${fmt.date(s.period.to)}` }),
      el('div', { class: 'hero-value', title: shopPrevTitle('om_sent', s.previous.sent) }, fmt.int(sent)),
      el('div', { class: 'hero-sub' }, el('span', { class: 'delta', dataset: { tone: d.tone }, text: d.text }))),
    el('div', { class: 'hero-kpis' }, ...OM_HERO.map((key) => shopKpi(key, s, 'hero-kpi'))));
  $('kpis').replaceChildren(...OM_KPIS.map((key) => shopKpi(key, s)));
  $('om-kpis-sales').replaceChildren(...OM_SALES.map((key) => shopKpi(key, s)));
  renderOmnisendCharts();
  renderOmCampaigns();
  const m = (key, w) => extraMetric(key).calc(w);
  $('om-weekdays').tBodies[0].replaceChildren(...s.weekdays.filter((w) => w.sent > 0).map((w) => el('tr', {},
    el('td', { text: WEEKDAY_NAMES[w.weekday] }),
    el('td', { text: fmt.int(w.campaigns) }),
    el('td', { text: fmt.int(w.sent) }),
    el('td', { text: fmt.pct(m('om_open_rate', w)) }),
    el('td', { text: fmt.pct(m('om_click_rate', w)) }),
    el('td', { text: fmt.pct(m('om_ctor', w)) }),
    el('td', { text: fmt.money2(m('om_rps', w)) }))));
  const devices = s.devices.filter((x) => x.current.opened > 0 || x.previous.opened > 0);
  // Как в Looker — Mobile и Desktop; планшеты и неопределённые — одной карточкой Other.
  const main = devices.filter((x) => x.type === 'Mobile' || x.type === 'Desktop');
  const other = devices.filter((x) => x.type !== 'Mobile' && x.type !== 'Desktop')
    .reduce((acc, x) => {
      for (const p of ['current', 'previous']) for (const k of ['opened', 'clicked']) acc[p][k] += x[p][k];
      return acc;
    }, { type: 'Other', current: { opened: 0, clicked: 0 }, previous: { opened: 0, clicked: 0 } });
  const cards = other.current.opened > 0 ? [...main, other] : main;
  const totalOpens = devices.reduce((sum, x) => sum + x.current.opened, 0);
  $('om-devices').replaceChildren(...cards.map((x) => omDeviceCard(x, s, totalOpens)));
  $('om-note').textContent = `Omnisend push campaigns, grouped by send date — as in Omnisend reports. Rates are shares of sends; `
    + 'CTOR — clicks / opens. Orders and revenue — attributed to the campaigns by Omnisend'
    + `${s.currency === 'MDL' ? '' : ` (converted from ${s.currency} to MDL at the NBM rate)`}. `
    + 'Platform performance — opens and clicks by device on the day they happened (Omnisend statistics), rates — of all sends in the period. '
    + `Omnisend data is available from ${fmt.date(s.dataFrom)}.`;
}

function exportOmnisendCsv() {
  const columns = omColumns().map((c) => (c.type === 'text'
    ? { title: c.title, type: 'text', value: c.get }
    : { title: c.key === 'revenue' ? 'Revenue, MDL' : c.title, type: 'number', digits: ['openRate', 'clickRate', 'ctor'].includes(c.key) ? 4 : 2, value: c.get }));
  download(buildCsv(columns, omRows()), `ff-ads-omnisend-push_${state.filters.from}_${state.filters.to}.csv`);
}

// ---------- Вкладка SMS / Viber (Data Edge) ----------

const DE_HERO = ['de_delivered', 'de_delivery_rate', 'de_cost'];
const DE_KPIS = ['de_mailings', 'de_read', 'de_read_rate', 'de_cpd'];
const DE_LABELS = { sms: 'SMS', viber: 'Viber' };
const DE_TYPE_LABELS = { web: 'campaigns sent from the Data Edge account', api: 'messages sent through the API (notifications, codes)', all: 'all mailings' };
const DE_TABLE_ROWS = 1000;

function deChannelCell(channel) {
  const swatch = el('span', { class: 'swatch', 'aria-hidden': 'true' });
  swatch.style.background = getComputedStyle(document.documentElement).getPropertyValue(channel === 'sms' ? '--accent' : '--dataedge').trim();
  return el('span', { class: 'de-channel' }, swatch, DE_LABELS[channel]);
}

function deColumns() {
  const num = (key, title, get, format) => ({ key, title, type: 'number', get, cell: (r) => el('td', { text: format(get(r)) }) });
  const m = (key) => extraMetric(key);
  return [
    { key: 'date', title: 'Sent', type: 'text', get: (r) => r.date, cell: (r) => el('td', { text: fmt.date(r.date) }) },
    { key: 'channel', title: 'Channel', type: 'text', get: (r) => r.channel, cell: (r) => el('td', { class: 'text' }, deChannelCell(r.channel)) },
    { key: 'name', title: 'Mailing', type: 'text', get: (r) => r.name, cell: (r) => el('td', { class: 'text name', text: r.name, title: r.name }) },
    { key: 'sender', title: 'Sender', type: 'text', get: (r) => r.sender || (r.channel === 'viber' ? 'Viber' : ''), cell: (r) => el('td', { class: 'text', text: r.sender || fmt.DASH }) },
    num('sent', 'Sent', (r) => r.sent, fmt.int),
    num('delivered', 'Delivered', (r) => r.delivered, fmt.int),
    num('rate', 'Delivery rate', (r) => m('de_delivery_rate').calc(r), fmt.pct),
    num('read', 'Read', (r) => r.read, fmt.int),
    num('readRate', 'Read rate', (r) => (r.channel === 'viber' ? m('de_read_rate').calc(r) : null), fmt.pct),
    num('cost', 'Cost, MDL', (r) => r.cost, fmt.money),
    num('costNative', `Cost, ${state.dataedge?.currency ?? 'EUR'}`, (r) => r.costNative, (v) => fmt.currency(v, state.dataedge?.currency ?? 'EUR')),
  ];
}

function deRows() {
  const q = state.deSearch.trim().toLocaleLowerCase('ru');
  const rows = (state.dataedge?.mailings ?? []).filter((r) => !q || `${r.name} ${r.sender}`.toLocaleLowerCase('ru').includes(q));
  const col = deColumns().find((c) => c.key === state.deSort.key) ?? deColumns()[0];
  const dir = state.deSort.dir === 'asc' ? 1 : -1;
  return rows.sort((a, b) => {
    const va = col.get(a);
    const vb = col.get(b);
    if (va === null || va === undefined) return 1;
    if (vb === null || vb === undefined) return -1;
    if (col.type === 'text') return dir * String(va).localeCompare(String(vb), 'ru');
    return dir * (va - vb);
  });
}

function renderDeMailings() {
  const columns = deColumns();
  $('de-mailings').tHead.rows[0].replaceChildren(...columns.map((c) => el('th', {
    scope: 'col',
    class: `sortable${c.type === 'text' ? ' text' : ''}`,
    'aria-sort': state.deSort.key === c.key ? (state.deSort.dir === 'asc' ? 'ascending' : 'descending') : 'none',
  }, el('button', { type: 'button', dataset: { key: c.key }, text: c.title }))));
  const rows = deRows();
  const body = $('de-mailings').tBodies[0];
  if (!rows.length) {
    body.replaceChildren(el('tr', {}, el('td', { colspan: columns.length, class: 'text muted', text: 'No mailings in the selected period' })));
  } else {
    const frag = document.createDocumentFragment();
    for (const r of rows.slice(0, DE_TABLE_ROWS)) frag.append(el('tr', {}, ...columns.map((c) => c.cell(r))));
    body.replaceChildren(frag);
  }
  const total = state.dataedge?.mailings.length ?? 0;
  $('de-mailings-count').textContent = rows.length === total ? `(${total})` : `(${rows.length} of ${total})`;
}

function renderDataEdgeCharts() {
  const s = state.dataedge;
  if (state.view !== 'dataedge' || !s?.available) return;
  charts.deSent('chart-de-sent', s.series);
}

function renderDataEdge() {
  const s = state.dataedge;
  $('dataedge-section').hidden = false;
  if (!s?.available) {
    $('hero').replaceChildren(el('div', { class: 'hero-main' },
      el('div', { class: 'hero-label', text: 'SMS / Viber' }),
      el('div', { class: 'hero-sub', text: 'No Data Edge data yet — the API key (DATAEDGE_TOKEN) is not set or the first update has not run.' })));
    $('kpis').replaceChildren();
    $('dataedge-section').hidden = true;
    return;
  }
  const d = deltaInfo('de_sent', s.current.sent, s.previous.sent);
  $('hero').replaceChildren(
    el('div', { class: 'hero-main' },
      el('div', { class: 'hero-label', text: `Messages sent · ${fmt.date(s.period.from)} — ${fmt.date(s.period.to)}` }),
      el('div', { class: 'hero-value', title: shopPrevTitle('de_sent', s.previous.sent) }, fmt.int(s.current.sent)),
      el('div', { class: 'hero-sub' }, el('span', { class: 'delta', dataset: { tone: d.tone }, text: d.text }))),
    el('div', { class: 'hero-kpis' }, ...DE_HERO.map((key) => shopKpi(key, s, 'hero-kpi'))));
  const balance = s.balance
    ? el('article', { class: 'kpi', title: `Data Edge balance at ${fmt.dateTime(s.balance.at)}` },
      el('div', { class: 'label', text: 'Balance' }),
      el('div', { class: 'value', text: fmt.currency(s.balance.sms, s.balance.currency) }),
      el('div', { class: 'delta', text: s.balance.viber ? `Viber: ${fmt.currency(s.balance.viber, s.balance.currency)}` : `at ${fmt.dateTime(s.balance.at)}` }))
    : null;
  $('kpis').replaceChildren(...DE_KPIS.map((key) => shopKpi(key, s)), balance);
  renderDataEdgeCharts();
  const m = (key, x) => extraMetric(key).calc(x);
  $('de-channels').tBodies[0].replaceChildren(...s.channels.map((c) => {
    const cell = (key, fmtv) => {
      const cur = m(key, c.current);
      const info = deltaInfo(key, cur, m(key, c.previous));
      return el('td', { title: info.text }, fmtv(cur), el('div', { class: 'muted small', dataset: { tone: info.tone }, text: info.short }));
    };
    return el('tr', {},
      el('td', { class: 'text' }, deChannelCell(c.channel)),
      cell('de_mailings', fmt.int), cell('de_sent', fmt.int), cell('de_delivered', fmt.int), cell('de_delivery_rate', fmt.pct),
      c.channel === 'viber' ? cell('de_read', fmt.int) : el('td', { class: 'muted', text: fmt.DASH }),
      c.channel === 'viber' ? cell('de_read_rate', fmt.pct) : el('td', { class: 'muted', text: fmt.DASH }),
      cell('de_cost', fmt.money), cell('de_cpd', fmt.money2));
  }));
  renderDeMailings();
  const pending = s.current.pending;
  $('de-note').textContent = (s.smsError
    ? `SMS data is not updating: the Data Edge API returns an error for the SMS mailing list (since ${fmt.dateTime(s.smsError.since)}) — SMS figures are from the last successful update; Viber is up to date. `
    : '') + `Data Edge, ${DE_TYPE_LABELS[s.type]}; by send date. Delivery rate — delivered ÷ sent; read rate (Viber only) — read ÷ delivered. `
    + `Cost — in MDL at the NBM rate on the send date (account currency ${s.currency}); Viber cost is an estimate: price per message × messages sent `
    + '(the Data Edge API gives only the price) — check against the invoice. SMS cost is counted per SMS part. '
    + 'Clicks from SMS and Viber links are not available in the Data Edge API — see them in GA4 by UTM tags. '
    + (pending ? `Delivery data for ${fmt.int(pending)} Viber mailings is still loading — it will appear after the next updates. ` : '')
    + `Data Edge data is available from ${fmt.date(s.dataFrom)}.`;
}

function exportDataEdgeCsv() {
  const columns = deColumns().map((c) => ({ title: c.title, type: c.type, digits: ['rate', 'readRate'].includes(c.key) ? 4 : 2, value: c.get }));
  download(buildCsv(columns, deRows()), `ff-ads-sms-viber_${state.filters.from}_${state.filters.to}.csv`);
}

// ---------- Ahrefs (на вкладке SEO) ----------

const AH_RANK_KPIS = ['ah_avg_pos', 'ah_top3', 'ah_top10', 'ah_sov', 'ah_ai'];
const AH_SITE_KPIS = ['ah_dr', 'ah_refdomains', 'ah_traffic', 'ah_keywords'];
const AH_TABLE_ROWS = 1000;

function ahKpi(key, cur, prev, title) {
  const m = extraMetric(key);
  const c = cur ? m.calc(cur) : null;
  const p = prev ? m.calc(prev) : null;
  const info = deltaInfo(key, c, p);
  return el('article', { class: 'kpi', title },
    el('div', { class: 'label', text: m.label }),
    el('div', { class: 'value', text: m.format(c) }),
    el('div', { class: 'delta', dataset: { tone: info.tone }, text: info.short === fmt.DASH ? 'no data to compare' : `${info.short} ${title.split(':')[0]}` }));
}

// Изменение позиции слова: положительное — выросло (номер позиции уменьшился); выпало / появилось.
function ahChange(r) {
  if (r.position === null && r.previous === null) return null;
  if (r.position === null) return -1000;
  if (r.previous === null) return 1000;
  return r.previous - r.position;
}

function ahColumns() {
  const num = (key, title, get, format) => ({ key, title, type: 'number', get, cell: (r) => el('td', { text: format(get(r)) }) });
  return [
    {
      key: 'keyword', title: 'Keyword', type: 'text', get: (r) => r.keyword,
      cell: (r) => el('td', { class: 'text', title: r.keyword }, r.keyword, r.branded ? el('span', { class: 'gsc-tag', text: 'brand' }) : null),
    },
    num('position', 'Position', (r) => r.position, (v) => (v === null ? 'not ranking' : fmt.int(v))),
    {
      key: 'change', title: 'Change (30 days)', type: 'number', get: ahChange,
      cell: (r) => {
        const d = ahChange(r);
        if (d === null) return el('td', { class: 'muted', text: fmt.DASH });
        if (d === 1000) return el('td', { dataset: { tone: 'good' }, text: 'new' });
        if (d === -1000) return el('td', { dataset: { tone: 'bad' }, text: 'lost' });
        return el('td', { dataset: { tone: d > 0 ? 'good' : d < 0 ? 'bad' : 'neutral' }, text: d > 0 ? `▲ ${d}` : d < 0 ? `▼ ${-d}` : '0' });
      },
    },
    num('volume', 'Volume', (r) => r.volume, fmt.int),
    num('traffic', 'Traffic', (r) => r.traffic, fmt.int),
    { key: 'url', title: 'Page', type: 'text', get: (r) => r.url, cell: (r) => el('td', { class: 'text url', title: r.url, text: r.url ? r.url.replace(/^https?:\/\/[^/]+/, '') || '/' : fmt.DASH }) },
  ];
}

function ahRows() {
  const rows = state.ahrefs?.keywords?.rows ?? [];
  const q = state.ahSearch.trim().toLocaleLowerCase('ru');
  const filter = $('ah-filter').value;
  const ok = (r) => {
    const d = ahChange(r);
    if (filter === 'up') return d !== null && d > 0;
    if (filter === 'down') return d !== null && d < 0;
    if (filter === 'top10') return r.position !== null && r.position <= 10;
    if (filter === 'lost') return r.position === null;
    if (filter === 'brand') return r.branded;
    if (filter === 'nonbrand') return !r.branded;
    return true;
  };
  const col = ahColumns().find((c) => c.key === state.ahSort.key) ?? ahColumns()[4];
  const dir = state.ahSort.dir === 'asc' ? 1 : -1;
  return rows.filter((r) => ok(r) && (!q || `${r.keyword} ${r.url}`.toLocaleLowerCase('ru').includes(q))).sort((a, b) => {
    const va = col.get(a);
    const vb = col.get(b);
    if (va === null || va === undefined) return 1;
    if (vb === null || vb === undefined) return -1;
    if (col.type === 'text') return dir * String(va).localeCompare(String(vb), 'ru');
    return dir * (va - vb);
  });
}

function renderAhKeywords() {
  const columns = ahColumns();
  $('ah-keywords').tHead.rows[0].replaceChildren(...columns.map((c) => el('th', {
    scope: 'col', class: `sortable${c.type === 'text' ? ' text' : ''}`,
    'aria-sort': state.ahSort.key === c.key ? (state.ahSort.dir === 'asc' ? 'ascending' : 'descending') : 'none',
  }, el('button', { type: 'button', dataset: { key: c.key }, text: c.title }))));
  const rows = ahRows();
  const body = $('ah-keywords').tBodies[0];
  if (!rows.length) {
    body.replaceChildren(el('tr', {}, el('td', { colspan: columns.length, class: 'text muted', text: 'No keywords' })));
  } else {
    const frag = document.createDocumentFragment();
    for (const r of rows.slice(0, AH_TABLE_ROWS)) frag.append(el('tr', {}, ...columns.map((c) => c.cell(r))));
    body.replaceChildren(frag);
  }
  const total = state.ahrefs?.keywords?.rows.length ?? 0;
  const shown = Math.min(rows.length, AH_TABLE_ROWS);
  $('ah-keywords-count').textContent = rows.length === total ? `(${fmt.int(total)})` : `(${fmt.int(shown)} of ${fmt.int(rows.length)} matching, ${fmt.int(total)} total)`;
}

function renderAhrefsCharts() {
  const a = state.ahrefs;
  if (state.view !== 'seo' || !a?.available) return;
  charts.ahPositions('chart-ah-positions', a.rank.series);
  const rows = a.monthly.rows.slice(-24);
  charts.ahMonthly('chart-ah-traffic', rows.map((r) => ({ ...r, keywords: (r.top3 ?? 0) + (r.top4_10 ?? 0) + (r.top11 ?? 0) })),
    ['traffic', 'Organic traffic (est.)', '--gsc-clicks'], ['keywords', 'Ranking keywords', '--gsc-position']);
  charts.ahMonthly('chart-ah-links', rows, ['refdomains', 'Referring domains', '--gsc-impressions'], ['dr', 'Domain Rating', '--gsc-ctr']);
}

function renderAhrefs() {
  const a = state.ahrefs;
  $('ahrefs-block').hidden = !a?.available;
  if (!a?.available) return;
  const r = a.rank;
  const dayTitle = (d) => (d ? fmt.date(d) : '—');
  $('ah-rank-kpis').replaceChildren(...AH_RANK_KPIS.map((key) => ahKpi(key, r.current, r.previous,
    `vs ${dayTitle(r.prevDay)}: rankings on ${dayTitle(r.day)} (${a.device}) against ${dayTitle(r.prevDay)}`)));
  const mc = a.monthly.current;
  const mp = a.monthly.previous;
  $('ah-site-kpis').replaceChildren(...AH_SITE_KPIS.map((key) => ahKpi(key, mc, mp,
    `vs ${mp ? fmt.monthName(mp.month) : '—'}: ${mc ? fmt.monthName(mc.month) : '—'} against ${mp ? fmt.monthName(mp.month) : '—'}`)));
  const m = (key, x) => (x ? extraMetric(key).calc(x) : null);
  const compRow = (name, cur, prev, own) => {
    const cell = (key) => {
      const info = deltaInfo(key, m(key, cur), m(key, prev));
      return el('td', { title: info.text }, extraMetric(key).format(m(key, cur)),
        el('div', { class: 'muted small', dataset: { tone: info.tone }, text: info.short }));
    };
    return el('tr', { class: own ? 'own' : null }, el('td', { class: 'text', text: name }),
      cell('ah_sov'), cell('ah_avg_pos'), cell('ah_top3'), cell('ah_top10'), el('td', { text: fmt.int(cur?.traffic) }));
  };
  const comps = [...r.competitors].sort((x, y) => (y.current?.sov ?? 0) - (x.current?.sov ?? 0));
  $('ah-competitors').tBodies[0].replaceChildren(compRow(a.target, r.current, r.previous, true), ...comps.map((c) => compRow(c.name, c.current, c.previous, false)));
  renderAhrefsCharts();
  renderAhKeywords();
  const pages = a.pages?.rows ?? [];
  $('ah-pages-date').textContent = a.pages ? `(${fmt.date(a.pages.date)})` : '';
  $('ah-pages').tBodies[0].replaceChildren(...pages.map((p) => {
    const d = delta(p.traffic, p.previous);
    return el('tr', {},
      el('td', { class: 'text url', title: p.url, text: p.url.replace(/^https?:\/\/[^/]+/, '') || '/' }),
      el('td', { text: fmt.int(p.traffic) }),
      el('td', { dataset: { tone: d === null ? 'neutral' : d > 0 ? 'good' : d < 0 ? 'bad' : 'neutral' }, text: d === null ? fmt.DASH : fmt.signedPct(d) }),
      el('td', { text: fmt.int(p.keywords) }),
      el('td', { class: 'text', text: p.topKeyword || fmt.DASH }));
  }));
  $('ah-note').textContent = `Ahrefs, ${a.target}. Rankings — Rank Tracker project (${fmt.int(a.keywords?.rows.length ?? 0)} tracked keywords, ${a.device}): `
    + `values on the last day of the period with data (${dayTitle(r.day)}) against the last day of the comparison period (${dayTitle(r.prevDay)}). `
    + 'Share of voice — the share of estimated organic traffic for the tracked keywords that goes to the site; competitors — as set in the Rank Tracker project. '
    + `Tracked keywords and position change — the latest snapshot (${a.keywords ? fmt.date(a.keywords.date) : '—'}) against 30 days earlier. `
    + 'Site strength (Domain Rating, referring domains, organic traffic and ranking keywords) — Ahrefs estimates by month: the month of the end of the period against the previous month. '
    + 'Ahrefs traffic is a model estimate, not real visits — for real clicks see Search Console above. Data updates once a day; top pages — once a week.';
}

function exportAhrefsCsv() {
  const columns = ahColumns().map((c) => ({ title: c.title, type: c.type, digits: 0, value: c.key === 'change' ? (r) => {
    const d = ahChange(r);
    return d === 1000 || d === -1000 ? null : d;
  } : c.get }));
  download(buildCsv(columns, ahRows()), `ff-ads-ahrefs-keywords-${state.ahrefs?.device ?? 'mobile'}_${state.ahrefs?.keywords?.date ?? ''}.csv`);
}

// ---------- Вкладка SEO (Google Search Console) ----------

// Плитки как в отчёте «Эффективность» Search Console: включают линии на графике (кроме «Запросов»).
const GSC_TILES = [
  ['gsc_clicks', '--gsc-clicks'], ['gsc_impressions', '--gsc-impressions'], ['gsc_ctr', '--gsc-ctr'],
  ['gsc_position', '--gsc-position'], ['gsc_queries', null],
];
const GSC_DEVICE_LABELS = { MOBILE: 'Mobile', DESKTOP: 'Desktop', TABLET: 'Tablet' };
const GSC_TABLE_ROWS = 500;
// Страны Search Console — ISO 3166-1 alpha-3; названия — для частых, остальные кодом.
const GSC_COUNTRIES = {
  mda: 'Moldova', rou: 'Romania', rus: 'Russia', ukr: 'Ukraine', deu: 'Germany', ita: 'Italy', fra: 'France', gbr: 'United Kingdom',
  usa: 'United States', esp: 'Spain', isr: 'Israel', tur: 'Turkey', pol: 'Poland', bel: 'Belgium', nld: 'Netherlands', prt: 'Portugal',
  irl: 'Ireland', cze: 'Czechia', aut: 'Austria', che: 'Switzerland', can: 'Canada', blr: 'Belarus', kaz: 'Kazakhstan', bgr: 'Bulgaria',
  grc: 'Greece', hun: 'Hungary', swe: 'Sweden', dnk: 'Denmark', nor: 'Norway', fin: 'Finland', geo: 'Georgia', arm: 'Armenia', aze: 'Azerbaijan',
  zzz: 'Unknown region',
};
const gscCountry = (code) => GSC_COUNTRIES[code] ?? code.toUpperCase();
const gscPos = (s) => (s && s.impressions > 0 ? s.pos / s.impressions : null);
const gscCtr = (s) => (s && s.impressions > 0 ? s.clicks / s.impressions : null);

function gscBrandTest() {
  try {
    return new RegExp(state.gsc?.brandRegex ?? '$^', 'iu');
  } catch {
    return /$^/;
  }
}

function gscTile([key, token], s) {
  const cur = shopifyValue(key, s.current);
  const prev = shopifyValue(key, s.previous);
  const info = deltaInfo(key, cur, prev);
  const on = token ? state.gscMetrics.includes(key) : false;
  const title = key === 'gsc_queries'
    ? 'Unique queries with impressions — average per calendar month of the period (Search Console shows queries per month)'
    : shopPrevTitle(key, prev);
  const tile = el('button', { type: 'button', class: 'gsc-tile', 'aria-pressed': token ? String(on) : false, disabled: !token, title, dataset: { key } },
    el('span', { class: 'label' }, token ? el('span', { class: 'box', 'aria-hidden': 'true' }) : null, extraMetric(key).label),
    el('span', { class: 'value', text: extraMetric(key).format(cur) }),
    el('span', { class: 'delta', dataset: { tone: info.tone }, text: info.text }));
  // Цвет — через CSSOM (атрибут style запрещён политикой CSP).
  if (token) tile.style.setProperty('--c', `var(${token})`);
  return tile;
}

function gscSplitItem(name, swatchColor, big, sub, d) {
  const swatch = el('span', { class: 'swatch', 'aria-hidden': 'true' });
  swatch.style.background = swatchColor;
  return el('div', { class: 'item' },
    el('span', { class: 'name' }, swatch, name),
    el('span', { class: 'big', text: big }),
    el('span', { class: 'sub', text: sub }),
    d ? el('span', { class: 'sub', dataset: { tone: d.tone }, text: d.text }) : null);
}

function renderSeoCharts() {
  const s = state.gsc;
  if (state.view !== 'seo' || !s?.available) return;
  charts.gscPerformance('chart-gsc', s.series, GSC_TILES.filter(([k, t]) => t && state.gscMetrics.includes(k)));
  charts.shares('chart-gsc-devices', 'gsc_impressions', s.devices.map((d) => ({ label: GSC_DEVICE_LABELS[d.type], value: d.current.impressions })));
  charts.gscBrand('chart-gsc-brand', s.series);
}

function gscColumns(dim) {
  const name = {
    query: { title: 'Query', get: (r) => r.key },
    page: { title: 'Page', get: (r) => r.key.replace(/^https?:\/\/[^/]+/, '') || '/' },
    country: { title: 'Country', get: (r) => gscCountry(r.key) },
  }[dim];
  const num = (key, title, get, format) => ({ key, title, type: 'number', get, cell: (r) => el('td', { text: format(get(r)) }) });
  const brand = gscBrandTest();
  return [
    {
      key: 'key', title: name.title, type: 'text', get: name.get,
      cell: (r) => el('td', { class: 'text', title: r.key },
        name.get(r), dim === 'query' && brand.test(r.key) ? el('span', { class: 'gsc-tag', text: 'brand' }) : null),
    },
    num('clicks', 'Clicks', (r) => r.current.clicks, fmt.int),
    num('impressions', 'Impressions', (r) => r.current.impressions, fmt.int),
    num('ctr', 'CTR', (r) => gscCtr(r.current), fmt.pct),
    num('position', 'Position', (r) => gscPos(r.current), extraMetric('gsc_position').format),
    {
      key: 'change', title: 'Position change', type: 'number', get: (r) => {
        const a = gscPos(r.current);
        const b = gscPos(r.previous);
        return a === null || b === null ? null : b - a;
      },
      cell: (r) => {
        const a = gscPos(r.current);
        const b = gscPos(r.previous);
        if (a === null || b === null) return el('td', { class: 'muted', text: r.previous ? fmt.DASH : 'new' });
        const d = Math.round((b - a) * 10) / 10;
        return el('td', { dataset: { tone: d > 0 ? 'good' : d < 0 ? 'bad' : 'neutral' }, text: d > 0 ? `▲ ${fmt.num(d)}` : d < 0 ? `▼ ${fmt.num(-d)}` : '0' });
      },
    },
  ];
}

function gscRows(dim) {
  const t = state.gsc?.tables?.[dim];
  if (!t) return [];
  let rows = t.rows;
  if (dim === 'query') {
    const q = state.gscSearch.trim().toLocaleLowerCase('ru');
    const type = $('gsc-query-type').value;
    const brand = gscBrandTest();
    rows = rows.filter((r) => (!q || r.key.toLocaleLowerCase('ru').includes(q))
      && (type === 'all' || (type === 'brand') === brand.test(r.key)));
  }
  const sort = state.gscSort[dim];
  const col = gscColumns(dim).find((c) => c.key === sort.key) ?? gscColumns(dim)[2];
  const dir = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = col.get(a);
    const vb = col.get(b);
    if (va === null || va === undefined) return 1;
    if (vb === null || vb === undefined) return -1;
    if (col.type === 'text') return dir * String(va).localeCompare(String(vb), 'ru');
    return dir * (va - vb);
  });
}

function renderGscTable(dim, tableId, countId) {
  const columns = gscColumns(dim);
  const sort = state.gscSort[dim];
  $(tableId).tHead.rows[0].replaceChildren(...columns.map((c) => el('th', {
    scope: 'col',
    class: `sortable${c.type === 'text' ? ' text' : ''}`,
    'aria-sort': sort.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none',
  }, el('button', { type: 'button', dataset: { key: c.key }, text: c.title }))));
  const rows = gscRows(dim);
  const body = $(tableId).tBodies[0];
  if (!rows.length) {
    body.replaceChildren(el('tr', {}, el('td', { colspan: columns.length, class: 'text muted', text: 'No data for the selected period' })));
  } else {
    const frag = document.createDocumentFragment();
    for (const r of rows.slice(0, GSC_TABLE_ROWS)) frag.append(el('tr', {}, ...columns.map((c) => c.cell(r))));
    body.replaceChildren(frag);
  }
  if (countId) {
    const n = state.gsc.tables[dim].n;
    const shown = Math.min(rows.length, GSC_TABLE_ROWS);
    $(countId).textContent = `(${fmt.int(shown)}${n ? ` of ~${fmt.int(n)} per month` : ''})`;
  }
}

function renderSeo() {
  const s = state.gsc;
  $('seo-section').hidden = false;
  renderAhrefs();
  if (!s?.available) {
    $('gsc-tiles').replaceChildren(el('p', { class: 'muted', text: 'No Search Console data yet — the site is not set (GSC_SITE_URL) or the first update has not run.' }));
    return;
  }
  $('gsc-tiles').replaceChildren(...GSC_TILES.map((t) => gscTile(t, s)));
  // Устройства: показы и клики, доля показов; как «Platform performance» в Looker.
  const totalImpr = s.current.impressions;
  $('gsc-devices').replaceChildren(...s.devices.map((d, i) => gscSplitItem(
    GSC_DEVICE_LABELS[d.type], charts.omCampaignColor(i), `${fmt.int(d.current.clicks)} clicks`,
    `${fmt.pct(totalImpr > 0 ? d.current.impressions / totalImpr : null, 1)} of impressions · position ${extraMetric('gsc_position').format(gscPos(d.current))}`,
    deltaInfo('gsc_clicks', d.current.clicks, d.previous.clicks))));
  // Бренд и небрендовые: небрендовые — все клики, кроме брендовых (в том числе скрытые Google запросы).
  const b = s.brand;
  const nb = (x, t) => ({ clicks: t.clicks - x.clicks, impressions: t.impressions - x.impressions });
  const nbCur = nb(b.current, s.current);
  const nbPrev = nb(b.previous, s.previous);
  const share = (v, t) => fmt.pct(t > 0 ? v / t : null, 1);
  $('gsc-brand').replaceChildren(
    gscSplitItem('Brand', getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(), `${fmt.int(b.current.clicks)} clicks`,
      `${share(b.current.clicks, s.current.clicks)} of clicks · CTR ${fmt.pct(gscCtr(b.current), 1)} · pos. ${extraMetric('gsc_position').format(gscPos(b.current))}`,
      deltaInfo('gsc_clicks', b.current.clicks, b.previous.clicks)),
    gscSplitItem('Non-brand', getComputedStyle(document.documentElement).getPropertyValue('--google').trim(), `${fmt.int(nbCur.clicks)} clicks`,
      `${share(nbCur.clicks, s.current.clicks)} of clicks · CTR ${fmt.pct(gscCtr(nbCur), 1)}`,
      deltaInfo('gsc_clicks', nbCur.clicks, nbPrev.clicks)));
  renderSeoCharts();
  renderGscTable('query', 'gsc-queries', 'gsc-queries-count');
  renderGscTable('page', 'gsc-pages', 'gsc-pages-count');
  renderGscTable('country', 'gsc-countries', null);
  const p = s.period;
  const months = s.tables.months.map((m) => fmt.monthName(m)).join(', ');
  $('gsc-note').textContent = `Google Search Console, site ${s.site}, web search. `
    + (p.requestedTo !== p.to ? `Data is shown up to ${fmt.date(p.to)}: Google publishes Search Console data with a 2–3 day delay, and the comparison period has the same length. ` : '')
    + 'Average position is weighted by impressions (lower is better); CTR — clicks ÷ impressions. '
    + `Tables of queries, pages and countries — for whole calendar months of the period (${months || '—'}), the largest by impressions; `
    + 'position change — against the months of the comparison period. Google hides rare queries for privacy, so query rows add up to less than the totals. '
    + 'Brand queries — Farmacia Familiei, FF, ff.md, DITA, Optica Familiei (and the Russian spelling); non-brand — all other clicks, including hidden queries. '
    + `Search Console keeps 16 months of data; available from ${fmt.date(s.dataFrom)}.`;
}

function exportGscCsv() {
  const columns = gscColumns('query').map((c) => ({
    title: c.title, type: c.type, digits: c.key === 'ctr' ? 4 : c.key === 'position' || c.key === 'change' ? 1 : 0, value: c.get,
  }));
  download(buildCsv(columns, gscRows('query')), `ff-ads-search-queries_${state.filters.from}_${state.filters.to}.csv`);
}

// ---------- Обзор: ряды Visibility / Engagement / Conversion и раздел GA4 ----------

// Как в Looker: Visibility, Engagement, Conversion — суммы выбранных платформ и бренда (MDL).
const BL_ROWS = [
  ['Visibility', ['impressions', 'cpm']],
  ['Engagement', ['clicks', 'cpc', 'ctr']],
  ['Conversion', ['conversions', 'cpa', 'spend']],
];
const BL_LABELS = { impressions: 'Total impressions', cpm: 'Avg. CPM', clicks: 'Total clicks', cpc: 'Avg. CPC', ctr: 'Avg. CTR', conversions: 'All conversions', cpa: 'Avg. CPA', spend: 'Total spent' };
const GA_KPIS = ['ga_sessions', 'ga_purchases', 'ga_cr', 'ga_revenue', 'ga_aov'];
const GA_EVENT_LABELS = {
  page_view: 'Page view', view_item: 'View item', session_start: 'Session start', add_to_cart: 'Add to cart',
  begin_checkout: 'Begin checkout', add_payment_info: 'Add payment info', purchase: 'Purchase',
};
const GA_SHARE_TOP = 8;

function adsKpi(key, s) {
  const cur = value(key, s.current.total);
  const prev = value(key, s.previous.total);
  const info = deltaInfo(key, cur, prev);
  return el('article', { class: 'kpi', title: prevTitle(key, prev) },
    el('div', { class: 'label', text: BL_LABELS[key] }),
    el('div', { class: 'value', text: METRICS[key].format(cur) }),
    el('div', { class: 'delta', dataset: { tone: info.tone }, text: info.text }));
}

// Доли групп источников: сайты-партнёры — одной долей «Media» (как в Looker), ИИ-ассистенты — «AI»,
// первые GA_SHARE_TOP и «Other».
function gaShares(groups, field) {
  const sum = (list) => list.reduce((n, g) => n + g.current[field], 0);
  const media = sum(groups.filter((g) => g.media));
  const ai = sum(groups.filter((g) => g.ai));
  const list = groups.filter((g) => !g.media && !g.ai && g.key !== 'other').map((g) => ({ label: g.label, value: g.current[field] }));
  if (media > 0) list.push({ label: 'Media', value: media });
  if (ai > 0) list.push({ label: 'AI', value: ai });
  list.sort((a, b) => b.value - a.value);
  const rest = list.slice(GA_SHARE_TOP).reduce((n, r) => n + r.value, 0) + (groups.find((g) => g.key === 'other')?.current[field] ?? 0);
  const top = list.slice(0, GA_SHARE_TOP).filter((r) => r.value > 0);
  if (rest > 0) top.push({ label: 'Other', value: rest });
  return top;
}

function renderGaShares(canvasId, legendId, metricKey, rows) {
  charts.shares(canvasId, metricKey, rows);
  const total = rows.reduce((n, r) => n + r.value, 0);
  $(legendId).replaceChildren(...rows.map((r, i) => {
    const swatch = el('span', { class: 'swatch', 'aria-hidden': 'true' });
    swatch.style.background = charts.omCampaignColor(i);
    return el('li', { title: `${r.label}: ${fmt.int(r.value)}` }, swatch, el('span', { text: r.label }),
      el('span', { class: 'num', text: `${fmt.int(r.value)} · ${fmt.pct(total > 0 ? r.value / total : null, 1)}` }));
  }));
}

function renderGaCharts() {
  const g = state.ga;
  if (state.view !== 'overview' || !g?.available) return;
  charts.shopCombo('chart-ga-series', g.series, 'ga_sessions', 'ga_purchases');
  renderGaShares('chart-ga-sessions', 'ga-sessions-legend', 'ga_sessions', gaShares(g.groups, 'sessions'));
  renderGaShares('chart-ga-purchases', 'ga-purchases-legend', 'ga_purchases', gaShares(g.groups, 'purchases'));
}

// Воронка GA4: шаг — подпись, число и доля от предыдущего шага в одной строке; длина полосы — логарифм.
function renderGaFunnel(g) {
  const cur = g.funnel.current;
  const top = Math.log10(Math.max(...cur, 10));
  const nodes = [el('h3', { text: 'Sessions pipeline' })];
  g.funnel.events.forEach((ev, i) => {
    const fill = el('div');
    fill.style.width = `${cur[i] > 0 ? Math.max(3, (Math.log10(Math.max(cur[i], 1)) / top) * 100).toFixed(1) : 0}%`;
    const info = deltaInfo('ga_sessions', cur[i], g.funnel.previous[i]);
    const rate = i > 0 && cur[i - 1] > 0 ? fmt.pct(cur[i] / cur[i - 1], 1) : null;
    nodes.push(el('div', { class: 'funnel-step', title: `${GA_EVENT_LABELS[ev] ?? ev}: ${info.text}` },
      el('div', { class: 'row' }, el('span', { text: GA_EVENT_LABELS[ev] ?? ev }),
        el('span', {}, rate ? el('small', { class: 'muted', text: `${rate} · ` }) : null, el('b', { text: fmt.int(cur[i]) }))),
      el('div', { class: 'track', 'aria-hidden': 'true' }, fill)));
  });
  nodes.push(el('p', { class: 'card-note', text: 'GA4 events; % — of the previous step. Bar length uses a logarithmic scale.' }));
  $('ga-funnel').replaceChildren(...nodes);
}

// Раздел GA4 на обзоре: весь сайт (фильтры платформ и бренда к GA4 не применяются). Стоимость покупки —
// только при всех платформах и всех брендах: иначе расход части рекламы делился бы на покупки всего сайта.
function renderGa() {
  const g = state.ga;
  const f = state.filters;
  const allAds = f.platforms.length === Object.keys(PLATFORM_LABELS).length && !f.brand;
  const s = state.summary;
  $('ga-section').hidden = state.view !== 'overview' || !g?.available;
  if ($('ga-section').hidden) return;
  const cpp = allAds && s ? { current: { ...g.current, ad_spend: s.current.total.spend }, previous: { ...g.previous, ad_spend: s.previous.total.spend } } : null;
  $('ga-kpis').replaceChildren(...GA_KPIS.map((key) => shopKpi(key, { current: g.current, previous: g.previous })),
    ...(cpp ? [shopKpi('ga_cpp', cpp)] : []));
  renderGaFunnel(g);
  renderGaCharts();
  const total = g.current;
  const rows = g.groups.filter((x) => x.current.sessions > 0 || x.current.purchases > 0 || x.previous.sessions > 0)
    .sort((a, b) => (a.key === 'other') - (b.key === 'other') || b.current.sessions - a.current.sessions);
  const otherTitle = g.otherSources.length
    ? `Largest sources in Other: ${g.otherSources.map((o) => `${o.source} (${fmt.int(o.sessions)})`).join(', ')}` : undefined;
  const rowEl = (label, r, prev, cls, title) => {
    const info = deltaInfo('ga_sessions', r.sessions, prev?.sessions);
    return el('tr', { class: cls, title },
      el('td', { class: 'text', text: label }),
      el('td', { text: fmt.int(r.sessions) }),
      el('td', { text: fmt.pct(total.sessions > 0 ? r.sessions / total.sessions : null, 1) }),
      el('td', {}, prev ? el('span', { class: 'delta', dataset: { tone: info.tone }, text: info.short }) : ''),
      el('td', { text: fmt.int(r.purchases) }),
      el('td', { text: fmt.pct(total.purchases > 0 ? r.purchases / total.purchases : null, 1) }),
      el('td', { text: fmt.pct(r.sessions > 0 ? r.purchases / r.sessions : null) }),
      el('td', { text: fmt.money(r.revenue) }));
  };
  $('ga-sources').tBodies[0].replaceChildren(
    ...rows.map((x) => rowEl(x.media ? `${x.label} (media)` : x.ai ? `${x.label} (AI)` : x.label, x.current, x.previous, undefined, x.key === 'other' ? otherTitle : undefined)),
    rowEl('Total', total, g.previous, 'total'));
  const dimLabel = { sourceMedium: 'source / medium', sessionSourceMedium: 'session source / medium', firstUserSourceMedium: 'first user source / medium' }[g.dimension] ?? g.dimension;
  $('ga-note').textContent = `GA4 — the whole site: platform and brand filters do not apply. Sessions and purchases by ${dimLabel}, grouped by the Looker filters `
    + '(Meta — the words meta, fb, ig or containing facebook / instagram; Omnisend — containing omnisend or the word push; Simpals — simpals / cpc, 999.md, stiri.md, point.md; '
    + 'ProTV and other partner sites — by their name; Direct — (direct) / (none)); each session counts in the first matching source. '
    + 'AI — visits from AI assistants (ChatGPT, Claude, Perplexity, Gemini, Copilot, DeepSeek and others), one share in the charts. Media in the share charts — partner sites and other referral traffic. Ad cost per purchase — ad spend of Google Ads, Meta and Admixer per GA4 purchase (shown with all platforms and all brands selected). '
    + `Purchase revenue — as recorded by GA4. GA4 data is available from ${fmt.date(g.dataFrom)}.`
    + (otherTitle ? ` ${otherTitle}.` : '')
    + gaQualityNote(g.quality);
}

// Признаки неполных данных GA4 за период — предупреждение под таблицей.
function gaQualityNote(q) {
  const parts = [];
  if (q?.otherRow) parts.push('part of the traffic is grouped by GA4 into an "(other)" row (too many distinct values) and counted in Other');
  if (q?.thresholding) parts.push('GA4 applied privacy thresholds (small numbers may be hidden)');
  if (q?.sampling) parts.push('GA4 used sampled data');
  return parts.length ? ` Note: for this period ${parts.join('; ')} — figures may differ slightly from the GA4 interface.` : '';
}

function exportGaCsv() {
  const g = state.ga;
  if (!g?.available) return;
  const columns = [
    { title: 'Source', type: 'text', value: (r) => r.label },
    { title: 'Media site', type: 'text', value: (r) => (r.media ? 'yes' : '') },
    { title: 'AI assistant', type: 'text', value: (r) => (r.ai ? 'yes' : '') },
    { title: 'Sessions', type: 'number', digits: 0, value: (r) => r.current.sessions },
    { title: 'Sessions (comparison period)', type: 'number', digits: 0, value: (r) => r.previous.sessions },
    { title: 'Purchases', type: 'number', digits: 0, value: (r) => r.current.purchases },
    { title: 'Purchases (comparison period)', type: 'number', digits: 0, value: (r) => r.previous.purchases },
    { title: 'Conversion rate', type: 'number', digits: 4, value: (r) => (r.current.sessions > 0 ? r.current.purchases / r.current.sessions : null) },
    { title: 'Purchase revenue', type: 'number', digits: 2, value: (r) => r.current.revenue },
  ];
  download(buildCsv(columns, g.groups), `ff-ads-ga4-sources_${state.filters.from}_${state.filters.to}.csv`);
}

function renderFunnel() {
  const s = state.summary;
  if (!s) return;
  const t = s.current.total;
  const steps = [['impressions', t.impressions], ['clicks', t.clicks]];
  if (state.view !== 'admixer') steps.push(['conversions', t.conversions]);
  const top = Math.log10(Math.max(t.impressions, 10));
  const rates = [
    ['CTR', value('ctr', t)],
    ['Conv. rate', t.clicks > 0 ? t.conversions / t.clicks : null],
  ];
  const nodes = [el('h3', { text: 'Funnel' })];
  steps.forEach(([key, v], i) => {
    if (i > 0) nodes.push(el('div', { class: 'funnel-rate', text: `${rates[i - 1][0]}: ${fmt.pct(rates[i - 1][1])}` }));
    const fill = el('div');
    fill.style.width = `${v > 0 ? Math.max(4, (Math.log10(Math.max(v, 1)) / top) * 100).toFixed(1) : 0}%`;
    nodes.push(el('div', { class: 'funnel-step' },
      el('div', { class: 'row' }, el('span', { text: label(key) }), el('b', { text: METRICS[key].format(v) })),
      el('div', { class: 'track', 'aria-hidden': 'true' }, fill)));
  });
  nodes.push(el('p', { class: 'card-note', text: 'Bar length uses a logarithmic scale.' }));
  $('funnel').replaceChildren(...nodes);
}

function progressBar(row) {
  if (!(row.plan > 0)) return null;
  const bar = el('div', { class: 'bar', 'aria-hidden': 'true' });
  const fill = el('div', { class: 'fill', dataset: { status: row.fact > row.plan ? 'over' : 'ok' } });
  fill.style.width = `${Math.min(100, (row.fact / row.plan) * 100)}%`;
  bar.append(fill);
  if (row.expected > 0 && row.expected < row.plan) {
    const mark = el('div', { class: 'mark' });
    mark.style.left = `${(row.expected / row.plan) * 100}%`;
    bar.append(mark);
  }
  return bar;
}

function renderBudget() {
  const b = state.budget;
  if (!b) return;
  const labels = STATUS_LABELS[b.mode];
  const money = (v) => (v === null || v === undefined ? fmt.DASH : fmt.money(v));
  const tr = (name, r, cls) => el('tr', { class: cls },
    el('td', {}, name),
    el('td', { class: 'text' }, el('span', { class: 'status', dataset: { status: r.status }, text: labels[r.status] ?? r.status })),
    el('td', { text: money(r.plan) }),
    el('td', {}, el('div', { text: money(r.fact) }), progressBar(r)),
    el('td', { text: b.mode === 'current' ? money(r.expected) : fmt.DASH }),
    el('td', { text: money(r.forecast), title: r.forecastPct !== null ? `${fmt.pct(r.forecastPct, 1)} of plan` : null }),
    el('td', { text: money(r.remaining) }),
    el('td', { text: b.mode === 'past' ? fmt.DASH : money(r.allowedPerDay) }));
  const rows = b.rows.map((r) => tr(
    el('span', { class: 'platform-tag' }, el('span', { class: `swatch swatch-${r.platform}`, 'aria-hidden': 'true' }), PLATFORM_LABELS[r.platform]),
    r,
  ));
  rows.push(tr('Total', b.total, 'total'));
  $('budget-table').tBodies[0].replaceChildren(...rows);

  let note;
  if (b.mode === 'current') {
    note = `Forecast = spend for full days (${b.daysElapsed}) + average daily spend over the last 7 full days `
      + `(${fmt.money(b.total.avg7)}/day) × remaining days (${b.daysRemaining}, including today). `
      + 'Status: 90–105% of plan — on track, more — overspend, less — underspend. The mark on the bar shows where spend should be now.';
  } else if (b.mode === 'past') {
    note = 'Month completed: status is actual vs plan.';
  } else {
    note = 'Month has not started: only the plan is shown.';
  }
  $('budget-note').textContent = note;
  charts.pace(b);
}

// Колонки таблицы кампаний: на странице платформы колонки «Платформа» нет,
// а показатели и подписи — как у этой платформы.
function tableColumns() {
  const cols = [];
  if (state.view === 'overview') {
    cols.push({
      key: 'platform', title: 'Platform', type: 'text', get: (r) => PLATFORM_LABELS[r.platform],
      cell: (r) => el('td', {}, el('span', { class: 'platform-tag' }, el('span', { class: `swatch swatch-${r.platform}`, 'aria-hidden': 'true' }), PLATFORM_LABELS[r.platform])),
    });
  }
  cols.push(
    {
      key: 'name', title: 'Campaign', type: 'text', get: (r) => r.name,
      cell: (r) => el('td', { class: 'text name', text: r.name || r.campaign_id, title: `ID ${r.campaign_id}` }),
    },
    {
      key: 'brand', title: 'Brand', type: 'text', get: (r) => r.brand,
      cell: (r) => el('td', { class: 'text' }, el('span', { class: 'brand-tag', text: BRAND_LABELS[r.brand] ?? r.brand })),
    },
    ...view().metrics.map((k) => ({
      key: k, title: label(k), type: 'number', get: (r) => value(k, r),
      cell: (r) => el('td', { text: METRICS[k].format(value(k, r)) }),
    })),
  );
  return cols;
}

function visibleCampaigns() {
  if (!state.campaigns) return [];
  const q = state.search.trim().toLocaleLowerCase('ru');
  const columns = tableColumns();
  const col = columns.find((c) => c.key === state.sort.key) ?? columns.find((c) => c.key === 'spend');
  const dir = state.sort.dir === 'asc' ? 1 : -1;
  return state.campaigns.rows
    .filter((r) => !q || r.name.toLocaleLowerCase('ru').includes(q) || r.campaign_id.includes(q))
    .sort((a, b) => {
      const va = col.get(a);
      const vb = col.get(b);
      if (va === null || va === undefined) return 1;
      if (vb === null || vb === undefined) return -1;
      if (col.type === 'text') return dir * String(va).localeCompare(String(vb), 'ru');
      return dir * (va - vb);
    });
}

function renderTableHead() {
  const row = $('campaigns-table').tHead.rows[0];
  row.replaceChildren(...tableColumns().map((c) => {
    const sorted = state.sort.key === c.key;
    return el('th', {
      scope: 'col',
      class: `sortable${c.type === 'text' ? ' text' : ''}`,
      'aria-sort': sorted ? (state.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none',
    }, el('button', { type: 'button', dataset: { key: c.key }, text: c.title }));
  }));
}

function renderTable() {
  renderTableHead();
  const columns = tableColumns();
  const rows = visibleCampaigns();
  const body = $('campaigns-table').tBodies[0];
  if (rows.length === 0) {
    body.replaceChildren(el('tr', {}, el('td', { colspan: columns.length, class: 'text muted', text: state.campaigns ? 'No campaigns in the selected period' : 'Loading…' })));
  } else {
    const frag = document.createDocumentFragment();
    for (const r of rows) {
      frag.append(el('tr', {}, ...columns.map((c) => c.cell(r))));
    }
    body.replaceChildren(frag);
  }
  const total = state.campaigns?.rows.length ?? 0;
  $('campaigns-count').textContent = state.campaigns ? (rows.length === total ? `(${total})` : `(${rows.length} of ${total})`) : '';
}

function renderCharts() {
  const f = state.filters;
  if (!f) return;
  if (state.daily) {
    charts.daily($('daily-metric').value, state.daily, f.platforms);
    for (const k of ['cpm', 'cpc', 'ctr']) charts.daily(k, state.daily, f.platforms, `chart-${k}`);
  }
  if (state.days) {
    const [bar, line] = view().results;
    const labels = labelsFor([bar, line]);
    charts.results('chart-results', state.days, f.platforms, bar, line, labels);
    charts.weekday('chart-weekday', state.days, f.platforms, bar, line, labels);
  }
  $('structure-section').hidden = state.view !== 'overview';
  if (state.summary && state.view === 'overview') {
    charts.share($('share-metric').value, state.summary.current.byPlatform, f.platforms);
    charts.compare($('compare-metric').value, state.summary, f.platforms);
    const s = state.summary.period;
    $('compare-note').textContent = `Current period: ${fmt.date(s.from)} — ${fmt.date(s.to)}; `
      + `${s.compare === 'yoy' ? 'last year' : 'previous'}: ${fmt.date(s.prevFrom)} — ${fmt.date(s.prevTo)}.`;
  }
  if (state.campaigns) charts.bubble($('bubble-metric').value, state.campaigns.rows, f.platforms);
  if (state.budget) charts.pace(state.budget);
}

// ---------- По месяцам ----------

const MONTHLY_COLUMNS = [
  { title: 'Spend', get: (r) => r.spend, format: fmt.money },
  { title: 'Plan', get: (r) => (r.plan > 0 ? r.plan : null), format: (v) => (v === null ? fmt.DASH : fmt.money(v)) },
  { title: '% of plan', get: (r) => (r.plan > 0 ? r.spend / r.plan : null), format: (v) => (v === null ? fmt.DASH : fmt.pct(v, 0)) },
  { title: 'Revenue', get: (r) => r.revenue, format: fmt.money },
  { title: 'ROAS', get: (r) => value('roas', r), format: METRICS.roas.format },
  { title: 'Conversions', get: (r) => r.conversions, format: METRICS.conversions.format },
  { title: 'CPA', get: (r) => value('cpa', r), format: METRICS.cpa.format },
  { title: 'Clicks', get: (r) => r.clicks, format: METRICS.clicks.format },
  { title: 'CTR', get: (r) => value('ctr', r), format: METRICS.ctr.format },
];

function renderMonthly() {
  const section = $('monthly');
  if (!section) return;
  section.hidden = !features().monthly;
  const m = state.monthly;
  if (!m || section.hidden) return;
  const platforms = state.filters.platforms;
  const head = $('monthly-table').tHead.rows[0];
  head.replaceChildren(
    el('th', { scope: 'col', class: 'text', text: 'Month' }),
    ...MONTHLY_COLUMNS.map((c) => el('th', { scope: 'col', text: c.title })),
    ...platforms.map((p) => el('th', { scope: 'col', text: `Spend ${PLATFORM_LABELS[p]}` })),
  );
  const rowEl = (label, r, cls) => el('tr', { class: cls },
    el('td', { class: 'text', text: label }),
    ...MONTHLY_COLUMNS.map((c) => el('td', { text: c.format(c.get(r)) })),
    ...platforms.map((p) => el('td', { text: fmt.money(r.byPlatform[p] ?? 0) })));
  const rows = m.rows.map((r) => rowEl(`${fmt.monthName(r.month.slice(0, 7))}${r.partial ? ' *' : ''}`, r));
  if (m.rows.length > 1) rows.push(rowEl('Total', m.total, 'total'));
  $('monthly-table').tBodies[0].replaceChildren(...(rows.length ? rows
    : [el('tr', {}, el('td', { colspan: 1 + MONTHLY_COLUMNS.length + platforms.length, class: 'text muted', text: 'No data for the selected period' }))]));
  $('monthly-note').textContent = m.rows.some((r) => r.partial)
    ? '* Month only partly in the period: actuals cover the period days, the plan covers the whole month.'
    : '';
}

function exportMonthlyCsv() {
  const m = state.monthly;
  if (!m) return;
  const platforms = state.filters.platforms;
  const columns = [
    { title: 'Month', type: 'text', value: (r) => r.month.slice(0, 7) },
    { title: 'Spend, MDL', type: 'number', digits: 2, value: (r) => r.spend },
    { title: 'Plan, MDL', type: 'number', digits: 2, value: (r) => (r.plan > 0 ? r.plan : null) },
    { title: '% of plan', type: 'number', digits: 2, value: (r) => (r.plan > 0 ? (r.spend / r.plan) * 100 : null) },
    { title: 'Revenue, MDL', type: 'number', digits: 2, value: (r) => r.revenue },
    { title: 'ROAS', type: 'number', digits: 4, value: (r) => value('roas', r) },
    { title: 'Conversions', type: 'number', digits: 2, value: (r) => r.conversions },
    { title: 'CPA, MDL', type: 'number', digits: 2, value: (r) => value('cpa', r) },
    { title: 'Impressions', type: 'number', digits: 0, value: (r) => r.impressions },
    { title: 'Clicks', type: 'number', digits: 0, value: (r) => r.clicks },
    ...platforms.map((p) => ({ title: `Spend ${PLATFORM_LABELS[p]}, MDL`, type: 'number', digits: 2, value: (r) => r.byPlatform[p] ?? 0 })),
  ];
  download(buildCsv(columns, m.rows), `ff-ads-po-mesyacam_${state.filters.from}_${state.filters.to}.csv`);
}

function download(text, filename) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function renderViewLabels() {
  const [bar, line] = view().results;
  $('results-daily-title').textContent = `${label(bar)} and ${label(line)}`;
  $('cpc-title').textContent = label('cpc');
}

function renderAll() {
  renderSources();
  renderAlerts();
  $('app').dataset.view = state.view;
  // Блоки своих вкладок (Shopify, Omnisend) и раздел GA4 обзора скрыты на остальных.
  for (const id of ['placements-section', 'creatives-section', 'shopify-section', 'omnisend-section', 'seo-section', 'dataedge-section', 'ga-section']) $(id).hidden = true;
  $('kpis').className = 'kpis';
  if (state.view === 'shopify') {
    renderShopify();
    return;
  }
  if (state.view === 'omnisend') {
    renderOmnisend();
    return;
  }
  if (state.view === 'seo') {
    renderSeo();
    return;
  }
  if (state.view === 'dataedge') {
    renderDataEdge();
    return;
  }
  renderViewLabels();
  renderHero();
  renderKpis();
  renderPlatforms();
  renderBreakdowns();
  renderPlacements();
  renderCreatives();
  renderFunnel();
  renderBudget();
  renderCharts();
  renderTable();
  renderMonthly();
  renderGa();
}

// ---------- Загрузка ----------

function errorText(prefix, err) {
  return `${prefix}: ${err.message}${err.requestId ? ` (code ${err.requestId.slice(0, 8)})` : ''}`;
}

async function loadBudget() {
  const f = state.filters;
  const params = { month: $('budget-month').value, platforms: f.platforms.join(',') };
  if (f.brand) params.brand = f.brand;
  state.budget = await api('/api/budget', params);
}

async function loadStatus() {
  try {
    state.status = await api('/api/status');
    renderSources();
  } catch { /* статус не критичен */ }
}

let loading = false;
let reloadQueued = false;

async function loadAll() {
  // Фильтр поменяли во время загрузки — загрузить ещё раз после текущей.
  if (loading) {
    reloadQueued = true;
    return;
  }
  const f = readFilters();
  const problem = validateFilters(f);
  state.errors = problem ? [problem] : [];
  if (problem) {
    renderAlerts();
    return;
  }
  loading = true;
  state.filters = f;
  saveFiltersToUrl(f);
  $('app').classList.add('loading');
  try {
    const params = apiParams(f);
    if (state.view === 'shopify') {
      const g = $('shop-granularity').value;
      const [shop, products, status] = await Promise.allSettled([
        api('/api/shopify', g === 'auto' ? params : { ...params, granularity: g }),
        api('/api/shopify/products', params),
        api('/api/status'),
      ]);
      if (shop.status === 'fulfilled') state.shopify = shop.value; else state.errors.push(errorText('Shopify', shop.reason));
      if (products.status === 'fulfilled') state.shopProducts = products.value; else state.errors.push(errorText('Shopify products', products.reason));
      if (status.status === 'fulfilled') state.status = status.value;
      state.lastLoad = Date.now();
      $('updated-at').textContent = `Updated at ${fmt.time(new Date())}`;
      renderAll();
      return;
    }
    if (state.view === 'omnisend') {
      const g = $('om-granularity').value;
      const [om, status] = await Promise.allSettled([
        api('/api/omnisend', g === 'auto' ? params : { ...params, granularity: g }),
        api('/api/status'),
      ]);
      if (om.status === 'fulfilled') state.omnisend = om.value; else state.errors.push(errorText('Omnisend', om.reason));
      if (status.status === 'fulfilled') state.status = status.value;
      state.lastLoad = Date.now();
      $('updated-at').textContent = `Updated at ${fmt.time(new Date())}`;
      renderAll();
      return;
    }
    if (state.view === 'dataedge') {
      const g = $('de-granularity').value;
      const p = { ...params, type: $('de-type').value };
      const [de, status] = await Promise.allSettled([
        api('/api/dataedge', g === 'auto' ? p : { ...p, granularity: g }),
        api('/api/status'),
      ]);
      if (de.status === 'fulfilled') state.dataedge = de.value; else state.errors.push(errorText('Data Edge', de.reason));
      if (status.status === 'fulfilled') state.status = status.value;
      state.lastLoad = Date.now();
      $('updated-at').textContent = `Updated at ${fmt.time(new Date())}`;
      renderAll();
      return;
    }
    if (state.view === 'seo') {
      const g = $('gsc-granularity').value;
      const [gsc, status, ahrefs] = await Promise.allSettled([
        features().gsc ? api('/api/gsc', g === 'auto' ? params : { ...params, granularity: g }) : Promise.resolve({ available: false }),
        api('/api/status'),
        features().ahrefs ? api('/api/ahrefs', { ...params, device: $('ah-device').value }) : Promise.resolve({ available: false }),
      ]);
      if (gsc.status === 'fulfilled') state.gsc = gsc.value; else state.errors.push(errorText('Search Console', gsc.reason));
      if (ahrefs.status === 'fulfilled') state.ahrefs = ahrefs.value; else state.errors.push(errorText('Ahrefs', ahrefs.reason));
      if (status.status === 'fulfilled') state.status = status.value;
      state.lastLoad = Date.now();
      $('updated-at').textContent = `Updated at ${fmt.time(new Date())}`;
      renderAll();
      return;
    }
    const dp = dailyParams(f);
    const dayParams = { ...params, granularity: 'day' };
    const results = await Promise.allSettled([
      api('/api/summary', params),
      api('/api/daily', dp),
      api('/api/campaigns', params),
      loadBudget(),
      api('/api/status'),
      features().monthly ? api('/api/monthly', params) : Promise.resolve(null),
      dp.granularity === 'day' ? Promise.resolve(null) : api('/api/daily', dayParams),
      // Разбивки — на вкладках Meta и Google Ads; у варианта с сервером их нет (ошибка → блок скрыт).
      breakdownsFor(state.view).length
        ? Promise.all(breakdownsFor(state.view).map((dimension) => api('/api/breakdown', { ...params, dimension })))
        : Promise.resolve(null),
      state.view === 'admixer' && features().placements ? api('/api/admixer/placements', params) : Promise.resolve(null),
      state.view === 'admixer' && features().creatives ? api('/api/admixer/creatives', params) : Promise.resolve(null),
      state.view === 'overview' && features().ga4 ? api('/api/ga4', gaParams(params)) : Promise.resolve(null),
    ]);
    const [summary, daily, campaigns, budget, status, monthly, days, breakdowns, placements, creatives, ga] = results;
    if (summary.status === 'fulfilled') state.summary = summary.value; else state.errors.push(errorText('Summary', summary.reason));
    if (daily.status === 'fulfilled') state.daily = daily.value; else state.errors.push(errorText('Trend', daily.reason));
    if (days.status === 'fulfilled') state.days = days.value ?? state.daily; else state.errors.push(errorText('Daily', days.reason));
    if (campaigns.status === 'fulfilled') state.campaigns = campaigns.value; else state.errors.push(errorText('Campaigns', campaigns.reason));
    if (budget.status === 'rejected') state.errors.push(errorText('Budget', budget.reason));
    if (status.status === 'fulfilled') state.status = status.value;
    if (monthly.status === 'fulfilled') state.monthly = monthly.value; else state.errors.push(errorText('Monthly', monthly.reason));
    state.breakdowns = breakdowns.status === 'fulfilled' && breakdowns.value
      ? Object.fromEntries(breakdowns.value.map((b) => [b.dimension, b]))
      : null;
    if (ga.status === 'fulfilled') state.ga = ga.value;
    else { state.ga = null; state.errors.push(errorText('GA4', ga.reason)); }
    if (placements.status === 'fulfilled') state.placements = placements.value;
    else { state.placements = null; state.errors.push(errorText('Placements', placements.reason)); }
    if (creatives.status === 'fulfilled') state.creatives = creatives.value;
    else { state.creatives = null; state.errors.push(errorText('Creatives', creatives.reason)); }
    state.lastLoad = Date.now();
    $('updated-at').textContent = `Updated at ${fmt.time(new Date())}`;
    renderAll();
  } finally {
    $('app').classList.remove('loading');
    loading = false;
    if (reloadQueued) {
      reloadQueued = false;
      loadAll();
    }
  }
}

// ---------- CSV ----------

function exportCsv() {
  const rows = visibleCampaigns();
  const f = state.filters;
  const columns = [
    { title: 'Platform', type: 'text', value: (r) => PLATFORM_LABELS[r.platform] },
    { title: 'Account', type: 'text', value: (r) => r.account_id },
    { title: 'Campaign ID', type: 'text', value: (r) => r.campaign_id },
    { title: 'Campaign', type: 'text', value: (r) => r.name },
    { title: 'Brand', type: 'text', value: (r) => r.brand },
    { title: 'Spend, MDL', type: 'number', digits: 2, value: (r) => r.spend },
    { title: 'Revenue, MDL', type: 'number', digits: 2, value: (r) => r.revenue },
    { title: 'ROAS', type: 'number', digits: 4, value: (r) => value('roas', r) },
    { title: 'Conversions', type: 'number', digits: 2, value: (r) => r.conversions },
    { title: 'CPA, MDL', type: 'number', digits: 2, value: (r) => value('cpa', r) },
    { title: 'Impressions', type: 'number', digits: 0, value: (r) => r.impressions },
    { title: 'Clicks', type: 'number', digits: 0, value: (r) => r.clicks },
    { title: 'CTR, %', type: 'number', digits: 4, value: (r) => (value('ctr', r) === null ? null : value('ctr', r) * 100) },
    { title: 'CPC, MDL', type: 'number', digits: 2, value: (r) => value('cpc', r) },
    { title: 'CPM, MDL', type: 'number', digits: 2, value: (r) => value('cpm', r) },
  ];
  download(buildCsv(columns, rows), `ff-ads-kampanii_${f.from}_${f.to}.csv`);
}

// ---------- Инициализация ----------

function buildMonthOptions() {
  const today = state.config.today;
  const current = today.slice(0, 7);
  const options = [];
  const back = features().budgetMonthsBack ?? 12;
  for (let i = 1; i >= -back; i--) {
    const ym = addMonths(today, i).slice(0, 7);
    options.push(el('option', { value: ym, text: fmt.monthName(ym), selected: ym === current }));
  }
  $('budget-month').replaceChildren(...options);
}

// ---------- Вкладки ----------

function renderTabs() {
  for (const tab of document.querySelectorAll('#tabs .tab')) {
    tab.setAttribute('aria-selected', String(tab.dataset.view === state.view));
  }
  // Вкладки Shopify и Omnisend — только если в данных есть магазин / push-кампании.
  document.querySelector('#tabs .tab[data-view="shopify"]').hidden = !features().shopify;
  document.querySelector('#tabs .tab[data-view="omnisend"]').hidden = !features().omnisend;
  document.querySelector('#tabs .tab[data-view="seo"]').hidden = !features().gsc && !features().ahrefs;
  document.querySelector('#tabs .tab[data-view="dataedge"]').hidden = !features().dataedge;
  $('platforms-field').hidden = state.view !== 'overview';
  $('app').dataset.view = state.view;
  const name = { shopify: 'Shopify', omnisend: 'Omnisend', seo: 'SEO', dataedge: 'SMS / Viber' }[state.view] ?? PLATFORM_LABELS[state.view];
  document.title = state.view === 'overview' ? 'FF Ads Dashboard' : `${name} — FF Ads Dashboard`;
}

function setView(next) {
  if (!Object.hasOwn(VIEWS, next) || next === state.view) return;
  if ((next === 'shopify' && !features().shopify) || (next === 'omnisend' && !features().omnisend) || (next === 'seo' && !features().gsc && !features().ahrefs) || (next === 'dataedge' && !features().dataedge)) return;
  state.view = next;
  if (!view().metrics.includes(state.sort.key) && !['name', 'brand', 'platform'].includes(state.sort.key)) state.sort = { key: 'spend', dir: 'desc' };
  if (next !== 'overview' && state.sort.key === 'platform') state.sort = { key: 'spend', dir: 'desc' };
  renderTabs();
  fillMetricSelects();
  window.scrollTo({ top: 0 });
  loadAll();
}

function bindEvents() {
  $('tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (tab) setView(tab.dataset.view);
  });
  $('tabs').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const tabs = [...document.querySelectorAll('#tabs .tab')].filter((t) => !t.hidden);
    const i = tabs.findIndex((t) => t.dataset.view === state.view);
    const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    next.focus();
    setView(next.dataset.view);
  });
  $('platforms').addEventListener('click', (e) => {
    const card = e.target.closest('.platform-card');
    if (card) setView(card.dataset.view);
  });
  $('period').addEventListener('change', () => { syncPeriodInputs(); loadAll(); });
  for (const id of ['from', 'to']) $(id).addEventListener('change', () => { syncPeriodInputs(); loadAll(); });
  for (const box of document.querySelectorAll('input[name="platform"]')) box.addEventListener('change', loadAll);
  $('brand').addEventListener('change', loadAll);
  $('refresh').addEventListener('click', loadAll);
  $('budget-month').addEventListener('change', async () => {
    try {
      await loadBudget();
      renderBudget();
    } catch (err) {
      state.errors = [errorText('Budget', err)];
      renderAlerts();
    }
  });
  $('daily-metric').addEventListener('change', () => state.daily && charts.daily($('daily-metric').value, state.daily, state.filters.platforms));
  if (features().yoy) $('compare').addEventListener('change', loadAll);
  if (features().granularity) $('granularity').addEventListener('change', loadAll);
  $('monthly-csv')?.addEventListener('click', exportMonthlyCsv);
  $('share-metric').addEventListener('change', () => state.summary && charts.share($('share-metric').value, state.summary.current.byPlatform, state.filters.platforms));
  $('compare-metric').addEventListener('change', () => state.summary && charts.compare($('compare-metric').value, state.summary, state.filters.platforms));
  $('bubble-metric').addEventListener('change', () => state.campaigns && charts.bubble($('bubble-metric').value, state.campaigns.rows, state.filters.platforms));
  $('campaign-search').addEventListener('input', (e) => { state.search = e.target.value; renderTable(); });
  $('campaigns-table').tHead.addEventListener('click', (e) => {
    const key = e.target.closest('button')?.dataset.key;
    if (!key) return;
    state.sort = state.sort.key === key
      ? { key, dir: state.sort.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: tableColumns().find((c) => c.key === key).type === 'text' ? 'asc' : 'desc' };
    renderTable();
  });
  $('csv-export').addEventListener('click', exportCsv);
  $('shop-products-csv').addEventListener('click', exportShopProductsCsv);
  $('placements-csv').addEventListener('click', exportPlacementsCsv);
  $('creatives-csv').addEventListener('click', exportCreativesCsv);
  $('creatives-search').addEventListener('input', (e) => { state.creativesSearch = e.target.value; renderCreatives(); });
  $('creatives-table').tHead.addEventListener('click', (e) => {
    const key = e.target.closest('button')?.dataset.key;
    if (!key) return;
    const col = creativeColumns().find((c) => c.key === key);
    state.creativesSort = state.creativesSort.key === key
      ? { key, dir: state.creativesSort.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: col.type === 'text' ? 'asc' : 'desc' };
    renderCreatives();
  });
  $('placements-search').addEventListener('input', (e) => { state.placementsSearch = e.target.value; renderPlacements(); });
  $('placements-group').addEventListener('change', renderPlacements);
  $('placements-table').tHead.addEventListener('click', (e) => {
    const key = e.target.closest('button')?.dataset.key;
    if (!key) return;
    const col = placementColumns().find((c) => c.key === key);
    state.placementsSort = state.placementsSort.key === key
      ? { key, dir: state.placementsSort.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: col.type === 'text' ? 'asc' : 'desc' };
    renderPlacements();
  });
  $('shop-product-search').addEventListener('input', (e) => { state.shopSearch = e.target.value; renderShopProducts(); });
  $('shop-granularity').addEventListener('change', loadAll);
  $('om-granularity').addEventListener('change', loadAll);
  $('ga-granularity').addEventListener('change', loadAll);
  $('ga-csv').addEventListener('click', exportGaCsv);
  $('om-csv').addEventListener('click', exportOmnisendCsv);
  $('gsc-granularity').addEventListener('change', loadAll);
  $('ah-device').addEventListener('change', loadAll);
  $('ah-filter').addEventListener('change', renderAhKeywords);
  $('ah-csv').addEventListener('click', exportAhrefsCsv);
  $('ah-search').addEventListener('input', (e) => { state.ahSearch = e.target.value; renderAhKeywords(); });
  $('ah-keywords').tHead.addEventListener('click', (e) => {
    const key = e.target.closest('button')?.dataset.key;
    if (!key) return;
    state.ahSort = state.ahSort.key === key ? { key, dir: state.ahSort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: ['keyword', 'url', 'position'].includes(key) ? 'asc' : 'desc' };
    renderAhKeywords();
  });
  $('de-granularity').addEventListener('change', loadAll);
  $('de-type').addEventListener('change', loadAll);
  $('de-csv').addEventListener('click', exportDataEdgeCsv);
  $('de-search').addEventListener('input', (e) => { state.deSearch = e.target.value; renderDeMailings(); });
  $('de-mailings').tHead.addEventListener('click', (e) => {
    const key = e.target.closest('button')?.dataset.key;
    if (!key) return;
    const col = deColumns().find((c) => c.key === key);
    state.deSort = state.deSort.key === key
      ? { key, dir: state.deSort.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: col.type === 'text' && key !== 'date' ? 'asc' : 'desc' };
    renderDeMailings();
  });
  $('gsc-csv').addEventListener('click', exportGscCsv);
  $('gsc-search').addEventListener('input', (e) => { state.gscSearch = e.target.value; renderGscTable('query', 'gsc-queries', 'gsc-queries-count'); });
  $('gsc-query-type').addEventListener('change', () => renderGscTable('query', 'gsc-queries', 'gsc-queries-count'));
  $('gsc-tiles').addEventListener('click', (e) => {
    const key = e.target.closest('.gsc-tile:not([disabled])')?.dataset.key;
    if (!key) return;
    state.gscMetrics = state.gscMetrics.includes(key) ? state.gscMetrics.filter((k) => k !== key) : [...state.gscMetrics, key];
    renderSeo();
  });
  for (const [dim, table, count] of [['query', 'gsc-queries', 'gsc-queries-count'], ['page', 'gsc-pages', 'gsc-pages-count'], ['country', 'gsc-countries', null]]) {
    $(table).tHead.addEventListener('click', (e) => {
      const key = e.target.closest('button')?.dataset.key;
      if (!key) return;
      const cur = state.gscSort[dim];
      state.gscSort[dim] = cur.key === key ? { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'key' ? 'asc' : 'desc' };
      renderGscTable(dim, table, count);
    });
  }
  $('om-search').addEventListener('input', (e) => { state.omSearch = e.target.value; renderOmCampaigns(); });
  $('om-campaigns').tHead.addEventListener('click', (e) => {
    const key = e.target.closest('button')?.dataset.key;
    if (!key) return;
    const col = omColumns().find((c) => c.key === key);
    state.omSort = state.omSort.key === key
      ? { key, dir: state.omSort.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: col.type === 'text' ? 'asc' : 'desc' };
    renderOmCampaigns();
  });
  $('theme-toggle').addEventListener('click', () => {
    window.ffadsTheme.toggle();
    if (state.view === 'shopify') renderShopifyCharts();
    else if (state.view === 'omnisend') renderOmnisendCharts();
    else if (state.view === 'seo') { renderSeoCharts(); renderAhrefsCharts(); }
    else if (state.view === 'dataedge') renderDataEdgeCharts();
    else { renderCharts(); renderBreakdowns(); renderGaCharts(); }
  });
  document.fonts?.ready.then(() => { charts.setup(); renderCharts(); });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', renderCharts);
}

function startAutoRefresh() {
  const periodMs = state.config.refreshSeconds * 1000;
  setInterval(() => {
    if (!document.hidden) loadAll();
  }, periodMs);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && Date.now() - state.lastLoad > periodMs) loadAll();
  });
}

async function init() {
  charts.setup();
  restoreViewFromUrl();
  renderTabs();
  fillMetricSelects();
  renderTableHead();
  try {
    state.config = await api('/api/config');
  } catch (err) {
    state.filters = { platforms: [] };
    state.errors = [errorText('Could not load settings', err)];
    renderAlerts();
    return;
  }
  $('from').max = state.config.today;
  $('to').max = state.config.today;
  if (state.config.dataFrom) { $('from').min = state.config.dataFrom; $('to').min = state.config.dataFrom; }
  $('compare-field').hidden = !features().yoy;
  // Вкладка Shopify из адреса — только если магазин есть в данных.
  if (state.view === 'shopify' && !features().shopify) state.view = 'overview';
  if (state.view === 'omnisend' && !features().omnisend) state.view = 'overview';
  if (state.view === 'seo' && !features().gsc && !features().ahrefs) state.view = 'overview';
  if (state.view === 'dataedge' && !features().dataedge) state.view = 'overview';
  renderTabs();
  $('granularity-field').hidden = !features().granularity;
  restoreFiltersFromUrl();
  buildMonthOptions();
  syncPeriodInputs();
  bindEvents();
  await loadAll();
  startAutoRefresh();
  loadStatus();
}

init();
