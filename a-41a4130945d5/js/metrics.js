// Показатели: подписи, расчёт коэффициентов, форматы, направление «хорошо/плохо».
import * as fmt from './format.js';

const div = (a, b) => (b > 0 ? a / b : null);

export const PLATFORM_LABELS = { meta: 'Meta', google: 'Google Ads', admixer: 'Admixer' };

// Разбивки (Meta: площадка, устройство; Google Ads: устройство, возраст): подписи и цвета значений.
// Цвета — токены палитры дашборда; возрастные группы — оттенки синего по порядку возраста.
export const BREAKDOWN_TOKENS = ['--meta', '--google', '--admixer', '--plan', '--previous'];
export const AGE_ORDER = ['18_24', '25_34', '35_44', '45_54', '55_64', '65_up', 'undetermined'];
const AGE_ALPHA = [1, 0.82, 0.66, 0.52, 0.4, 0.3];

const BREAKDOWN_LABELS = {
  facebook: 'Facebook', instagram: 'Instagram', audience_network: 'Audience Network', messenger: 'Messenger',
  threads: 'Threads', mobile_app: 'Mobile app', mobile_web: 'Mobile web', desktop: 'Desktop', unknown: 'Other',
  mobile: 'Mobile', tablet: 'Tablets', connected_tv: 'TV screens', other: 'Other devices', others: 'Others',
  '18_24': '18–24', '25_34': '25–34', '35_44': '35–44', '45_54': '45–54', '55_64': '55–64', '65_up': '65+',
  undetermined: 'Undetermined',
};
// Подписи, которые зависят от разбивки: у Google Ads «desktop» — компьютеры (как в Google Ads).
const BREAKDOWN_LABELS_BY_DIM = { device: { desktop: 'Computers' } };
const BREAKDOWN_COLORS = {
  facebook: 0, instagram: 1, audience_network: 2, threads: 3, messenger: 4,
  mobile_app: 0, desktop: 1, mobile_web: 2, mobile: 0, others: 1, tablet: 2, connected_tv: 3, other: 4, undetermined: 4,
};

export const breakdownLabel = (v, dim) => BREAKDOWN_LABELS_BY_DIM[dim]?.[v] ?? BREAKDOWN_LABELS[v]
  ?? v.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

// Цвет значения: токен палитры и непрозрачность (1 — сплошной).
export function breakdownStyle(v) {
  const age = AGE_ORDER.indexOf(v);
  if (age >= 0 && age < AGE_ALPHA.length) return { token: BREAKDOWN_TOKENS[0], alpha: AGE_ALPHA[age] };
  return { token: BREAKDOWN_TOKENS[BREAKDOWN_COLORS[v] ?? BREAKDOWN_TOKENS.length - 1], alpha: 1 };
}

// kind: sum — суммируется (столбцы, доли); ratio — коэффициент (линии).
// better: up — рост хорош, down — рост плох, neutral — без оценки.
export const METRICS = {
  spend: { label: 'Spend', kind: 'sum', better: 'neutral', format: fmt.money },
  revenue: { label: 'Revenue', kind: 'sum', better: 'up', format: fmt.money },
  roas: { label: 'ROAS', kind: 'ratio', better: 'up', format: fmt.ratio, calc: (s) => div(s.revenue, s.spend) },
  conversions: { label: 'Conversions', kind: 'sum', better: 'up', format: fmt.num },
  cpa: { label: 'CPA', kind: 'ratio', better: 'down', format: fmt.money2, calc: (s) => div(s.spend, s.conversions) },
  impressions: { label: 'Impressions', kind: 'sum', better: 'up', format: fmt.int },
  clicks: { label: 'Clicks', kind: 'sum', better: 'up', format: fmt.int },
  ctr: { label: 'CTR', kind: 'ratio', better: 'up', format: fmt.pct, calc: (s) => div(s.clicks, s.impressions) },
  cpc: { label: 'CPC', kind: 'ratio', better: 'down', format: fmt.money2, calc: (s) => div(s.spend, s.clicks) },
  cpm: { label: 'CPM', kind: 'ratio', better: 'down', format: fmt.money2, calc: (s) => div(s.spend * 1000, s.impressions) },
};

// Shopify (вкладка Shopify): из сумм /api/shopify. Скидки и возвраты — положительными числами, как в
// Looker (в Shopify они со знаком минус). MER — продажи магазина на 1 MDL рекламы, CPO — реклама на заказ.
const abs = (v) => (typeof v === 'number' ? Math.abs(v) : v);
export const SHOPIFY_METRICS = {
  shop_sales: { label: 'Total sales', better: 'up', format: fmt.money, calc: (s) => s.total_sales },
  shop_orders: { label: 'Orders', better: 'up', format: fmt.int, calc: (s) => s.orders },
  shop_aov: { label: 'Avg. order value', better: 'up', format: fmt.money2, calc: (s) => div(s.gross_sales + s.discounts, s.orders) },
  shop_qty: { label: 'Ordered quantity', better: 'up', format: fmt.int, calc: (s) => s.quantity_ordered },
  shop_discounts: { label: 'Discounts', better: 'neutral', format: fmt.money, calc: (s) => abs(s.discounts) },
  shop_customers: { label: 'Customers', better: 'up', format: fmt.int, calc: (s) => s.customers ?? null },
  shop_returns: { label: 'Returns', better: 'down', format: fmt.money, calc: (s) => abs(s.returns) },
  shop_qty_returned: { label: 'Returned quantity', better: 'down', format: fmt.int, calc: (s) => abs(s.quantity_returned) },
  shop_new_customers: { label: 'New customers', better: 'up', format: fmt.int, calc: (s) => s.new_customers },
  shop_sessions: { label: 'Sessions', better: 'up', format: fmt.int, calc: (s) => s.sessions },
  shop_cr: { label: 'Conversion rate', better: 'up', format: fmt.pct, calc: (s) => div(s.sessions_that_completed_checkout, s.sessions) },
  shop_ad_spend: { label: 'Ad spend', better: 'neutral', format: fmt.money, calc: (s) => s.ad_spend },
  shop_mer: { label: 'MER', better: 'up', format: fmt.ratio, calc: (s) => div(s.total_sales, s.ad_spend) },
  shop_cpo: { label: 'Ad cost per order', better: 'down', format: fmt.money2, calc: (s) => div(s.ad_spend, s.orders) },
};

// Omnisend (вкладка Omnisend, push-кампании): из сумм /api/omnisend. Доли — от отправок, как в Looker;
// CTOR — клики от открытий; выручка и заказы — приписанные кампаниям Omnisend.
export const OMNISEND_METRICS = {
  om_campaigns: { label: 'Number of campaigns', better: 'neutral', format: fmt.int, calc: (s) => s.campaigns },
  om_sent: { label: 'Sends', better: 'up', format: fmt.int, calc: (s) => s.sent },
  om_opened: { label: 'Opens', better: 'up', format: fmt.int, calc: (s) => s.opened },
  om_open_rate: { label: 'Open rate', better: 'up', format: fmt.pct, calc: (s) => div(s.opened, s.sent) },
  om_clicked: { label: 'Clicks', better: 'up', format: fmt.int, calc: (s) => s.clicked },
  om_click_rate: { label: 'Click rate', better: 'up', format: fmt.pct, calc: (s) => div(s.clicked, s.sent) },
  om_ctor: { label: 'Click-to-open rate', better: 'up', format: fmt.pct, calc: (s) => div(s.clicked, s.opened) },
  om_unsubscribed: { label: 'Unsubscribes', better: 'down', format: fmt.int, calc: (s) => s.unsubscribed },
  om_unsub_rate: { label: 'Unsubscribe rate', better: 'down', format: fmt.pct, calc: (s) => div(s.unsubscribed, s.sent) },
  om_bounces: { label: 'Bounces', better: 'down', format: fmt.int, calc: (s) => s.failed },
  om_bounce_rate: { label: 'Bounce rate', better: 'down', format: fmt.pct, calc: (s) => div(s.failed, s.sent) },
  om_complaint_rate: { label: 'Complaint rate', better: 'down', format: fmt.pct, calc: (s) => div(s.spam, s.sent) },
  om_orders: { label: 'Orders', better: 'up', format: fmt.int, calc: (s) => s.orders },
  om_revenue: { label: 'Revenue', better: 'up', format: fmt.money, calc: (s) => s.revenue },
  om_rps: { label: 'Revenue per 1,000 sends', better: 'up', format: fmt.money2, calc: (s) => div(s.revenue * 1000, s.sent) },
};

// Показатель вкладок Shopify и Omnisend по ключу.
export const extraMetric = (key) => SHOPIFY_METRICS[key] ?? OMNISEND_METRICS[key];
export const shopifyValue = (key, sums) => (sums ? extraMetric(key).calc(sums) ?? null : null);

export const KPI_ORDER = ['spend', 'revenue', 'roas', 'conversions', 'cpa', 'impressions', 'clicks', 'ctr', 'cpc', 'cpm'];
export const SUM_METRICS = KPI_ORDER.filter((k) => METRICS[k].kind === 'sum');
export const BUBBLE_METRICS = ['cpa', 'roas', 'ctr', 'cpc', 'cpm'];

export function value(key, sums) {
  if (!sums) return null;
  const m = METRICS[key];
  return m.calc ? m.calc(sums) : sums[key];
}

export function format(key, v) {
  return METRICS[key].format(v);
}

// Изменение к прошлому периоду (доля): null, если сравнивать не с чем.
export function delta(cur, prev) {
  if (typeof cur !== 'number' || typeof prev !== 'number' || !Number.isFinite(cur) || !Number.isFinite(prev)) return null;
  if (prev === 0) return null;
  return (cur - prev) / Math.abs(prev);
}

export function tone(key, d) {
  if (d === null || d === 0 || Math.abs(d) < 0.0005) return 'neutral';
  const better = (METRICS[key] ?? extraMetric(key)).better;
  if (better === 'neutral') return 'neutral';
  return (d > 0) === (better === 'up') ? 'good' : 'bad';
}
