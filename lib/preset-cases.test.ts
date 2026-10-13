import { describe, it, expect } from 'vitest';
import { PRESET_CASES, presetFor } from './preset-cases';
import { listFallbackCases } from './fallback';

/**
 * Seam 13: 预置案例（T5「一键触发完整链路」）
 *
 * 公共接口：PRESET_CASES / presetFor(thscode)
 *
 * 抓到：预置案例硬编码标的名（与 lib/fallback.ts 漂移）、
 *       案例数与兜底存证不匹配（演示时断链）。
 * 漏掉：案例的提问是否真能触发完整链路（需真机验证，见 scripts/t5-verify.mts）。
 *
 * 关键红线（票面/ADR-0001 决策 3）：预置案例必须与 lib/fallback.ts 的
 * 兜底存证**覆盖同一批标的** —— 否则断网演示时点进去却发现没有兜底数据。
 * 因此这里**不得硬编码**标的名，一律从 listFallbackCases() 派生。
 */

describe('PRESET_CASES', () => {
  it('与兜底存证覆盖同一批标的（不得硬编码漂移）', () => {
    const fallbackCodes = listFallbackCases().map((r) => r.thscode);
    const presetCodes = PRESET_CASES.map((c) => c.thscode);
    expect(presetCodes.sort()).toEqual(fallbackCodes.sort());
  });

  it('每个案例的标的名取自兜底存证（不自己写名字）', () => {
    for (const c of PRESET_CASES) {
      const rec = listFallbackCases().find((r) => r.thscode === c.thscode);
      expect(rec, `案例 ${c.thscode} 在兜底存证里不存在`).toBeDefined();
      expect(c.title).toContain(rec!.name);
    }
  });

  it('至少 2 个案例（票面要求：1 个主案例 + 1 个备选）', () => {
    expect(PRESET_CASES.length).toBeGreaterThanOrEqual(2);
  });

  it('每个案例都有非空的提问文本（一键可用，不需用户输入）', () => {
    for (const c of PRESET_CASES) {
      expect(c.question.trim().length).toBeGreaterThan(8);
      expect(c.title.trim()).not.toBe('');
    }
  });

  it('提问是核验向，不含买卖操作词（避免点进去先被合规拦下）', () => {
    for (const c of PRESET_CASES) {
      expect(c.question, `案例提问含操作词：${c.question}`).not.toMatch(
        /要不要|该不该|买入|卖出|加仓|满仓|杠杆|梭哈|止损/,
      );
    }
  });

  it('tscode 唯一（React key 与查找不歧义）', () => {
    const codes = PRESET_CASES.map((c) => c.thscode);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('确定性：同输入同输出', () => {
    expect(PRESET_CASES).toEqual(PRESET_CASES);
  });
});

describe('presetFor', () => {
  it('按 thscode 查到案例', () => {
    const first = PRESET_CASES[0];
    expect(presetFor(first.thscode)?.title).toBe(first.title);
  });

  it('未知代码返回 null（不猜）', () => {
    expect(presetFor('999999.SZ')).toBeNull();
    expect(presetFor('')).toBeNull();
  });
});
