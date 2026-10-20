/**
 * 财务参数装配（见 ADR-0001 决策 1、补充决策 4）
 *
 * 基准营收口径优先级：TTM（最近四季滚动）> latest_quarter_x4（单季×4，降级）> missing。
 * 任何降级都必须在 basis 字段中标注，让上层能显式告知用户——不得静默换口径。
 */

export interface QuarterlyIncome {
  fiscalYear: number;
  fiscalPeriod: string;
  operatingIncome: number;
  netProfit: number;
  /** 税前利润（扶摇利润表 profit_total）。用于推导有效税率。 */
  profitTotal?: number;
  /** 所得税费用（扶摇利润表 income_tax_expense）。用于推导有效税率。 */
  incomeTaxExpense?: number;
}

export type RevenueBasis = 'TTM' | 'latest_quarter_x4' | 'missing';

export interface TTMResult {
  baseRevenue: number;
  netProfitTTM: number;
  basis: RevenueBasis;
  /**
   * 实际参与本轮**求和**的逐期营收（原始值 + 财年/季度标签）。
   *
   * 为什么必须暴露，而且**必须带标签**：
   * 口径错误（年内累计被当成单季相加）只能在"年内递增 + 年界骤降"
   * 这个结构上识别，而这两条都需要 `fiscal_year` / `fiscal_period`。
   * 真机自测证实：丢掉标签的纯数值启发式会直接漏报
   *（宁德时代 2769/1291/4237/2830 的差分比高达 24 倍，不呈等差）。
   * 供 `lib/reconcile.ts` 对账使用。
   */
  periods: Array<{ year?: number; period?: string; revenue: number }>;
}

/** 判断一期是否有可用的营收数据。 */
function hasRevenue(p: QuarterlyIncome): boolean {
  return typeof p.operatingIncome === 'number' && Number.isFinite(p.operatingIncome);
}

/**
 * 把按时间倒序的多期单季利润表拼成 TTM 年化营收。
 * 期数不足四季时降级为"最近有效单季 × 4"，并显式标注口径。
 */
export function sumTTM(periods: QuarterlyIncome[]): TTMResult {
  const valid = periods.filter(hasRevenue);

  if (valid.length === 0) {
    return { baseRevenue: 0, netProfitTTM: 0, basis: 'missing', periods: [] };
  }

  if (valid.length >= 4) {
    const last4 = valid.slice(0, 4);
    return {
      baseRevenue: last4.reduce((s, p) => s + p.operatingIncome, 0),
      netProfitTTM: last4.reduce((s, p) => s + p.netProfit, 0),
      basis: 'TTM',
      // 带标签：对账器靠"年内递增 + 年界骤降"识别累计口径（见 TTMResult 注释）
      periods: last4.map((p) => ({
        year: p.fiscalYear,
        period: p.fiscalPeriod,
        revenue: p.operatingIncome,
      })),
    };
  }

  const latest = valid[0];
  return {
    baseRevenue: latest.operatingIncome * 4,
    netProfitTTM: latest.netProfit * 4,
    basis: 'latest_quarter_x4',
    periods: valid.map((p) => ({
      year: p.fiscalYear,
      period: p.fiscalPeriod,
      revenue: p.operatingIncome,
    })),
  };
}

// ---------- 有效所得税率（取自真实字段，而非硬编码） ----------

export type TaxRateBasis = 'TTM' | 'partial';

export interface EffectiveTaxRate {
  /** 有效税率，百分比数值（如 14.84 表示 14.84%）。 */
  pct: number;
  /** 口径：满四季为 TTM，不足为 partial。 */
  basis: TaxRateBasis;
  /** 实际参与合并的期数。 */
  periodsUsed: number;
}

/**
 * 由利润表推导有效所得税率 = Σ所得税费用 / Σ税前利润。
 *
 * 为什么不能用固定值（T4 Spec 轴评审抓出的真实缺陷）：
 * 原实现把 `taxRate: 15` 写死，注释称"高新企业常见优惠税率"。但：
 *  1. 扶摇利润表**本来就返回** `income_tax_expense` 与 `profit_total`，
 *     有效税率是可推导的真实字段，没有理由硬编码（真机实测中际旭创 14.84%、
 *     宁德时代 14.54%，且逐季在 13.86%~16.18% 之间波动）。
 *  2. ADR-0001 决策 1 的硬要求是"测算的所有输入参数均可追溯到真实财报字段"。
 *     硬编码使三参数之一不满足该要求，而 UI 又与净利率并列展示，
 *     评委会把它当成真实财报数据。
 *  3. 对税率本就不同的标的（如适用 25% 标准税率）会产生系统性偏差。
 *
 * 口径说明：
 * - 用**加权合并**（Σ税/Σ税前）而非算术平均：季度利润额差异大，
 *   算术平均会让小季度获得过大权重。
 * - 税前利润 ≤ 0（亏损）的期不参与：负税率无经济意义，会污染合并值。
 * - 缺字段的期**跳过**而非当 0：当 0 会低估税率。
 * - 返回 null 表示**无法推导**，由调用方显式声明"税率缺失"并拒绝测算 ——
 *   绝不回退到一个"看起来正常"的默认值（那是幻觉里最难发现的一种）。
 */
export function effectiveTaxRate(periods: QuarterlyIncome[]): EffectiveTaxRate | null {
  const valid = periods.filter(
    (p) =>
      typeof p.profitTotal === 'number' &&
      Number.isFinite(p.profitTotal) &&
      p.profitTotal > 0 &&
      typeof p.incomeTaxExpense === 'number' &&
      Number.isFinite(p.incomeTaxExpense),
  );

  if (valid.length === 0) return null;

  const sumPretax = valid.reduce((s, p) => s + p.profitTotal!, 0);
  const sumTax = valid.reduce((s, p) => s + p.incomeTaxExpense!, 0);
  if (sumPretax <= 0) return null;

  return {
    pct: (sumTax / sumPretax) * 100,
    basis: valid.length >= 4 ? 'TTM' : 'partial',
    periodsUsed: valid.length,
  };
}
