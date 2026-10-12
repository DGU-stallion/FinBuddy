import { describe, it, expect } from 'vitest';
import { validateAnalysisOutput, extractSection, type OutputContext } from './output-contract';

/**
 * Seam 5: 输出契约校验（票 T3「强制三栏输出」「无买卖结论」「降级与真空期声明」）
 *
 * 公共接口：
 *  - extractSection(text, name): 抽出【X】栏的正文（供前端分栏渲染复用）
 *  - validateAnalysisOutput(text, ctx): 校验成稿是否满足契约，返回违规清单
 *
 * 抓到：三栏缺失/为空、正文夹带买卖结论、编造角标、
 *       L2 降级未声明非实时与抓取日期、L3 真空期被脑补成结论。
 * 漏掉：三栏内容与命题是否真相关、论证是否成立（语义质量，不可测）。
 *
 * 关键红线（题目硬要求）：三栏不得为空、不得输出买卖指令或收益承诺、
 * 数据缺失不得静默生成正常结论。
 * 契约校验跑在模型成稿之后，是最后一道确定性防线：违规时上层追加
 * 确定性修复块（不用模型二次生成，避免污染）。
 */

function ctx(over: Partial<OutputContext> = {}): OutputContext {
  return { refIds: ['ref_1', 'ref_2'], fallbackRefs: [], vacuumSubQuestions: [], ...over };
}

/** 真空期子问题：携带网关实际用过的检索关键词（真实存在的数据，非推断）。 */
const VACUUM_ITEM = { question: '大客户砍单传闻是否有官方披露？', keyword: '砍单' };

const CONFORMING = `【意图解析】
- 标的: 中际旭创
- 事件: 大客户砍单传闻
- 核验维度: 财务支撑与官方披露

【命题重构】
中际旭创当前业绩表现强劲，不存在重大经营风险。

【支持证据】
- TTM 年化营收 1245.19 亿元，净利率 35.27%[^ref_2]。

【反对证据】
- 最新收盘 724.47 元，单日 -6.41%，市场情绪偏弱[^ref_1]。

【无法验证项】
- 大客户砍单传闻未在法定披露中出现，当前处于信息真空期，无法核验。

【敏感性测算】
营收下滑 20% 时净利润冲击见下方卡片。

【追问】
1. 其三季报毛利率能否抵御营收下滑冲击？
2. 同行竞品是否有类似披露？
3. 最新公告如何解释本次异动？`;

describe('extractSection', () => {
  it('抽出指定栏的内容，止于下一栏标题', () => {
    const s = extractSection(CONFORMING, '支持证据');
    expect(s).toContain('1245.19');
    expect(s).not.toContain('反对证据');
    expect(s).not.toContain('724.47');
  });

  it('栏不存在时返回 null（与"栏存在但为空"区分）', () => {
    expect(extractSection('没有分栏的正文', '支持证据')).toBeNull();
  });

  it('栏存在但为空时返回空串', () => {
    const s = extractSection('【支持证据】\n【反对证据】\n- x', '支持证据');
    expect(s).toBe('');
  });
});

describe('validateAnalysisOutput', () => {
  it('合规成稿通过', () => {
    const r = validateAnalysisOutput(CONFORMING, ctx());
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('缺栏时报告 missing_section', () => {
    const text = CONFORMING.replace(/【无法验证项】[\s\S]*?(?=\n【敏感性测算】)/, '');
    const r = validateAnalysisOutput(text, ctx());
    expect(r.ok).toBe(false);
    const v = r.violations.find((x) => x.code === 'missing_section');
    expect(v?.detail).toContain('无法验证项');
  });

  it('栏存在但内容为空（占位符）时报告 shallow_placeholder', () => {
    const text = CONFORMING.replace(
      /【反对证据】\n[\s\S]*?\n\n【无法验证项】/,
      '【反对证据】\n无\n\n【无法验证项】',
    );
    const r = validateAnalysisOutput(text, ctx());
    expect(r.ok).toBe(false);
    const v = r.violations.find((x) => x.code === 'shallow_placeholder');
    expect(v?.detail).toContain('反对证据');
  });

  it('正文夹带买卖结论时报告 trade_conclusion', () => {
    const text = CONFORMING.replace('市场情绪偏弱[^ref_1]。', '建议买入，满仓介入可翻倍[^ref_1]。');
    const r = validateAnalysisOutput(text, ctx());
    expect(r.ok).toBe(false);
    const v = r.violations.find((x) => x.code === 'trade_conclusion');
    expect(v).toBeDefined();
  });

  it('编造角标时报告 fabricated_citation 并列出失效 id', () => {
    const text = CONFORMING.replace('[^ref_2]', '[^ref_9]');
    const r = validateAnalysisOutput(text, ctx());
    const v = r.violations.find((x) => x.code === 'fabricated_citation');
    expect(v?.detail).toContain('ref_9');
  });

  it('L2 降级时未声明「非实时」与抓取日期，报告 missing_fallback_disclosure', () => {
    const fallbackCtx = ctx({
      fallbackRefs: [{ refId: 'ref_1', asOf: Date.UTC(2026, 9, 1, 6, 30), note: '抓取于 2026-10-01' }],
    });
    const r = validateAnalysisOutput(CONFORMING, fallbackCtx);
    expect(r.violations.map((v) => v.code)).toContain('missing_fallback_disclosure');

    const disclosed = CONFORMING.replace(
      '【支持证据】',
      '⚠️ 本次行情为降级存证数据，非实时行情，抓取日期 2026-10-01。\n\n【支持证据】',
    );
    const r2 = validateAnalysisOutput(disclosed, fallbackCtx);
    expect(r2.violations.map((v) => v.code)).not.toContain('missing_fallback_disclosure');
  });

  it('真空期子问题未在【无法验证项】中说明时，报告 missing_vacuum_disclosure', () => {
    const vacuumCtx = ctx({ vacuumSubQuestions: [VACUUM_ITEM] });
    const text = CONFORMING.replace(
      /【无法验证项】\n[\s\S]*?\n\n【敏感性测算】/,
      '【无法验证项】\n- 客户集中度无法核验。\n\n【敏感性测算】',
    );
    const r = validateAnalysisOutput(text, vacuumCtx);
    const v = r.violations.find((x) => x.code === 'missing_vacuum_disclosure');
    expect(v?.detail).toContain('大客户砍单传闻');
  });

  describe('正文必须挂角标（票面：所有事实挂 refId 角标）', () => {
    const NO_CITE = `【命题重构】
X 公司业绩强劲。

【支持证据】
- 营收同比增长。

【反对证据】
- 现金流承压。

【无法验证项】
- 客户集中度处于信息真空期，无法核验。

【敏感性测算】
基于 TTM 营收。`;

    it('工具返回了数据但正文零角标 → no_citations', () => {
      const r = validateAnalysisOutput(NO_CITE, ctx());
      const v = r.violations.find((x) => x.code === 'no_citations');
      expect(v).toBeDefined();
      expect(v?.detail).toContain('角标');
    });

    it('本轮工具全部失败（无任何 refId）时，零角标不算违规', () => {
      // 上游全挂时正文本就无事实可引，此时报违规是假阳性
      const r = validateAnalysisOutput(NO_CITE, ctx({ refIds: [] }));
      expect(r.violations.map((x) => x.code)).not.toContain('no_citations');
    });

    it('挂了合法角标则不报 no_citations', () => {
      const r = validateAnalysisOutput(CONFORMING, ctx());
      expect(r.violations.map((x) => x.code)).not.toContain('no_citations');
    });
  });

  it('真空期已在【无法验证项】中声明时通过', () => {
    const vacuumCtx = ctx({ vacuumSubQuestions: [VACUUM_ITEM] });
    const r = validateAnalysisOutput(CONFORMING, vacuumCtx);
    expect(r.violations).toEqual([]);
  });

  describe('真空期匹配必须是容错的（真机发现：按检索 keyword 字面匹配会误报）', () => {
    // iFinD 失败 → vacuum=true，route 用工具调用时的 keyword 作匹配串。
    // keyword 形如 "客户 订单"（检索用词，空格连接），而模型在【无法验证项】里
    // 写的是自然语言。按整串字面匹配必然失败 → 每个真空期都误报违规。
    const KEYWORD_ITEM = { question: '客户订单是否有披露？', keyword: '客户 订单' };
    const NATURAL_BODY = CONFORMING.replace(
      /【无法验证项】\n[\s\S]*?\n\n【敏感性测算】/,
      '【无法验证项】\n- 大客户营收占比未在法定披露中出现，处于信息真空期，无法核验。\n\n【敏感性测算】',
    );

    it('keyword 的任一实词命中即视为已声明（不要求整串字面出现）', () => {
      const r = validateAnalysisOutput(NATURAL_BODY, ctx({ vacuumSubQuestions: [KEYWORD_ITEM] }));
      expect(r.violations.map((v) => v.code)).not.toContain('missing_vacuum_disclosure');
    });

    it('keyword 的所有实词都没出现时仍然报违规（不放水）', () => {
      const r = validateAnalysisOutput(
        CONFORMING.replace(
          /【无法验证项】\n[\s\S]*?\n\n【敏感性测算】/,
          '【无法验证项】\n- 存货周转天数无法核验。\n\n【敏感性测算】',
        ),
        ctx({ vacuumSubQuestions: [KEYWORD_ITEM] }),
      );
      expect(r.violations.map((v) => v.code)).toContain('missing_vacuum_disclosure');
    });

    it('无 keyword 时退化为按子问题文本匹配', () => {
      const r = validateAnalysisOutput(NATURAL_BODY, {
        ...ctx(),
        vacuumSubQuestions: [{ question: '大客户营收占比是多少？' }],
      });
      expect(r.violations.map((v) => v.code)).not.toContain('missing_vacuum_disclosure');
    });

    it('只提到主题词但未声明"真空/无法核验"状态 → 仍报违规（不得脑补）', () => {
      // 反例：正文提到"客户"，但把它写成了正常结论，没有说明信息真空期。
      // 若只按主题词重合判定，这种脑补会被放过 —— 违反 ADR-0001 决策 2。
      const evasive = CONFORMING.replace(
        /【无法验证项】\n[\s\S]*?\n\n【敏感性测算】/,
        '【无法验证项】\n- 客户与订单情况已在公告中有所体现。\n\n【敏感性测算】',
      );
      const r = validateAnalysisOutput(evasive, ctx({ vacuumSubQuestions: [KEYWORD_ITEM] }));
      expect(r.violations.map((v) => v.code)).toContain('missing_vacuum_disclosure');
    });
  });
});
