import { describe, it, expect } from 'vitest';
import {
  validateAnalysisPlan,
  scanPredictionLanguage,
  fallbackReframe,
  isVerificator,
} from './analysis';

/**
 * Seam 3: 命题重构与子问题拆解（ADR-0002 决策 3）
 *
 * 公共接口：
 *  - validateAnalysisPlan(raw): 校验并规范化 LLM 产出的分析计划
 *      → { ok: true, plan } | { ok: false, reason, message }
 *  - scanPredictionLanguage(text): 检测股价/收益预测句式（命题重构的安全网）
 *  - fallbackReframe(name): 确定性兜底命题（LLM 产出不合格时使用）
 *  - isVerificator(s): 判断子问题声明核验方是否属于已接入的网关工具
 *
 * 抓到：子问题数量越界、标的标签缺失、命题里夹带股价预测、模型编造工具名、
 *       原始 JSON 形状错误。
 * 漏掉：命题「好不好」的语义质量、子问题「是否真的可核验」（模型行为，不可测）。
 *
 * 关键红线（ADR-0002）：中性问题必须先有可证伪命题，三栏才有辩证基准；
 * 命题重构不得把股价预测/买卖指令夹带回来（那会让三栏退化成荐股）。
 * 关键产品约束（user story 4）：意图标签必须含标的标签，供 T4 标签微调与 T5 重跑。
 */

describe('validateAnalysisPlan', () => {
  const good = {
    reframedClaim: '中际旭创当前业绩表现强劲，不存在重大经营风险。',
    intentTags: ['标的: 中际旭创', '事件: 大客户砍单传闻', '核验维度: 财务支撑与官方披露'],
    subQuestions: [
      { question: '中际旭创最近报告期的营收与净利率是多少？', verificator: 'financials' },
      { question: '官方公告与新闻中是否有大客户砍单的披露？', verificator: 'announcements' },
    ],
  };

  it('合法计划通过并保留字段', () => {
    const r = validateAnalysisPlan(good);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.reframedClaim).toBe(good.reframedClaim);
    expect(r.plan.subQuestions).toHaveLength(2);
    expect(r.plan.subQuestions[0].verificator).toBe('financials');
  });

  it('子问题少于 2 个时拒绝（拆解不足，三栏无素材）', () => {
    const r = validateAnalysisPlan({
      ...good,
      subQuestions: [{ question: '营收多少？', verificator: 'financials' }],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('too_few_sub_questions');
  });

  it('子问题多于 3 个时拒绝（超出 5 步工具预算）', () => {
    const r = validateAnalysisPlan({
      ...good,
      subQuestions: [
        { question: 'a', verificator: 'financials' },
        { question: 'b', verificator: 'financials' },
        { question: 'c', verificator: 'financials' },
        { question: 'd', verificator: 'financials' },
      ],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('too_many_sub_questions');
  });

  it('缺少标的标签时拒绝（T4 标签微调与 T5 重跑都依赖它）', () => {
    const r = validateAnalysisPlan({
      ...good,
      intentTags: ['事件: 大客户砍单传闻', '核验维度: 财务支撑'],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('missing_ticker_tag');
  });

  it('命题中夹带股价预测时拒绝（否则三栏退化为荐股）', () => {
    const r = validateAnalysisPlan({
      ...good,
      reframedClaim: '中际旭创股价年底前会涨到 1000 元。',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('claim_not_falsifiable');
  });

  it('命题中夹带买卖指令时拒绝', () => {
    const r = validateAnalysisPlan({ ...good, reframedClaim: '建议买入中际旭创。' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('claim_not_falsifiable');
  });

  it('模型编造未接入的工具名时，该子问题降级为 unverifiable 而非拒绝整份计划', () => {
    const r = validateAnalysisPlan({
      ...good,
      subQuestions: [
        { question: '客户集中度是多少？', verificator: 'get_customer_concentration' },
        { question: '营收多少？', verificator: 'financials' },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.subQuestions[0].verificator).toBe('unverifiable');
  });

  it('原始形状错误（非对象/字段缺失/子问题非字符串）时拒绝', () => {
    expect(validateAnalysisPlan(null).ok).toBe(false);
    expect(validateAnalysisPlan('一段文字').ok).toBe(false);
    expect(validateAnalysisPlan({ reframedClaim: 'x', intentTags: [], subQuestions: [] }).ok).toBe(
      false,
    );
    const bad = validateAnalysisPlan({
      ...good,
      subQuestions: [{ question: 123, verificator: 'financials' }, good.subQuestions[1]],
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.reason).toBe('malformed');
  });

  it('规范化标签：去空白、丢弃空标签', () => {
    const r = validateAnalysisPlan({
      ...good,
      intentTags: ['  标的: 中际旭创  ', '', '  '],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.intentTags).toEqual(['标的: 中际旭创']);
  });
});

describe('scanPredictionLanguage', () => {
  it('命中股价/目标价类预测', () => {
    expect(scanPredictionLanguage('目标价 1200 元')).toContain('目标价');
    expect(scanPredictionLanguage('股价一定会涨')).not.toEqual([]);
    expect(scanPredictionLanguage('下周必涨停')).toContain('涨停');
  });

  it('命中收益承诺与操作指令', () => {
    expect(scanPredictionLanguage('稳赚不赔')).toContain('稳赚不赔');
    expect(scanPredictionLanguage('建议买入并加仓')).not.toEqual([]);
    expect(scanPredictionLanguage('满仓杠杆干进去')).not.toEqual([]);
  });

  it('不误伤基本面口径的可证伪命题', () => {
    expect(scanPredictionLanguage('中际旭创当前业绩强劲，无重大经营风险。')).toEqual([]);
    expect(scanPredictionLanguage('大客户砍单将导致营收下滑 30%、净利率承压。')).toEqual([]);
    expect(scanPredictionLanguage('当前毛利率能否抵御营收下滑冲击。')).toEqual([]);
  });
});

describe('fallbackReframe', () => {
  it('产出确定性兜底命题，且显式标注为待核验假设（不得被读成系统结论）', () => {
    const claim = fallbackReframe('中际旭创');
    expect(claim).toContain('中际旭创');
    expect(claim).toContain('待核验');
    expect(scanPredictionLanguage(claim)).toEqual([]);
  });

  it('同名调用结果稳定（确定性，无随机性）', () => {
    expect(fallbackReframe('宁德时代')).toBe(fallbackReframe('宁德时代'));
  });
});

describe('isVerificator', () => {
  it('只认可已接入的三个网关工具与 unverifiable', () => {
    expect(isVerificator('snapshot')).toBe(true);
    expect(isVerificator('financials')).toBe(true);
    expect(isVerificator('announcements')).toBe(true);
    expect(isVerificator('unverifiable')).toBe(true);
    expect(isVerificator('search_web')).toBe(false);
    expect(isVerificator(undefined)).toBe(false);
  });
});
