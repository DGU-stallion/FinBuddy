import { describe, it, expect } from 'vitest';
import { sumTTM, type QuarterlyIncome } from './financials';

/**
 * Seam: sumTTM(periods) -> { baseRevenue, basis }
 * 公共接口：把按时间倒序的多期单季利润表拼成 TTM（最近四季滚动）年化营收。
 * 抓到：TTM 拼接逻辑、期数不足时的降级与口径标注。
 * 漏掉：扶摇接口的真实网络行为（集成层测）。
 *
 * 关键（ADR-0001 补充决策 4）：BaseRevenue 优先 TTM；无法拼出时降级为"单季×4"
 * 并必须在 basis 里标注口径，让上层能显式告知用户——不得静默换口径。
 */

const q = (year: number, period: string, revenue: number): QuarterlyIncome => ({
  fiscalYear: year,
  fiscalPeriod: period,
  operatingIncome: revenue,
  netProfit: revenue * 0.2,
});

describe('sumTTM', () => {
  it('四季齐全时返回四期之和，口径标记为 TTM', () => {
    const r = sumTTM([
      q(2026, 'Q2', 417.78e8),
      q(2026, 'Q1', 194.96e8),
      q(2025, 'Q4', 382.40e8),
      q(2025, 'Q3', 250.05e8),
    ]);
    expect(r.basis).toBe('TTM');
    expect(r.baseRevenue).toBeCloseTo((417.78 + 194.96 + 382.40 + 250.05) * 1e8, 0);
  });

  it('多于四季时只取最近四季（不把第五季也算进去）', () => {
    const r = sumTTM([
      q(2026, 'Q2', 400e8),
      q(2026, 'Q1', 100e8),
      q(2025, 'Q4', 100e8),
      q(2025, 'Q3', 100e8),
      q(2025, 'Q2', 9999e8), // 第五季，必须被排除
    ]);
    expect(r.baseRevenue).toBeCloseTo(700e8, 0);
    expect(r.basis).toBe('TTM');
  });

  it('期数不足四季时降级为单季×4，并显式标注口径（不静默换口径）', () => {
    const r = sumTTM([q(2026, 'Q2', 400e8)]);
    expect(r.basis).toBe('latest_quarter_x4');
    expect(r.baseRevenue).toBeCloseTo(1600e8, 0);
  });

  it('空数组时返回零营收并标记缺失，不抛异常', () => {
    const r = sumTTM([]);
    expect(r.baseRevenue).toBe(0);
    expect(r.basis).toBe('missing');
  });

  it('忽略缺失营收字段的期次', () => {
    const r = sumTTM([
      q(2026, 'Q2', 400e8),
      { fiscalYear: 2026, fiscalPeriod: 'Q1', operatingIncome: NaN, netProfit: 0 },
      q(2025, 'Q4', 100e8),
      q(2025, 'Q3', 100e8),
    ]);
    // 有效季只有 3 季 → 降级
    expect(r.basis).toBe('latest_quarter_x4');
    expect(r.baseRevenue).toBeCloseTo(1600e8, 0);
  });
});
