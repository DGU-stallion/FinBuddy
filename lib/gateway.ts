/**
 * 金融数据网关
 *
 * 三源协同（ADR-0001）：
 * - 扶摇：行情快照 / 估值 / 利润表 / 财务指标
 * - iFinD：公告 / 新闻语义检索（扶摇不覆盖）
 *
 * 三级降级（ADR-0001 决策 3）：
 * - L1 实时（扶摇 / iFinD）
 * - L2 本地预置存证：仅限预置演示案例，显式标记 isFallback + 抓取日期
 * - L3 信息真空期：无收录时返回结构化"真空"信号，驱动上层归入【无法验证项】
 *
 * 每次成功返回都携带 refId、source、asOf、isFallback（ADR-0002 决策 2）。
 */

import { callFuyaoTool } from './fuyao';
import { callIfindTool } from './ifind';
import { sumTTM, type QuarterlyIncome, type RevenueBasis } from './financials';
import type { SnapshotPayload, FinancialsPayload } from './format';
import { getFallbackSnapshot, type FallbackRecord } from './fallback';

/** 可注入的调用器，便于在降级 seam 上测试（默认用真实实现）。 */
export interface GatewayDeps {
  fuyao: typeof callFuyaoTool;
  ifind: typeof callIfindTool;
}

const defaultDeps: GatewayDeps = { fuyao: callFuyaoTool, ifind: callIfindTool };

export interface GatewayMeta {
  refId: string;
  source: string;
  asOf: number;
  isFallback: boolean;
  fallbackNote?: string;
}

// ---------- 内部类型（扶摇真实返回结构） ----------

interface PricesData {
  item?: Array<{
    thscode?: string;
    last_price?: number;
    price_change_ratio_pct?: number;
    turnover?: number;
  }>;
}

interface ValuationsData {
  item?: Array<{ thscode?: string; name?: string; pe_ttm?: number; pb_mrq?: number }>;
}

interface IncomeData {
  item?: Array<{
    fiscal_year?: number;
    fiscal_period?: string;
    operating_income?: number;
    net_profit?: number;
  }>;
}

interface IndicatorsData {
  thscode?: string;
  report?: string;
  abilities?: Array<{
    ability: string;
    indicators: Array<{ index_id: string; value: string }>;
  }>;
}

interface NoticeData {
  code?: number;
  msg?: string;
  data?: string; // JSON 字符串数组
}

interface NoticeItem {
  公告标题?: string;
  公告片段内容?: string;
  日期?: string;
  备注?: string;
}

// ---------- 工具 1：行情快照 ----------

export async function lookupStockSnapshot(
  thscode: string,
  refId: string,
  deps: GatewayDeps = defaultDeps,
): Promise<SnapshotPayload> {
  try {
    const prices = await deps.fuyao<PricesData>('get_a_share_prices_snapshot', {
      thscodes: thscode,
    });
    const p = prices.item?.[0];
    if (!p) throw new Error(`扶摇未返回 ${thscode} 的行情`);

    let valuations: ValuationsData | null = null;
    try {
      valuations = await deps.fuyao<ValuationsData>('get_a_share_valuations_snapshot', {
        thscodes: thscode,
      });
    } catch {
      valuations = null; // 估值缺失不应让整条行情链路挂掉
    }
    const v = valuations?.item?.[0];

    return {
      refId,
      source: '扶摇 · 行情/估值快照',
      asOf: Date.now(),
      isFallback: false,
      data: {
        thscode: p.thscode ?? thscode,
        name: v?.name,
        last_price: p.last_price,
        price_change_ratio_pct: p.price_change_ratio_pct,
        turnover: p.turnover,
        pe_ttm: v?.pe_ttm,
        pb_mrq: v?.pb_mrq,
      },
    };
  } catch (e) {
    // L2 降级：仅预置案例
    const fb: FallbackRecord | null = getFallbackSnapshot(thscode);
    if (fb) {
      return {
        refId,
        source: fb.source,
        asOf: fb.asOf,
        isFallback: true,
        fallbackNote: fb.note,
        data: fb.snapshot,
      };
    }
    throw e;
  }
}

// ---------- 工具 2：财务参数 ----------

export interface FinancialsResult extends FinancialsPayload {
  baseRevenue: number;
  revenueBasis: RevenueBasis;
  netMargin?: number;
  grossMargin?: number;
  taxRate?: number;
}

export async function lookupFinancialReport(
  thscode: string,
  refId: string,
  deps: GatewayDeps = defaultDeps,
): Promise<FinancialsResult> {
  const income = await deps.fuyao<IncomeData>('get_a_share_financials_income_statements', {
    thscode,
    period: 'quarterly',
    limit: 5,
  });

  const periods: QuarterlyIncome[] = (income.item ?? []).map((it) => ({
    fiscalYear: it.fiscal_year ?? 0,
    fiscalPeriod: it.fiscal_period ?? '',
    operatingIncome: it.operating_income ?? NaN,
    netProfit: it.net_profit ?? NaN,
  }));

  const ttm = sumTTM(periods);

  // 财务指标（净利率/毛利率/税率）单独取；失败不阻断营收链路
  let netMargin: number | undefined;
  let grossMargin: number | undefined;
  let report = periods[0]
    ? `${periods[0].fiscalYear}-${periods[0].fiscalPeriod.replace('Q', '')}`
    : undefined;

  try {
    const latest = periods[0];
    const reportCode = latest ? `${latest.fiscalYear}-${latest.fiscalPeriod.replace('Q', '')}` : '';
    if (reportCode) {
      const ind = await deps.fuyao<IndicatorsData>('get_a_share_financials_indicators', {
        thscode,
        report: reportCode,
      });
      const flat = (ind.abilities ?? []).flatMap((a) => a.indicators);
      const pick = (id: string) => {
        const v = flat.find((x) => x.index_id === id)?.value;
        const n = v === undefined ? NaN : Number(v);
        return Number.isFinite(n) ? n : undefined;
      };
      netMargin = pick('sale_net_interest_ratio');
      grossMargin = pick('sale_gross_margin');
      report = ind.report ?? report;
    }
  } catch {
    // 指标缺失时保留 undefined，由 format 层显式声明"缺失"
  }

  return {
    refId,
    source: '扶摇 · 利润表/财务指标',
    asOf: Date.now(),
    isFallback: false,
    baseRevenue: ttm.baseRevenue,
    revenueBasis: ttm.basis,
    netMargin,
    grossMargin,
    taxRate: 15, // A 股高新技术企业常见优惠税率；口径见 UI 声明
    data: {
      thscode,
      report,
      baseRevenue: ttm.baseRevenue,
      revenueBasis: ttm.basis,
      netMargin,
      grossMargin,
      taxRate: 15,
    },
  };
}

// ---------- 工具 3：公告 / 新闻检索 ----------

export interface AnnouncementResult {
  refId: string;
  source: string;
  asOf: number;
  isFallback: boolean;
  items: Array<{ title: string; snippet: string; date: string }>;
  /** 检索为空时为 true —— 驱动上层归入【无法验证项】（ADR-0001 决策 2）。 */
  vacuum: boolean;
}

function parseNoticeItems(raw: string | undefined): NoticeItem[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as NoticeItem[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export async function searchAnnouncementsAndNews(
  name: string,
  keyword: string,
  refId: string,
  windowDays = 400,
  deps: GatewayDeps = defaultDeps,
): Promise<AnnouncementResult> {
  const end = new Date();
  const start = new Date(end.getTime() - windowDays * 24 * 3600 * 1000);

  let res: NoticeData;
  try {
    res = await deps.ifind<NoticeData>('news', 'search_notice', {
      query: `${name} ${keyword}`.trim(),
      time_start: ymd(start),
      time_end: ymd(end),
      size: 5,
    });
  } catch {
    // iFinD 不可用 → L3 信息真空期（不伪造公告）
    return {
      refId,
      source: 'iFinD · 公告检索',
      asOf: Date.now(),
      isFallback: false,
      items: [],
      vacuum: true,
    };
  }

  const items = parseNoticeItems(res.data)
    .filter((it) => it.公告标题)
    .map((it) => ({
      title: it.公告标题 ?? '',
      snippet: (it.公告片段内容 ?? '').slice(0, 800),
      date: it.日期 ?? '',
    }));

  return {
    refId,
    source: 'iFinD · 公告检索',
    asOf: Date.now(),
    isFallback: false,
    items,
    vacuum: items.length === 0,
  };
}
