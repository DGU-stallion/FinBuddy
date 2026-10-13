import { describe, it, expect } from 'vitest';
import { getFallbackFinancials, listFallbackCases } from './fallback';

/**
 * Seam 3b: L2 本地存证的财务参数部分
 *
 * 背景（T4 Spec 轴评审抓出的真实缺口）：原 L2 只预置了**行情快照**，
 * `lookupFinancialReport` 无降级分支。而 lib/fallback.ts 自述"让预置演示案例
 * 在断网时仍能走完整链路" —— 断网时 T5 的测算卡片（"完整链路"的定量那一环）
 * 会直接消失，而未断网时它是在的。
 *
 * 抓到：财务参数无降级、降级财务数据缺少口径/时点标注、非预置标的被误降级。
 * 漏掉：真实网络的超时行为（gateway.integration.test.ts 覆盖）。
 *
 * 关键红线（ADR-0001 决策 3）：仅覆盖预置案例；必须带抓取日期与"非实时"；
 * 自由查询**不得**走 L2（否则等于用过期数据冒充正常结论）。
 */

describe('getFallbackFinancials', () => {
  it('预置案例有财务参数兜底（含 TTM 口径与全部测算参数）', () => {
    for (const rec of listFallbackCases()) {
      const f = getFallbackFinancials(rec.thscode);
      expect(f, `${rec.thscode} 缺财务兜底`).not.toBeNull();
      expect(f!.baseRevenue).toBeGreaterThan(1e9);
      expect(f!.revenueBasis).toBe('TTM');
      expect(Number.isFinite(f!.netMargin)).toBe(true);
      expect(Number.isFinite(f!.grossMargin)).toBe(true);
      expect(Number.isFinite(f!.taxRate)).toBe(true);
      expect(f!.report).toMatch(/^\d{4}-\d$/);
    }
  });

  it('必须带抓取日期与非实时说明（不得冒充最新报告期）', () => {
    const f = getFallbackFinancials(listFallbackCases()[0].thscode)!;
    expect(f.asOf).toBeGreaterThan(0);
    expect(f.note).toMatch(/抓取|非实时/);
  });

  it('非预置标的返回 null（自由查询不得走 L2）', () => {
    expect(getFallbackFinancials('600519.SH')).toBeNull();
    expect(getFallbackFinancials('')).toBeNull();
  });

  it('大小写与空白容错（与 getFallbackSnapshot 行为一致）', () => {
    const code = listFallbackCases()[0].thscode;
    expect(getFallbackFinancials(` ${code.toLowerCase()} `)?.baseRevenue).toBe(
      getFallbackFinancials(code)!.baseRevenue,
    );
  });
});
