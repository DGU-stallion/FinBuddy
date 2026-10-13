import { describe, it, expect } from 'vitest';
import { sumTTM, effectiveTaxRate, type QuarterlyIncome } from './financials';

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

// ---------- 有效所得税率（T4 Spec 轴评审发现的真实缺陷） ----------

describe('effectiveTaxRate（有效税率必须取自真实字段，不得硬编码）', () => {
  const p = (year: number, period: string, pretax: number, tax: number): QuarterlyIncome => ({
    fiscalYear: year,
    fiscalPeriod: period,
    operatingIncome: pretax,
    netProfit: pretax - tax,
    profitTotal: pretax,
    incomeTaxExpense: tax,
  });

  it('按 TTM 口径合并计算：Σ所得税 / Σ税前利润', () => {
    // 真机 300308.SZ 2026 前后四季（摘自扶摇利润表）
    const r = effectiveTaxRate([
      p(2026, 'Q2', 17230602545.84, 2497175782.71),
      p(2026, 'Q1', 7535801610.11, 1219009583.09),
      p(2025, 'Q4', 13599623819.76, 2019869711.77),
      p(2025, 'Q3', 8840494105.85, 1270763014.33),
    ]);
    expect(r).not.toBeNull();
    // 加权合并 ≈ 14.84%（真机实测值）
    expect(r!.pct).toBeCloseTo(14.84, 1);
    expect(r!.basis).toBe('TTM');
    expect(r!.periodsUsed).toBe(4);
  });

  it('宁德时代真实数据 ≈ 14.54%', () => {
    const r = effectiveTaxRate([
      p(2026, 'Q2', 55766857000, 8736218000),
      p(2026, 'Q1', 26681603000, 3944350000),
      p(2025, 'Q4', 89526545000, 12740236000),
      p(2025, 'Q3', 60712402000, 8415535000),
    ]);
    expect(r!.pct).toBeCloseTo(14.54, 1);
  });

  it('与简单平均不同：必须是加权（大额季度权重大）', () => {
    const r = effectiveTaxRate([
      p(2026, 'Q2', 1000, 100), // 10%
      p(2026, 'Q1', 9000, 2700), // 30%
    ]);
    // 加权 = 2800/10000 = 28%；算术平均 = 20%
    expect(r!.pct).toBeCloseTo(28, 6);
  });

  it('期数不足四季时降级为已有效期内合并，并标注 basis', () => {
    const r = effectiveTaxRate([p(2026, 'Q2', 1000, 150), p(2026, 'Q1', 1000, 150)]);
    expect(r!.basis).toBe('partial');
    expect(r!.periodsUsed).toBe(2);
    expect(r!.pct).toBeCloseTo(15, 6);
  });

  it('缺少字段时返回 null（绝不默认一个"看起来正常"的税率）', () => {
    expect(effectiveTaxRate([])).toBeNull();
    expect(
      effectiveTaxRate([
        { fiscalYear: 2026, fiscalPeriod: 'Q1', operatingIncome: 100, netProfit: 85 },
      ]),
    ).toBeNull();
  });

  it('税前利润为负（亏损）的期不参与合并（负税率无意义）', () => {
    const r = effectiveTaxRate([
      p(2026, 'Q2', 1000, 150),
      p(2026, 'Q1', -500, -100),
    ]);
    expect(r!.periodsUsed).toBe(1);
    expect(r!.pct).toBeCloseTo(15, 6);
  });

  it('未提供税率字段的期被跳过，而非当作 0（否则会低估税率）', () => {
    const r = effectiveTaxRate([
      p(2026, 'Q2', 1000, 150),
      { fiscalYear: 2026, fiscalPeriod: 'Q1', operatingIncome: 1000, netProfit: 900 },
    ]);
    expect(r!.periodsUsed).toBe(1);
    expect(r!.pct).toBeCloseTo(15, 6);
  });

  it('确定性：同输入同输出', () => {
    const periods = [p(2026, 'Q2', 1000, 150)];
    expect(effectiveTaxRate(periods)).toEqual(effectiveTaxRate(periods));
  });
});
