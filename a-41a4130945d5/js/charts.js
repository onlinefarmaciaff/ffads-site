// Графики на Chart.js (библиотека отдаётся с нашего сервера: /vendor/chart.umd.min.js).
// Цвета берутся из CSS-токенов, поэтому графики перерисовываются при смене темы.
import * as fmt from './format.js';
import {
  BREAKDOWN_TOKENS, breakdownLabel, breakdownStyle, extraMetric, METRICS, PLATFORM_LABELS, shopifyValue, value,
} from './metrics.js';

// Показатель по ключу: рекламный (METRICS), магазина или Omnisend (extraMetric).
const metricOf = (key) => METRICS[key] ?? extraMetric(key);

const instances = new Map();

function colors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name) => cs.getPropertyValue(name).trim();
  return {
    ink: v('--ink'), ink2: v('--ink-2'), muted: v('--muted'), grid: v('--grid'), axis: v('--axis'),
    surface: v('--surface'), accent: v('--accent'), plan: v('--plan'), previous: v('--previous'),
    platform: { meta: v('--meta'), google: v('--google'), admixer: v('--admixer') },
  };
}

// Цвет с прозрачностью из #rrggbb.
function alpha(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

function baseOptions(c, { metricKey, indexMode = true } = {}) {
  const fmtValue = metricKey ? (v) => METRICS[metricKey].format(v) : fmt.num;
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: indexMode ? { mode: 'index', intersect: false } : { mode: 'nearest', intersect: true },
    plugins: {
      legend: {
        position: 'bottom',
        labels: { color: c.ink2, usePointStyle: true, pointStyle: 'rectRounded', boxWidth: 10, boxHeight: 10, padding: 14 },
      },
      tooltip: {
        backgroundColor: c.surface,
        titleColor: c.ink,
        bodyColor: c.ink2,
        borderColor: c.axis,
        borderWidth: 1,
        padding: 10,
        usePointStyle: true,
        callbacks: {
          label: (ctx) => `${ctx.dataset.label}: ${fmtValue(ctx.parsed.y ?? ctx.parsed)}`,
        },
      },
    },
    scales: {
      x: {
        grid: { display: false },
        border: { color: c.axis },
        ticks: { color: c.muted, maxRotation: 0, autoSkip: true, autoSkipPadding: 12 },
      },
      y: {
        beginAtZero: true,
        grid: { color: c.grid },
        border: { display: false },
        ticks: { color: c.muted, callback: (v) => (metricKey && METRICS[metricKey].format === fmt.pct ? fmt.pct(v, 1) : fmt.compact(v)) },
      },
    },
  };
}

function draw(id, config, isEmpty, emptyText = 'No data for the selected period') {
  const canvas = document.getElementById(id);
  instances.get(id)?.destroy();
  instances.delete(id);
  const box = canvas.parentElement;
  let empty = box.querySelector('.chart-empty');
  if (!empty) {
    empty = document.createElement('div');
    empty.className = 'chart-empty';
    box.appendChild(empty);
  }
  empty.textContent = emptyText;
  empty.hidden = !isEmpty;
  if (isEmpty || !window.Chart) return;
  instances.set(id, new window.Chart(canvas, config));
}

export function setup() {
  if (!window.Chart) return;
  window.Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  window.Chart.defaults.font.size = 12;
}

// 1. Динамика (по дням, неделям или месяцам): суммы — столбцы по платформам (накоплением),
// коэффициенты — линии.
export function daily(metricKey, data, platforms, canvasId = 'chart-daily') {
  const c = colors();
  const m = METRICS[metricKey];
  const byKey = new Map(data.rows.map((r) => [`${r.date}|${r.platform}`, r]));
  const labels = data.dates.map((d) => fmt.bucketLabel(d, data.granularity ?? 'day'));
  const sumsFor = (date, platform) => byKey.get(`${date}|${platform}`) ?? null;
  const datasets = platforms.map((p) => {
    const values = data.dates.map((d) => {
      const s = sumsFor(d, p);
      if (m.kind === 'sum') return s ? s[metricKey] : 0;
      return s ? value(metricKey, s) : null;
    });
    const color = c.platform[p];
    return m.kind === 'sum'
      ? {
        label: PLATFORM_LABELS[p], data: values, backgroundColor: color, borderColor: c.surface,
        borderWidth: { top: 2 }, borderSkipped: 'start', borderRadius: 2, stack: 'platforms', maxBarThickness: 28,
      }
      : {
        label: PLATFORM_LABELS[p], data: values, borderColor: color, backgroundColor: color, borderWidth: 2,
        pointRadius: data.dates.length > 45 ? 0 : 2.5, pointHoverRadius: 5, tension: 0.25, spanGaps: false,
      };
  });
  const hasData = data.rows.length > 0;
  const options = baseOptions(c, { metricKey });
  if (m.kind === 'sum') {
    options.scales.x.stacked = true;
    options.scales.y.stacked = true;
    options.plugins.tooltip.callbacks.footer = (items) => `Total: ${m.format(items.reduce((s, i) => s + (i.parsed.y || 0), 0))}`;
  }
  draw(canvasId, { type: m.kind === 'sum' ? 'bar' : 'line', data: { labels, datasets }, options }, !hasData);
}

// Кольцевая диаграмма долей: подпись в легенде — «Название — доля · значение».
// legend: false — без встроенной легенды (легенда — списком в разметке страницы).
function donut(canvasId, metricKey, labels, values, fills, { legend = true } = {}) {
  const c = colors();
  const m = metricOf(metricKey);
  const total = values.reduce((s, v) => s + v, 0);
  const pctOf = (v) => (total > 0 ? fmt.pct(v / total, 1) : fmt.DASH);
  const options = baseOptions(c, { metricKey, indexMode: false });
  delete options.scales;
  options.cutout = '62%';
  options.plugins.legend.display = legend;
  options.plugins.legend.labels.generateLabels = (chart) => chart.data.labels.map((label, i) => ({
    text: `${label} — ${pctOf(values[i])} · ${m.format(values[i])}`,
    fillStyle: chart.data.datasets[0].backgroundColor[i],
    strokeStyle: chart.data.datasets[0].backgroundColor[i],
    fontColor: c.ink2,
    pointStyle: 'rectRounded',
    index: i,
    hidden: !chart.getDataVisibility(i),
  }));
  options.plugins.tooltip.callbacks.label = (ctx) => `${ctx.label}: ${m.format(ctx.parsed)} (${pctOf(ctx.parsed)})`;
  draw(canvasId, {
    type: 'doughnut',
    data: { labels, datasets: [{ data: values, backgroundColor: fills, borderColor: c.surface, borderWidth: 2, hoverOffset: 4 }] },
    options,
  }, !(total > 0));
}

// 2. Структура: доли платформ в выбранной сумме.
export function share(metricKey, byPlatform, platforms) {
  const c = colors();
  donut('chart-share', metricKey, platforms.map((p) => PLATFORM_LABELS[p]),
    platforms.map((p) => byPlatform[p]?.[metricKey] ?? 0), platforms.map((p) => c.platform[p]));
}

// Разбивка (площадка, устройство, возраст): доли значений; rows — из /api/breakdown.
// Легенда — списком под диаграммой (app.js), по одному значению в строке.
export function breakdown(canvasId, metricKey, rows, dim) {
  const cs = getComputedStyle(document.documentElement);
  const fill = (v) => {
    const { token, alpha: a } = breakdownStyle(v);
    const hex = cs.getPropertyValue(token).trim();
    return a < 1 ? alpha(hex, a) : hex;
  };
  donut(canvasId, metricKey, rows.map((r) => breakdownLabel(r.value, dim)),
    rows.map((r) => r.current[metricKey] ?? 0), rows.map((r) => fill(r.value)), { legend: false });
}

// Цвет значения разбивки для разметки (маркер и полоса доли на карточке): следует за темой.
export function breakdownCssColor(value) {
  const { token, alpha: a } = breakdownStyle(value);
  return a < 1 ? `color-mix(in srgb, var(${token}) ${Math.round(a * 100)}%, transparent)` : `var(${token})`;
}

// 3. Сравнение платформ: текущий период против прошлого такой же длины или того же периода год назад.
export function compare(metricKey, summary, platforms) {
  const c = colors();
  const prevLabel = summary.period?.compare === 'yoy' ? 'Last year' : 'Previous period';
  const m = METRICS[metricKey];
  const cur = platforms.map((p) => value(metricKey, summary.current.byPlatform[p]));
  const prev = platforms.map((p) => value(metricKey, summary.previous.byPlatform[p]));
  const options = baseOptions(c, { metricKey });
  options.plugins.legend.labels.generateLabels = () => [
    { text: 'Current period', fillStyle: c.ink2, strokeStyle: c.ink2, fontColor: c.ink2, pointStyle: 'rectRounded', datasetIndex: 0 },
    { text: prevLabel, fillStyle: alpha(c.ink2, 0.3), strokeStyle: alpha(c.ink2, 0.3), fontColor: c.ink2, pointStyle: 'rectRounded', datasetIndex: 1 },
  ];
  options.plugins.legend.onClick = () => {};
  const hasData = [...cur, ...prev].some((v) => typeof v === 'number' && v !== 0);
  draw('chart-compare', {
    type: 'bar',
    data: {
      labels: platforms.map((p) => PLATFORM_LABELS[p]),
      datasets: [
        { label: 'Current period', data: cur, backgroundColor: platforms.map((p) => c.platform[p]), borderRadius: 4, borderSkipped: 'start', maxBarThickness: 48 },
        { label: prevLabel, data: prev, backgroundColor: platforms.map((p) => alpha(c.platform[p], 0.3)), borderRadius: 4, borderSkipped: 'start', maxBarThickness: 48 },
      ],
    },
    options,
  }, !hasData);
}

// 4. Кампании: x — расход, y — выбранная метрика, размер — конверсии.
export function bubble(metricKey, campaigns, platforms) {
  const c = colors();
  const m = METRICS[metricKey];
  const points = campaigns
    .filter((r) => platforms.includes(r.platform) && r.spend > 0)
    .map((r) => ({ r, y: value(metricKey, r) }))
    .filter((x) => typeof x.y === 'number' && Number.isFinite(x.y))
    .sort((a, b) => b.r.spend - a.r.spend)
    .slice(0, 150);
  const maxConv = Math.max(1, ...points.map((x) => x.r.conversions));
  const radius = (conv) => 4 + 16 * Math.sqrt(Math.max(conv, 0) / maxConv);
  const datasets = platforms.map((p) => ({
    label: PLATFORM_LABELS[p],
    data: points.filter((x) => x.r.platform === p).map((x) => ({
      x: x.r.spend, y: x.y, r: radius(x.r.conversions), name: x.r.name, conversions: x.r.conversions,
    })),
    backgroundColor: alpha(c.platform[p], 0.55),
    borderColor: c.platform[p],
    borderWidth: 1.5,
    hoverBorderWidth: 2,
  }));
  const options = baseOptions(c, { metricKey, indexMode: false });
  options.scales.x.type = 'linear';
  options.scales.x.beginAtZero = true;
  options.scales.x.grid = { color: c.grid };
  options.scales.x.ticks.callback = (v) => fmt.compact(v);
  options.scales.x.title = { display: true, text: 'Spend, MDL', color: c.muted };
  options.scales.y.title = { display: true, text: m.label, color: c.muted };
  options.plugins.tooltip.callbacks = {
    title: (items) => items[0]?.raw.name ?? '',
    label: (ctx) => [
      `${ctx.dataset.label}`,
      `Spend: ${fmt.money(ctx.raw.x)}`,
      `${m.label}: ${m.format(ctx.raw.y)}`,
      `Conversions: ${fmt.num(ctx.raw.conversions)}`,
    ],
  };
  draw('chart-bubble', { type: 'bubble', data: { datasets }, options }, points.length === 0,
    'No campaigns with data for the selected metric');
}

// 5. Темп освоения бюджета: накопленный факт, равномерный план, прогноз.
export function pace(budget) {
  const c = colors();
  const { series } = budget;
  const labels = series.dates.map(fmt.dateShort);
  const options = baseOptions(c, { metricKey: 'spend' });
  // Линии в легенде показывают и пунктир прогноза.
  options.plugins.legend.labels.pointStyle = 'line';
  options.plugins.legend.labels.boxWidth = 24;
  const datasets = [
    { label: 'Actual, cumulative', data: series.fact, borderColor: c.accent, backgroundColor: c.accent, borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, spanGaps: false },
    { label: 'Plan, even pace', data: series.plan, borderColor: c.plan, backgroundColor: c.plan, borderWidth: 2, pointRadius: 0, pointHoverRadius: 4 },
  ];
  if (series.forecast.some((v) => v !== null)) {
    datasets.push({ label: 'Forecast', data: series.forecast, borderColor: c.accent, backgroundColor: c.accent, borderWidth: 2, borderDash: [6, 4], pointRadius: 0, pointHoverRadius: 4, spanGaps: false });
  }
  const isEmpty = !(budget.total.plan > 0) && !series.fact.some((v) => v > 0);
  draw('chart-pace', { type: 'line', data: { labels, datasets }, options }, isEmpty, 'No plan or spend for the month');
}

// Сумма показателей по датам (все выбранные платформы вместе).
function sumByDate(data, platforms) {
  const acc = new Map(data.dates.map((d) => [d, { spend: 0, revenue: 0, conversions: 0, impressions: 0, clicks: 0 }]));
  for (const r of data.rows) {
    const a = acc.get(r.date);
    if (!a || !platforms.includes(r.platform)) continue;
    for (const k of Object.keys(a)) a[k] += r[k] ?? 0;
  }
  return acc;
}

function comboOptions(c, barKey, lineKey, labels) {
  const options = baseOptions(c);
  options.scales.y.ticks.callback = (v) => fmt.compact(v);
  options.scales.y.title = { display: true, text: labels[barKey], color: c.muted };
  options.scales.y1 = {
    position: 'right', beginAtZero: true, grid: { display: false }, border: { display: false },
    ticks: { color: c.muted, callback: (v) => (metricOf(lineKey).format === fmt.pct ? fmt.pct(v, 1) : fmt.compact(v)) },
    title: { display: true, text: labels[lineKey], color: c.muted },
  };
  options.plugins.tooltip.callbacks.label = (ctx) => `${ctx.dataset.label}: ${metricOf(ctx.dataset.metric).format(ctx.parsed.y)}`;
  return options;
}

function comboDatasets(c, barKey, lineKey, labels, bars, line, color) {
  return [
    { type: 'line', label: labels[lineKey], metric: lineKey, data: line, yAxisID: 'y1', borderColor: c.ink, backgroundColor: c.ink, borderWidth: 2, pointRadius: line.length > 45 ? 0 : 2.5, pointHoverRadius: 5, tension: 0.25, order: 0 },
    { type: 'bar', label: labels[barKey], metric: barKey, data: bars, yAxisID: 'y', backgroundColor: color, maxBarThickness: 28, order: 1 },
  ];
}

// 6. Результат по дням: столбцы — сумма (конверсии, клики), линия — её стоимость (CPA, CPC).
export function results(canvasId, data, platforms, barKey, lineKey, labels) {
  const c = colors();
  const acc = sumByDate(data, platforms);
  const sums = data.dates.map((d) => acc.get(d));
  const color = platforms.length === 1 ? c.platform[platforms[0]] : c.accent;
  draw(canvasId, {
    data: {
      labels: data.dates.map((d) => fmt.bucketLabel(d, data.granularity ?? 'day')),
      datasets: comboDatasets(c, barKey, lineKey, labels, sums.map((s) => s[barKey]), sums.map((s) => value(lineKey, s)), color),
    },
    options: comboOptions(c, barKey, lineKey, labels),
  }, !sums.some((s) => s[barKey] > 0 || s.spend > 0));
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// 7. По дням недели: среднее за один день (по дневным данным периода).
export function weekday(canvasId, data, platforms, barKey, lineKey, labels) {
  const c = colors();
  const acc = sumByDate(data, platforms);
  const week = WEEKDAYS.map(() => ({ n: 0, spend: 0, revenue: 0, conversions: 0, impressions: 0, clicks: 0 }));
  for (const [d, s] of acc) {
    const w = week[(new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7];
    w.n += 1;
    for (const k of Object.keys(s)) w[k] += s[k];
  }
  const bars = week.map((w) => (w.n ? w[barKey] / w.n : null));
  const line = week.map((w) => value(lineKey, w));
  const color = platforms.length === 1 ? c.platform[platforms[0]] : c.accent;
  const avgLabels = { ...labels, [barKey]: `${labels[barKey]}, daily avg.` };
  draw(canvasId, {
    data: { labels: WEEKDAYS, datasets: comboDatasets(c, barKey, lineKey, avgLabels, bars, line, color) },
    options: comboOptions(c, barKey, lineKey, avgLabels),
  }, !week.some((w) => w[barKey] > 0 || w.spend > 0));
}

// ---------- Shopify ----------

// series — из /api/shopify: { granularity, dates, rows: [{ date, total_sales, orders, … }] }.
function shopSeries(series, key) {
  const byDate = new Map(series.rows.map((r) => [r.date, r]));
  return series.dates.map((d) => (byDate.has(d) ? shopifyValue(key, byDate.get(d)) : null));
}
const shopLabels = (series) => series.dates.map((d) => fmt.bucketLabel(d, series.granularity ?? 'day'));

// Продажи (столбцы) и заказы (линия, правая ось) — как «Total sales / Orders» в Looker.
export function shopCombo(canvasId, series, barKey, lineKey) {
  const c = colors();
  const labels = { [barKey]: metricOf(barKey).label, [lineKey]: metricOf(lineKey).label };
  const bars = shopSeries(series, barKey);
  draw(canvasId, {
    data: { labels: shopLabels(series), datasets: comboDatasets(c, barKey, lineKey, labels, bars, shopSeries(series, lineKey), c.accent) },
    options: comboOptions(c, barKey, lineKey, labels),
  }, !bars.some((v) => v > 0));
}

// Линии показателей магазина на одной оси (заказы; средний чек; продажи и возвраты).
// spanGaps — соединять точки через пропуски (Omnisend: дни без отправок).
export function shopLines(canvasId, series, keys, { spanGaps = false } = {}) {
  const c = colors();
  const palette = [c.accent, c.platform.google, c.platform.admixer];
  const m = metricOf(keys[0]);
  const datasets = keys.map((key, i) => {
    const data = shopSeries(series, key);
    return {
      label: metricOf(key).label, metric: key, data, borderColor: palette[i], backgroundColor: palette[i], borderWidth: 2,
      pointRadius: data.length > 45 ? 0 : 2.5, pointHoverRadius: 5, tension: 0.25, spanGaps,
    };
  });
  const options = baseOptions(c, { indexMode: true });
  options.scales.y.ticks.callback = (v) => (m.format === fmt.pct ? fmt.pct(v, 1) : fmt.compact(v));
  options.plugins.legend.display = keys.length > 1;
  options.plugins.tooltip.callbacks.label = (ctx) => `${ctx.dataset.label}: ${metricOf(ctx.dataset.metric).format(ctx.parsed.y)}`;
  draw(canvasId, { type: 'line', data: { labels: shopLabels(series), datasets }, options }, !datasets.some((d) => d.data.some((v) => v)));
}

// Продажи по источникам заказа: доли; цвет — по порядку, из палитры дашборда.
export function shopSources(canvasId, rows, labelOf) {
  const cs = getComputedStyle(document.documentElement);
  donut(canvasId, 'shop_sales', rows.map((r) => labelOf(r.source)), rows.map((r) => r.current.sales),
    rows.map((_, i) => cs.getPropertyValue(BREAKDOWN_TOKENS[Math.min(i, BREAKDOWN_TOKENS.length - 1)]).trim()), { legend: false });
}

// Доли кампаний Omnisend (открытия): первые 9 и «Other»; цвета — палитра дашборда с оттенками.
export function omCampaigns(canvasId, rows) {
  const cs = getComputedStyle(document.documentElement);
  donut(canvasId, 'om_opened', rows.map((r) => r.label), rows.map((r) => r.value), rows.map((_, i) => omCssFill(cs, i)), { legend: false });
}
const OM_ALPHA = [1, 0.6];
function omCssFill(cs, i) {
  const n = BREAKDOWN_TOKENS.length;
  const hex = cs.getPropertyValue(BREAKDOWN_TOKENS[i % n]).trim();
  const a = OM_ALPHA[Math.floor(i / n)] ?? 0.35;
  return a < 1 ? alpha(hex, a) : hex;
}
export const omCampaignColor = (i) => omCssFill(getComputedStyle(document.documentElement), i);

export const shopSourceCssColor = (i) => `var(${BREAKDOWN_TOKENS[Math.min(i, BREAKDOWN_TOKENS.length - 1)]})`;
