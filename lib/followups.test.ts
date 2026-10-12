import { describe, it, expect } from 'vitest';
import { sanitizeFollowUps, isVerificationOriented } from './followups';
import { detectTradeSeeking } from './compliance';

/**
 * Seam 6: 核验向追问过滤（ADR-0002 补充决策 5）
 *
 * 公共接口：
 *  - isVerificationOriented(q): 单个追问是否核验向（证伪/下钻/对比）
 *  - sanitizeFollowUps(raw, opts): 过滤、去重、补齐到恰好 3 个
 *
 * 抓到：操作向追问、收益承诺向追问、重复项、非字符串脏数据、数量不足。
 * 漏掉：追问「逻辑递进」的语义质量（模型行为，不可测）。
 *
 * 关键红线（ADR-0002）：追问只能核验向，绝不能是操作向；
 * 数量恒为 3（票面要求），不足时确定性兜底补齐而不是少给。
 */

describe('isVerificationOriented', () => {
  it('接受核验向追问（与票面例子对齐）', () => {
    expect(isVerificationOriented('其三季报毛利率能否抵御营收下滑冲击？')).toBe(true);
    expect(isVerificationOriented('同行竞品是否有类似披露？')).toBe(true);
    expect(isVerificationOriented('最近几个季度的营收增速是多少？')).toBe(true);
  });

  it('拒绝操作向追问（索取买卖决策）', () => {
    expect(isVerificationOriented('现在该不该买入？')).toBe(false);
    expect(isVerificationOriented('要不要上车？')).toBe(false);
  });

  it('拒绝收益承诺/预测向追问', () => {
    expect(isVerificationOriented('这个能翻倍吗？')).toBe(false);
    expect(isVerificationOriented('目标价是多少？')).toBe(false);
  });

  it('拒绝既无核验标记也无操作语言的空泛问题', () => {
    expect(isVerificationOriented('这只股票怎么样？')).toBe(false);
  });

  it('空串与纯空白不为核验向', () => {
    expect(isVerificationOriented('')).toBe(false);
    expect(isVerificationOriented('   ')).toBe(false);
  });
});

describe('sanitizeFollowUps', () => {
  const opts = { subject: '中际旭创' };

  it('保留 3 条合法追问，顺序不变（递进顺序由模型给定）', () => {
    const raw = [
      '其三季报毛利率能否抵御冲击？',
      '同行竞品的毛利率对比如何？',
      '最新公告是否提及大客户订单变动？',
    ];
    expect(sanitizeFollowUps(raw, opts)).toEqual(raw);
  });

  it('剔除操作向追问', () => {
    const raw = ['现在该不该买入？', '同行竞品的毛利率对比如何？', '最新公告是否提及订单变动？'];
    const out = sanitizeFollowUps(raw, opts);
    expect(out).toHaveLength(3);
    expect(out).not.toContain('现在该不该买入？');
    expect(out.join()).not.toContain('该不该');
  });

  it('去重', () => {
    const raw = ['同行竞品的毛利率对比如何？', '同行竞品的毛利率对比如何？'];
    const out = sanitizeFollowUps(raw, opts);
    expect(new Set(out).size).toBe(3);
  });

  it('全部非法/脏数据时用确定性兜底补齐到 3 条（数量契约优先）', () => {
    const out = sanitizeFollowUps([null, 42, '现在该不该买入？'], opts);
    expect(out).toHaveLength(3);
    expect(out.every((q) => isVerificationOriented(q))).toBe(true);
  });

  it('非数组输入不抛错，直接兜底', () => {
    const out = sanitizeFollowUps('一段文字', opts);
    expect(out).toHaveLength(3);
    expect(out.every((q) => isVerificationOriented(q))).toBe(true);
  });

  it('兜底追问本身过合规层（不能是操作向的伪装）', async () => {
    const out = sanitizeFollowUps([], { subject: '中际旭创' });
    for (const q of out) {
      const v = await detectTradeSeeking(q, { llmJudge: async () => false });
      expect(v.blocked).toBe(false);
    }
  });

  it('兜底追问确定性：同输入两次结果一致', () => {
    expect(sanitizeFollowUps([], opts)).toEqual(sanitizeFollowUps([], opts));
  });
});
