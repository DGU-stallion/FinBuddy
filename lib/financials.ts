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
}

export type RevenueBasis = 'TTM' | 'latest_quarter_x4' | 'missing';

export interface TTMResult {
  baseRevenue: number;
  netProfitTTM: number;
  basis: RevenueBasis;
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
    return { baseRevenue: 0, netProfitTTM: 0, basis: 'missing' };
  }

  if (valid.length >= 4) {
    const last4 = valid.slice(0, 4);
    return {
      baseRevenue: last4.reduce((s, p) => s + p.operatingIncome, 0),
      netProfitTTM: last4.reduce((s, p) => s + p.netProfit, 0),
      basis: 'TTM',
    };
  }

  const latest = valid[0];
  return {
    baseRevenue: latest.operatingIncome * 4,
    netProfitTTM: latest.netProfit * 4,
    basis: 'latest_quarter_x4',
  };
}
