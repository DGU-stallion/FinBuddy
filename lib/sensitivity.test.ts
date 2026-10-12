import { describe, it, expect } from 'vitest';
import {
  computeSensitivity,
  revenueDeclineRange,
  describeBasis,
  extractSensitivityParams,
  SLIDER_MIN_PCT,
  SLIDER_MAX_PCT,
} from './sensitivity';

/**
 * Seam 9: 确定性敏感性测算引擎（T5 营收冲击推演，ADR-0001 决策 1）
 *
 * 公共接口：
 *  - computeSensitivity({baseRevenue, netMargin, taxRate, declinePct}): 纯函数公式引擎
 *  - revenueDeclineRange(): 滑块区间（5%~30%）
 *  - describeBasis(params): 口径与时点的人类可读标注
 *
 * 抓到：公式算错、量纲混乱（百分比 vs 小数）、边界外取值、缺失参数被当作 0 静默计算。
 * 漏掉：参数本身是否真实（须能回溯到财报字段，由网关与存证抽屉保证）。
 *
 * 关键红线（ADR-0001 决策 1）：测算**零 LLM 参与**，全部由本纯函数计算。
 * 缺失参数必须显式返回 `ok: false`，绝不默认 0 后算出一个"看起来正常"的数字。
 */

describe('computeSensitivity（公式精度）', () => {
  it('票据给定参数下结果精确（误差 = 0）', () => {
    // ΔNetProfit = BaseRevenue × decline × NetMargin × (1 - TaxRate)
    // = 163e8 × 0.20 × 0.2236 × 0.85
    const r = computeSensitivity({
      baseRevenue: 163e8,
      netMargin: 22.36,
      taxRate: 15,
      declinePct: 20,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    const expected = 163e8 * 0.2 * 0.2236 * 0.85;
    // 误差必须为 0（同一浮点运算序列），不是"近似"
    expect(r.impact).toBe(expected);
    expect(r.expected).toBe(expected);
    // 硬编码字面值：防止"实现与测试共用同一错误公式"而双双通过
    expect(r.impact).toBe(619595600);
  });

  it('中际旭创真实 TTM 参数下量级正确（亿级）', () => {
    const r = computeSensitivity({
      baseRevenue: 124519000000, // 1245.19 亿
      netMargin: 35.27,
      taxRate: 15,
      declinePct: 10,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    // 1245.19亿 × 10% × 35.27% × 85% ≈ 37.3 亿
    expect(r.impact / 1e8).toBeCloseTo(37.33, 1);
  });

  it('下滑 0% 时冲击为 0', () => {
    const r = computeSensitivity({ baseRevenue: 163e8, netMargin: 22.36, taxRate: 15, declinePct: 0 });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.impact).toBe(0);
  });

  it('线性一阶：冲击与下滑幅度成正比', () => {
    const base = { baseRevenue: 163e8, netMargin: 22.36, taxRate: 15 };
    const a = computeSensitivity({ ...base, declinePct: 10 });
    const b = computeSensitivity({ ...base, declinePct: 20 });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) throw new Error('unreachable');
    expect(b.impact).toBeCloseTo(a.impact * 2, 6);
  });

  it('返回利润率后净利润（供 UI 展示"占原净利润比例"）', () => {
    const r = computeSensitivity({ baseRevenue: 163e8, netMargin: 22.36, taxRate: 15, declinePct: 20 });
    if (!r.ok) throw new Error('unreachable');
    const baseline = 163e8 * 0.2236 * 0.85; // 原净利润（税后）
    expect(r.baselineNetProfit).toBe(baseline);
    expect(r.impactRatioPct).toBeCloseTo(20, 6); // 下滑 20% 营收 → 净利润也降约 20%（线性）
  });

  it('缺失任一参数时显式返回 ok:false，绝不默认 0 静默计算', () => {
    expect(computeSensitivity({ baseRevenue: undefined, netMargin: 22.36, taxRate: 15, declinePct: 20 }).ok).toBe(false);
    expect(computeSensitivity({ baseRevenue: 163e8, netMargin: undefined, taxRate: 15, declinePct: 20 }).ok).toBe(false);
    expect(computeSensitivity({ baseRevenue: 163e8, netMargin: 22.36, taxRate: undefined, declinePct: 20 }).ok).toBe(false);
  });

  it('非有限数（NaN/Infinity）视为缺失', () => {
    expect(computeSensitivity({ baseRevenue: NaN, netMargin: 22.36, taxRate: 15, declinePct: 20 }).ok).toBe(false);
    expect(computeSensitivity({ baseRevenue: 163e8, netMargin: Infinity, taxRate: 15, declinePct: 20 }).ok).toBe(false);
  });

  it('净利率为 0 是合法输入（不误判为缺失）', () => {
    const r = computeSensitivity({ baseRevenue: 163e8, netMargin: 0, taxRate: 15, declinePct: 20 });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.impact).toBe(0);
  });

  it('下滑幅度超出滑块区间时拒绝（不让 UI 传出脏值）', () => {
    expect(computeSensitivity({ baseRevenue: 163e8, netMargin: 22.36, taxRate: 15, declinePct: -1 }).ok).toBe(false);
    expect(computeSensitivity({ baseRevenue: 163e8, netMargin: 22.36, taxRate: 15, declinePct: 101 }).ok).toBe(false);
  });

  it('确定性：同输入同输出', () => {
    const args = { baseRevenue: 163e8, netMargin: 22.36, taxRate: 15, declinePct: 17 };
    expect(computeSensitivity(args)).toEqual(computeSensitivity(args));
  });
});

describe('revenueDeclineRange（滑块区间）', () => {
  it('区间为 5%~30%（spec 交互决策）', () => {
    expect(SLIDER_MIN_PCT).toBe(5);
    expect(SLIDER_MAX_PCT).toBe(30);
    const r = revenueDeclineRange();
    expect(r.min).toBe(5);
    expect(r.max).toBe(30);
  });

  it('区间内取值均可计算', () => {
    for (let p = SLIDER_MIN_PCT; p <= SLIDER_MAX_PCT; p++) {
      const res = computeSensitivity({ baseRevenue: 163e8, netMargin: 22.36, taxRate: 15, declinePct: p });
      expect(res.ok).toBe(true);
    }
  });
});

describe('describeBasis（口径与时点标注，ADR-0001 决策 4）', () => {
  it('标注 TTM 口径与报告期，不得静默换口径', () => {
    const s = describeBasis({ revenueBasis: 'TTM', report: '2026-2', asOf: Date.UTC(2026, 9, 12) });
    expect(s).toContain('TTM');
    expect(s).toContain('2026-2');
    expect(s).toContain('2026-10-12');
  });

  it('降级口径显式标注"单季×4"', () => {
    const s = describeBasis({ revenueBasis: 'latest_quarter_x4', report: '2026-2', asOf: Date.UTC(2026, 9, 12) });
    expect(s).toMatch(/单季|×4/);
  });

  it('口径缺失时写"缺失"而非留空', () => {
    const s = describeBasis({ revenueBasis: undefined, report: undefined, asOf: 0 });
    expect(s).toContain('缺失');
  });
});

describe('extractSensitivityParams（从存证 refs 注入参数，T5 参数注入）', () => {
  it('从 financials payload 取基准营收/净利率/税率与口径', () => {
    const p = extractSensitivityParams([
      {
        refId: 'ref_3',
        kind: 'financials',
        payload: {
          refId: 'ref_3',
          source: '扶摇 · 利润表/财务指标',
          asOf: Date.UTC(2026, 9, 12),
          isFallback: false,
          baseRevenue: 1112821442000,
          revenueBasis: 'TTM',
          netMargin: 16.9837,
          taxRate: 15,
          data: { thscode: '300750.SZ', report: '2026-2' },
        },
      },
    ]);
    expect(p).not.toBeNull();
    expect(p!.baseRevenue).toBe(1112821442000);
    expect(p!.netMargin).toBe(16.9837);
    expect(p!.taxRate).toBe(15);
    expect(p!.revenueBasis).toBe('TTM');
    expect(p!.report).toBe('2026-2');
    expect(p!.refId).toBe('ref_3');
  });

  it('无 financials 存证时返回 null（不伪造参数）', () => {
    expect(extractSensitivityParams([])).toBeNull();
    expect(
      extractSensitivityParams([{ refId: 'ref_1', kind: 'snapshot', payload: { data: {} } }]),
    ).toBeNull();
  });

  it('财务 payload 缺关键字段时返回 null（缺参数不算数，由 UI 明确提示不可测算）', () => {
    expect(
      extractSensitivityParams([
        { refId: 'ref_3', kind: 'financials', payload: { refId: 'ref_3', baseRevenue: 100 } },
      ]),
    ).toBeNull();
  });

  it('多个 financials 存证时取第一个（确定性）', () => {
    const mk = (refId: string, rev: number) => ({
      refId,
      kind: 'financials',
      payload: { refId, baseRevenue: rev, netMargin: 10, taxRate: 15, revenueBasis: 'TTM', data: {} },
    });
    expect(extractSensitivityParams([mk('ref_3', 111), mk('ref_9', 999)])!.baseRevenue).toBe(111);
  });

  it('确定性：同输入同输出', () => {
    const refs = [
      { refId: 'ref_3', kind: 'financials', payload: { refId: 'ref_3', baseRevenue: 1, netMargin: 2, taxRate: 3, revenueBasis: 'TTM', data: {} } },
    ];
    expect(extractSensitivityParams(refs)).toEqual(extractSensitivityParams(refs));
  });
});
