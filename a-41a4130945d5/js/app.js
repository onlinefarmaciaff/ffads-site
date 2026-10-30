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
  overview: {
    hero: ['roas', 'cpa', 'conversions'], kpis: ['revenue', 'impressions', 'clicks', 'ctr', 'cpc', 'cpm'],
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
VIEWS.shopify = { ...VIEWS.overview };
// Вкладка Omnisend (push-кампании): свои блоки (renderOmnisend).
VIEWS.omnisend = { ...VIEWS.overview };
// Вкладки не рекламных платформ: свои данные и блоки, фильтры платформ и бренда не действуют.
const OWN_VIEWS = ['shopify', 'omnisend'];

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
  placements: null, // /api/admixer/placements — вкладка Admixer
  placementsSearch: '',
  placementsSort: { key: 'impressions', dir: 'desc' },
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
  return { preset, ...range, platforms, brand: $('brand').value, compare };
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

function renderSources() {
  const list = $('sources');
  if (!state.status) return;
  const STATE_TEXT = { ok: '', stale: 'stale', error: 'error', never: 'no data' };
  list.replaceChildren(...state.status.sources.map((s) => {
    const when = s.lastOkAt ? fmt.dateTime(s.lastOkAt) : null;
    const title = [
      `${s.label}: ${{ ok: 'data is fresh', stale: 'not updated for a while', error: 'last run failed', never: 'no runs yet' }[s.state]}`,
      when ? `last successful update ${when}` : null,
    ].filter(Boolean).join('; ');
    return el('li', { class: 'source', dataset: { state: s.state }, title, 'aria-label': title },
      el('span', { class: 'dot', 'aria-hidden': 'true' }),
      el('span', { text: s.label }),
      el('span', { class: 'state', text: STATE_TEXT[s.state] || (when ? when.slice(-5) : '') }));
  }));
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
  const yoy = (state.view === 'shopify' ? state.shopify : state.view === 'omnisend' ? state.omnisend : state.summary)?.period?.compare === 'yoy';
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
  const p = (state.view === 'omnisend' ? state.omnisend : state.shopify).period;
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
  if (state.view === 'shopify') {
    $('placements-section').hidden = true;
    $('omnisend-section').hidden = true;
    renderShopify();
    return;
  }
  if (state.view === 'omnisend') {
    $('placements-section').hidden = true;
    $('shopify-section').hidden = true;
    renderOmnisend();
    return;
  }
  $('shopify-section').hidden = true;
  $('omnisend-section').hidden = true;
  $('placements-section').hidden = true;
  renderViewLabels();
  renderHero();
  renderKpis();
  renderPlatforms();
  renderBreakdowns();
  renderPlacements();
  renderFunnel();
  renderBudget();
  renderCharts();
  renderTable();
  renderMonthly();
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
    ]);
    const [summary, daily, campaigns, budget, status, monthly, days, breakdowns, placements] = results;
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
    if (placements.status === 'fulfilled') state.placements = placements.value;
    else { state.placements = null; state.errors.push(errorText('Placements', placements.reason)); }
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
  $('platforms-field').hidden = state.view !== 'overview';
  $('app').dataset.view = state.view;
  const name = { shopify: 'Shopify', omnisend: 'Omnisend' }[state.view] ?? PLATFORM_LABELS[state.view];
  document.title = state.view === 'overview' ? 'FF Ads Dashboard' : `${name} — FF Ads Dashboard`;
}

function setView(next) {
  if (!Object.hasOwn(VIEWS, next) || next === state.view) return;
  if ((next === 'shopify' && !features().shopify) || (next === 'omnisend' && !features().omnisend)) return;
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
  $('om-csv').addEventListener('click', exportOmnisendCsv);
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
    else { renderCharts(); renderBreakdowns(); }
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
