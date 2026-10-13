/**
 * L2 本地预置存证（ADR-0001 决策 3）
 *
 * 用途：L1 实时接口失败时的保底，让预置演示案例在断网时仍能走完整链路。
 * 边界：仅覆盖预置案例（中际旭创 / 宁德时代）；自由查询不走 L2，直接进入 L3 信息真空期。
 * 铁律：必须显著标注抓取日期与"非实时数据"，绝不冒充实时行情。
 *
 * 数据来源：
 * - 行情快照：2026-10-12 真机抓取自扶摇 MCP（未经任何人工修改）
 * - 财务参数：2026-10-13 真机抓取自扶摇 MCP（未经任何人工修改）
 *
 * 历史（T4 Spec 轴评审抓出的缺口）：原实现只预置了行情快照，
 * 而 `lookupFinancialReport` 没有降级分支 —— 断网演示时 T5 的测算卡片
 * （"完整链路"的定量那一环）会直接消失，恰恰在 L2 存在的理由下失效。
 */

import type { SnapshotPayload } from './format';

export interface FallbackRecord {
  thscode: string;
  name: string;
  asOf: number;
  note: string;
  source: string;
  snapshot: SnapshotPayload['data'];
}

const CAPTURED_AT = Date.UTC(2026, 9, 12, 15, 45); // 2026-10-12 抓取
const CAPTURE_NOTE = '抓取于 2026-10-12，非实时行情';
const CAPTURED_AT_FIN = Date.UTC(2026, 9, 13, 1, 30); // 2026-10-13 财务参数抓取

const RECORDS: FallbackRecord[] = [
  {
    thscode: '300308.SZ',
    name: '中际旭创',
    asOf: CAPTURED_AT,
    note: CAPTURE_NOTE,
    source: 'L2 本地存证 · 扶摇历史快照',
    snapshot: {
      thscode: '300308.SZ',
      name: '中际旭创',
      last_price: 724.47,
      price_change_ratio_pct: -6.411316,
      turnover: 15623739000,
      pe_ttm: 41.722396,
      pb_mrq: 21.409387,
    },
  },
  {
    thscode: '300750.SZ',
    name: '宁德时代',
    asOf: CAPTURED_AT,
    note: CAPTURE_NOTE,
    source: 'L2 本地存证 · 扶摇历史快照',
    snapshot: {
      thscode: '300750.SZ',
      name: '宁德时代',
      last_price: 298.38,
      price_change_ratio_pct: 0.211587,
      turnover: 12580165600,
      pe_ttm: 16.243252,
      pb_mrq: 3.639555,
    },
  },
];

export function getFallbackSnapshot(thscode: string): FallbackRecord | null {
  const key = thscode.trim().toUpperCase();
  return RECORDS.find((r) => r.thscode === key) ?? null;
}

export function listFallbackCases(): FallbackRecord[] {
  return RECORDS;
}

// ---------- 财务参数兜底（L2 第二部分） ----------

export interface FallbackFinancialsRecord {
  thscode: string;
  name: string;
  asOf: number;
  note: string;
  source: string;
  /** TTM 年化基准营收（元）。 */
  baseRevenue: number;
  revenueBasis: 'TTM';
  netMargin: number;
  grossMargin: number;
  /** 有效所得税率（%），由利润表推导（见 lib/financials.ts effectiveTaxRate）。 */
  taxRate: number;
  /** 最近报告期，形如 2026-2。 */
  report: string;
}

/**
 * 财务参数兜底数据（2026-10-13 真机抓取自扶摇，未经人工修改）。
 *
 * 与行情快照同一批标的，保证"预置案例断网也能走完整链路"包括定量测算那一环。
 */
const FINANCIAL_RECORDS: FallbackFinancialsRecord[] = [
  {
    thscode: '300308.SZ',
    name: '中际旭创',
    asOf: CAPTURED_AT_FIN,
    note: '财务参数抓取于 2026-10-13，非最新报告期',
    source: 'L2 本地存证 · 扶摇历史财报',
    baseRevenue: 124518996370.97,
    revenueBasis: 'TTM',
    netMargin: 35.2661,
    grossMargin: 46.2522,
    taxRate: 14.678138806059899,
    report: '2026-2',
  },
  {
    thscode: '300750.SZ',
    name: '宁德时代',
    asOf: CAPTURED_AT_FIN,
    note: '财务参数抓取于 2026-10-13，非最新报告期',
    source: 'L2 本地存证 · 扶摇历史财报',
    baseRevenue: 1112821442000,
    revenueBasis: 'TTM',
    netMargin: 16.9837,
    grossMargin: 23.9284,
    taxRate: 14.837350202112592,
    report: '2026-2',
  },
];

/** 财务兜底查询。非预置标的返回 null —— 自由查询不得用过期数据冒充正常结论。 */
export function getFallbackFinancials(thscode: string): FallbackFinancialsRecord | null {
  const key = (thscode ?? '').trim().toUpperCase();
  if (key === '') return null;
  return FINANCIAL_RECORDS.find((r) => r.thscode === key) ?? null;
}

/** 列出全部财务兜底记录（供测试与预置案例守卫使用）。 */
export function listFallbackFinancials(): FallbackFinancialsRecord[] {
  return FINANCIAL_RECORDS;
}
