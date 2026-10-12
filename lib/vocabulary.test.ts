import { describe, it, expect } from 'vitest';
import {
  TRADE_ACTION_TERMS,
  RESEARCH_SENSITIVE_TERMS,
  GUARANTEE_TERMS,
  containsTradeAction,
  containsGuarantee,
} from './vocabulary';
import { scanForbiddenPhrases } from './compliance';
import { scanPredictionLanguage } from './analysis';
import { isVerificationOriented } from './followups';

/**
 * Seam 8: 跨 seam 共享的合规词表（单一事实来源）
 *
 * 背景（T3 code-review Standards 轴发现）：买入/卖出类词表曾在 3 处各自维护
 * （lib/compliance.ts 输入侧、lib/analysis.ts 输出侧、lib/followups.ts 追问侧），
 * 已经漂移出真实漏洞：`止损`/`止盈` 在输入侧被拦，输出侧却不扫描 ——
 * 模型在正文里写「建议止损」能通过输出契约校验。
 *
 * 本模块只收纳**确有共识**的操作动词与承诺词；各 seam 的句式差异
 * （输入侧需要研究性语境过滤、输出侧需要预测句式）仍留在各自模块。
 */

describe('共享词表的一致性契约', () => {
  it('无歧义操作动词：输入侧与输出侧都必须拦（不得再漂移）', () => {
    for (const term of TRADE_ACTION_TERMS) {
      const sentence = `建议${term}`;
      expect(scanForbiddenPhrases(sentence), `输入侧应拦「${sentence}」`).not.toEqual([]);
      expect(scanPredictionLanguage(sentence), `输出侧应扫到「${sentence}」`).not.toEqual([]);
    }
  });

  it('研究敏感词：输出侧必须扫到（正文不该出现操作导向表述）', () => {
    for (const term of RESEARCH_SENSITIVE_TERMS) {
      expect(
        scanPredictionLanguage(`建议${term}`),
        `输出侧应扫到「${term}」`,
      ).not.toEqual([]);
    }
  });

  it('研究敏感词：输入侧保留语境豁免（ADR-0002 修正 7，不得一刀切）', () => {
    // 资金流/评级语境中的"买入/卖出"是术语名词，不能误杀研究性问题
    for (const term of RESEARCH_SENSITIVE_TERMS) {
      const research = `北向资金最近在${term}吗？`;
      expect(scanForbiddenPhrases(research), `不应误拦「${research}」`).toEqual([]);
    }
  });

  it('输入侧拦截的每一个承诺词，输出侧也必须能扫描到', () => {
    for (const term of GUARANTEE_TERMS) {
      expect(scanForbiddenPhrases(term), `输入侧应拦「${term}」`).not.toEqual([]);
      expect(scanPredictionLanguage(term), `输出侧应扫到「${term}」`).not.toEqual([]);
    }
  });

  it('追问侧不得放行任何操作动词', () => {
    for (const term of TRADE_ACTION_TERMS) {
      expect(
        isVerificationOriented(`现在要不要${term}？`),
        `追问侧应拒绝涉及「${term}」的追问`,
      ).toBe(false);
    }
  });

  it('词表非空且无重复（防止误删/重复维护）', () => {
    expect(TRADE_ACTION_TERMS.length).toBeGreaterThan(5);
    expect(GUARANTEE_TERMS.length).toBeGreaterThan(2);
    expect(new Set(TRADE_ACTION_TERMS).size).toBe(TRADE_ACTION_TERMS.length);
    expect(new Set(GUARANTEE_TERMS).size).toBe(GUARANTEE_TERMS.length);
  });

  it('两个操作词表不得重叠（重叠会导致规则归属不清）', () => {
    const overlap = TRADE_ACTION_TERMS.filter((t) =>
      (RESEARCH_SENSITIVE_TERMS as readonly string[]).includes(t),
    );
    expect(overlap).toEqual([]);
  });
});

describe('containsTradeAction / containsGuarantee', () => {
  it('命中操作动词', () => {
    expect(containsTradeAction('建议止损')).toBe(true);
    expect(containsTradeAction('马上止盈离场')).toBe(true);
    expect(containsTradeAction('公司营收增长')).toBe(false);
  });

  it('命中承诺词', () => {
    expect(containsGuarantee('稳赚不赔')).toBe(true);
    expect(containsGuarantee('毛利率提升')).toBe(false);
  });

  it('不误伤财务术语：持股/持有股份不是操作动词', () => {
    expect(containsTradeAction('控股股东持有 11% 股份')).toBe(false);
    expect(containsTradeAction('北向资金净买入')).toBe(true); // 由研究性语境在输入侧豁免
  });
});
