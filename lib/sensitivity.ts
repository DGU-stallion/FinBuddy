/**
 * Seam 9: 确定性敏感性测算引擎（营收冲击推演，ADR-0001 决策 1）
 *
 * 设计要点：
 * - **零 LLM 参与**：公式全部在客户端纯函数里算，模型只负责从财报工具取真实参数。
 *   这是「AI 定性 + 数学公式定量」的落点：定性交给模型，定量交给数学。
 * - 公式：`ΔNetProfit = BaseRevenue × ΔRevenueDeclinePct × NetMargin × (1 - TaxRate)`
 *   所有输入参数都能回溯到真实财报字段（ADR-0001：不引入无法实时获取的推断参数）。
 * - **缺失即拒绝**：任一参数缺失/非有限数一律 `ok: false`，绝不默认 0 后算出一个
 *   「看起来正常」的数字（那是幻觉的一种，且最难被发现）。
 * - 单位约定：outside 传百分比数值（22.36 表示 22.36%），内部转小数计算。
 *   量纲只在本模块内转换一次，避免调用方各自换算导致 100 倍错误。
 */

/** 滑块区间（spec 交互决策：5%~30%）。 */
export const SLIDER_MIN_PCT = 5;
export const SLIDER_MAX_PCT = 30;

export type RevenueBasisLike = 'TTM' | 'latest_quarter_x4' | 'missing' | undefined;

export interface SensitivityParams {
  /** 基准年化营收（元，非亿元）。 */
  baseRevenue: number | undefined;
  /** 净利率，百分比数值（如 22.36 表示 22.36%）。 */
  netMargin: number | undefined;
  /** 所得税率，百分比数值（如 15 表示 15%）。 */
  taxRate: number | undefined;
  /** 营收整体下滑幅度，百分比数值（如 20 表示 20%）。 */
  declinePct: number;
}

export type SensitivityResult =
  | {
      ok: true;
      /** 净利润冲击（元，正数表示减少的净利润）。 */
      impact: number;
      /** 同上，供测试以"期望值"口径断言（同一浮点序列）。 */
      expected: number;
      /** 原净利润（税后，元）。 */
      baselineNetProfit: number;
      /** 冲击占原净利润的百分比。 */
      impactRatioPct: number;
      /** 冲击金额（亿元），供 UI 直接展示。 */
      impactYi: number;
    }
  | { ok: false; reason: string };

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * 计算营收下滑对净利润的冲击。
 *
 * 线性一阶近似：不建模固定成本摊薄、不建模产能再分配（局限必须在 UI 显式声明）。
 */
export function computeSensitivity(params: SensitivityParams): SensitivityResult {
  const { baseRevenue, netMargin, taxRate, declinePct } = params;

  // 缺失即拒绝 —— 绝不默认 0（注：netMargin = 0 是合法值，不是缺失）
  if (!finite(baseRevenue)) return { ok: false, reason: '基准营收缺失' };
  if (!finite(netMargin)) return { ok: false, reason: '净利率缺失' };
  if (!finite(taxRate)) return { ok: false, reason: '所得税率缺失' };
  if (!finite(declinePct)) return { ok: false, reason: '下滑幅度缺失' };

  // 下滑幅度必须落在滑块区间内（不让脏值进入计算）
  if (declinePct < 0 || declinePct > 100) {
    return { ok: false, reason: `下滑幅度超出合理区间：${declinePct}%` };
  }

  const decline = declinePct / 100;
  const margin = netMargin / 100;
  const tax = taxRate / 100;

  // 保持单一浮点运算序列，使 "误差 = 0" 可断言（不做中间舍入）
  const impact = baseRevenue * decline * margin * (1 - tax);
  const baselineNetProfit = baseRevenue * margin * (1 - tax);

  return {
    ok: true,
    impact,
    expected: impact,
    baselineNetProfit,
    impactRatioPct: baselineNetProfit === 0 ? 0 : (impact / baselineNetProfit) * 100,
    impactYi: impact / 1e8,
  };
}

/** 滑块区间（供 UI 与测试共用同一事实来源）。 */
export function revenueDeclineRange(): { min: number; max: number } {
  return { min: SLIDER_MIN_PCT, max: SLIDER_MAX_PCT };
}

export interface BasisInput {
  revenueBasis: RevenueBasisLike;
  report?: string;
  asOf?: number;
}

const BASIS_LABEL: Record<string, string> = {
  TTM: 'TTM（最近四季滚动年化）',
  latest_quarter_x4: '最近单季 × 4（降级口径，未经季节性调整）',
  missing: '缺失',
};

function utcDate(ms: number | undefined): string {
  if (!ms || Number.isNaN(ms)) return '时点缺失';
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/**
 * 口径与时点的人类可读标注。
 *
 * ADR-0001 决策 4：基准营收口径必须在 UI 明确标注，降级口径尤其不得静默。
 */
export function describeBasis(input: BasisInput): string {
  const basis = BASIS_LABEL[input.revenueBasis ?? 'missing'] ?? '缺失';
  const report = input.report?.trim() ? input.report : '缺失';
  return `口径：${basis} · 报告期：${report} · 数据时点：${utcDate(input.asOf)}`;
}

// ---------- 参数注入（从存证 refs 提取，T5） ----------

export interface SensitivityInjectParams {
  refId: string;
  baseRevenue: number;
  netMargin: number;
  taxRate: number;
  revenueBasis: string;
  report?: string;
  asOf?: number;
}

interface RefLikeForParams {
  refId?: unknown;
  kind?: unknown;
  payload?: unknown;
}

/**
 * 从本轮存证 refs 中提取敏感性测算参数。
 *
 * ADR-0001 决策 1：参数必须来自真实财报字段（`lookupFinancialReport` 的返回），
 * 因此这里只认 `kind === 'financials'` 的存证，且**关键字段缺一不可**。
 * 缺字段返回 null，由 UI 明确提示"本轮未取得可测算的财务参数" ——
 * 绝不用部分参数凑一个数字出来（那是幻觉里最难发现的一种）。
 */
export function extractSensitivityParams(
  refs: readonly RefLikeForParams[],
): SensitivityInjectParams | null {
  for (const r of refs) {
    if (r.kind !== 'financials') continue;
    const p = asObjForParams(r.payload);
    if (p === null) continue;

    const nested = asObjForParams(p.data) ?? {};
    const pick = (k: string): unknown => p[k] ?? nested[k];

    const baseRevenue = pick('baseRevenue');
    const netMargin = pick('netMargin');
    const taxRate = pick('taxRate');
    const basisRaw = pick('revenueBasis');
    const refId = typeof r.refId === 'string' ? r.refId : undefined;

    if (!refId) continue;
    if (!Number.isFinite(baseRevenue)) continue;
    if (!Number.isFinite(netMargin)) continue;
    if (!Number.isFinite(taxRate)) continue;

    return {
      refId,
      baseRevenue: baseRevenue as number,
      netMargin: netMargin as number,
      taxRate: taxRate as number,
      revenueBasis: typeof basisRaw === 'string' ? basisRaw : 'missing',
      report: typeof nested.report === 'string' ? nested.report : undefined,
      asOf: Number.isFinite(p.asOf) ? (p.asOf as number) : undefined,
    };
  }
  return null;
}

function asObjForParams(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}
