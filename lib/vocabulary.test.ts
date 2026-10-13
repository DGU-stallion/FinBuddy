import { describe, it, expect } from 'vitest';
import {
  TRADE_ACTION_TERMS,
  RESEARCH_SENSITIVE_TERMS,
  GUARANTEE_TERMS,
  AMBIGUOUS_FINANCE_TERMS,
  containsTradeAction,
  containsGuarantee,
  containsAmbiguousTradeAction,
} from './vocabulary';
import { scanForbiddenPhrases } from './compliance';
import { scanPredictionLanguage } from './analysis';
import { isVerificationOriented } from './followups';

/**
 * Seam 14: 跨 seam 共享的合规词表（单一事实来源）
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

describe('财务术语歧义词消歧（T4 真机回归发现的误报）', () => {
  it('「经营杠杆/固定成本杠杆/杠杆水平」是术语，不算操作指令', () => {
    // 这四句都来自真机输出，曾被误判为 trade_conclusion（8 次运行 5 次误报）
    for (const s of [
      '该测算忽略固定成本杠杆、产品结构变化与汇兑因素，属线性近似。',
      '光模块为重资产、高经营杠杆行业，营收下行阶段毛利率通常会同步压缩。',
      '据此推算资产负债率约 36.1%，杠杆水平上行。',
      '总负债同比 +82.0%，杠杆抬升速度明显高于资产增速。',
    ]) {
      expect(containsAmbiguousTradeAction(s, AMBIGUOUS_FINANCE_TERMS), `不应误报：${s}`).toBe(false);
    }
  });

  it('真正的杠杆操作指令仍必须命中', () => {
    for (const s of [
      '加五倍杠杆干进去',
      '建议用杠杆放大收益',
      '上杠杆梭哈',
      '配杠杆买入',
      '杠杆买入',
    ]) {
      expect(containsAmbiguousTradeAction(s, AMBIGUOUS_FINANCE_TERMS), `应拦：${s}`).toBe(true);
    }
  });

  it('同一文本里既有术语又有操作时，按操作处理（不漏）', () => {
    const s = '虽然公司经营杠杆高，但我建议加杠杆买入。';
    expect(containsAmbiguousTradeAction(s, AMBIGUOUS_FINANCE_TERMS)).toBe(true);
  });

  it('无操作标记时视为术语（默认放行，避免狼来了效应）', () => {
    // 取向变更：假阳性代价高于假阴性（详见 containsAmbiguousTradeAction 注释），
    // 「杠杆一下」这类无操作前缀的写法按术语处理。
    expect(containsAmbiguousTradeAction('杠杆一下', AMBIGUOUS_FINANCE_TERMS)).toBe(false);
  });

  it('残留风险声明：未预料到的操作说法会漏报（已知边界，非零风险）', () => {
    // 这是设计取舍的显式代价：无操作标记 ⇒ 判为术语。
    // 兜底依赖系统提示词禁令 + 其它模式（建议买入/目标价/涨停等）。
    // 断言"此处确实会漏"，以免未来有人误以为覆盖是完备的。
    expect(containsAmbiguousTradeAction('杠杆一把梭', ['杠杆'])).toBe(false);
  });

  it('不含歧义词时直接返回 false', () => {
    expect(containsAmbiguousTradeAction('公司营收稳健增长', AMBIGUOUS_FINANCE_TERMS)).toBe(false);
  });

  it('歧义词不得同时留在 TRADE_ACTION_TERMS（否则消歧失效）', () => {
    const overlap = AMBIGUOUS_FINANCE_TERMS.filter((t) =>
      (TRADE_ACTION_TERMS as readonly string[]).includes(t),
    );
    expect(overlap).toEqual([]);
  });
});

describe('歧义消解的假阴性防护（不能被右侧术语词豁免掉真操作）', () => {
  it('「加杠杆扩张产能」是操作，不得因"扩张"被当作术语放行', () => {
    expect(containsAmbiguousTradeAction('加杠杆扩张产能', AMBIGUOUS_FINANCE_TERMS)).toBe(true);
  });

  it('「上杠杆率」这类别扭写法保守拦截（宁可多拦）', () => {
    // 该文本真实语义含糊，按"无法判定语境时视为操作"原则拦截
    expect(containsAmbiguousTradeAction('上杠杆率冲一波', AMBIGUOUS_FINANCE_TERMS)).toBe(true);
  });

  it('术语搭配继续放行（回归保护）', () => {
    for (const s of [
      '杠杆扩张速度快于资产扩张',
      '杠杆收缩有利于稳健经营',
      '经营杠杆系数较高',
    ]) {
      expect(containsAmbiguousTradeAction(s, AMBIGUOUS_FINANCE_TERMS), `不应误报：${s}`).toBe(false);
    }
  });
});

describe('真机输出的真实句子回归（防止再次误报）', () => {
  // 以下句子全部逐字摘自 2026-10-13 真机运行（中际旭创），
  // 曾被误判为 trade_conclusion 并触发前端契约违规告警。
  const REAL_TERMINOLOGY = [
    '该测算忽略固定成本杠杆、产品结构变化与汇兑因素，属线性近似。',
    '光模块为重资产、高经营杠杆行业，营收下行阶段毛利率通常会同步压缩。',
    '据此推算资产负债率约 36.1%，杠杆水平上行 [^ref_5]',
    '总负债同比 +82.0%，杠杆抬升速度明显高于资产增速。',
    '杠杆扩张速度快于资产扩张',
    '利润端运营养杠杆：毛利率 31.6%（2023）→33.3%',
    '显示"营收下滑 + 利润率压缩"的双重杠杆效应',
    '用于衡量营收与利润率对利润的杠杆弹性',
    '资产负债表未显示杠杆失控：2026 年 6 月末资产负债率 36%',
    '经营杠杆系数较高',
    '用于刻画经营杠杆的敏感度；未考虑毛利率随价格/结构变化的反身性',
    // Standard 轴评审补充：复合财务词（原来的"一字前缀过宽"会误报这些）
    '该公司利用杠杆效应扩大生产规模',
    '费用杠杆对利润的放大作用显著',
    '信用杠杆水平处于历史低位',
    '使用杠杆比率衡量资本结构',
    '带杠杆的ETF需注意波动',
    '利用杠杆提升ROE',
    '经营杠杆与财务杠杆的合成效应',
  ];

  it('真实术语句子一律不误报（8 次运行曾误报 5 次以上）', () => {
    for (const s of REAL_TERMINOLOGY) {
      expect(containsAmbiguousTradeAction(s, AMBIGUOUS_FINANCE_TERMS), `误报：${s}`).toBe(false);
      expect(scanPredictionLanguage(s), `输出侧误报：${s}`).toEqual([]);
    }
  });

  it('真实操作句式仍必须拦住（不得因消歧而漏）', () => {
    for (const s of [
      '加五倍杠杆干进去',
      '建议用杠杆放大收益',
      '上杠杆梭哈',
      '杠杆买入',
      '我要加杠杆',
      '杠杆满仓干',
      '上三成杠杆',
      '用杠杆放大收益',
      '带杠杆冲进去',
      '我要上五倍杠杆',
    ]) {
      expect(containsAmbiguousTradeAction(s, AMBIGUOUS_FINANCE_TERMS), `漏报：${s}`).toBe(true);
    }
  });
});

describe('Standard 轴评审 #1：一字前缀过宽造成的术语误报', () => {
  // 真缺陷：'利用杠杆/费用杠杆/信用杠杆/使用杠杆/带杠杆' 里的 用/带 被当作操作前缀。
  // 与原始 '杠杆' 误报同类（只是换成复合词形态），会造成对**正确输出**的违规告警。
  const cases = [
    '该公司利用杠杆效应扩大生产规模',
    '费用杠杆对利润的放大作用显著',
    '信用杠杆水平处于历史低位',
    '使用杠杆比率衡量资本结构',
    '带杠杆的ETF需注意波动',
    '利用杠杆提升ROE',
    '经营杠杆与财务杠杆的合成效应',
  ];

  it('含"用/带"的复合财务词一律不误报', () => {
    for (const s of cases) {
      expect(containsAmbiguousTradeAction(s, AMBIGUOUS_FINANCE_TERMS), `误报：${s}`).toBe(false);
      expect(scanPredictionLanguage(s), `输出侧误报：${s}`).toEqual([]);
    }
  });

  it('真正的操作句式仍必须命中（不得因收紧而漏）', () => {
    for (const s of [
      '加五倍杠杆干进去',
      '建议用杠杆放大收益',
      '用杠杆放大收益',
      '上杠杆梭哈',
      '配杠杆买入',
      '杠杆买入',
      '我要加杠杆',
      '上三成杠杆',
      '放杠杆',
    ]) {
      expect(containsAmbiguousTradeAction(s, AMBIGUOUS_FINANCE_TERMS), `漏报：${s}`).toBe(true);
    }
  });

  it('"带杠杆"单独出现时按术语处理（无操作动词搭配）', () => {
    expect(containsAmbiguousTradeAction('带杠杆的ETF', AMBIGUOUS_FINANCE_TERMS)).toBe(false);
    // 但带操作动词时命中
    expect(containsAmbiguousTradeAction('带杠杆冲进去', AMBIGUOUS_FINANCE_TERMS)).toBe(true);
  });
});
