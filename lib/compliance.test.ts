import { describe, it, expect } from 'vitest';
import { detectTradeSeeking, scanForbiddenPhrases, type ComplianceVerdict } from './compliance';

/**
 * Seam 2（可测部分）: 合规拦截的确定性层
 *
 * 公共接口：
 *  - scanForbiddenPhrases(text): 关键词层，确定性、无 LLM
 *  - detectTradeSeeking(text, {llmJudge}): 关键词层 + 意图层（注入 llmJudge）
 *
 * 抓到：关键词清单命中、否定语境过滤、意图编排逻辑。
 * 漏掉：llmJudge 内部模型的真实判断质量（模型行为，不可测；用注入替身验证编排）。
 *
 * 关键红线（ADR-0002）：意图级 + 关键词双保险；两者任一命中即拦截。
 * 关键产品约束：不得误伤正常研究问题（"北向资金在买入吗"是研究，不是索取买卖决策）。
 */

describe('scanForbiddenPhrases', () => {
  it('命中直接索取买卖点的指令动词', () => {
    const hits = scanForbiddenPhrases('请直接告诉我明天是买入还是卖出');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits).toContain('买入');
  });

  it('命中收益承诺类词汇', () => {
    expect(scanForbiddenPhrases('全仓梭哈能翻倍吗')).toContain('翻倍');
    expect(scanForbiddenPhrases('这个保本吗')).toContain('保本');
    expect(scanForbiddenPhrases('稳赚不赔的票')).toContain('稳赚不赔');
  });

  it('命中加杠杆与满仓类词汇', () => {
    expect(scanForbiddenPhrases('我要加五倍杠杆')).toContain('杠杆');
    expect(scanForbiddenPhrases('满仓买入')).toContain('满仓');
  });

  it('中性研究问题不误伤', () => {
    expect(scanForbiddenPhrases('中际旭创的毛利率能否抵御冲击')).toEqual([]);
    expect(scanForbiddenPhrases('帮我核验一下海外客户订单的情况')).toEqual([]);
  });

  describe('研究性语境不误伤（实测发现的假阳性）', () => {
    it('资金流向研究问题中的"买入/卖出"是名词描述，不是指令', () => {
      expect(scanForbiddenPhrases('北向资金最近在买入中际旭创吗？')).toEqual([]);
      expect(scanForbiddenPhrases('帮我看看主力资金是净买入还是净卖出')).toEqual([]);
      expect(scanForbiddenPhrases('大股东有没有减持卖出计划？')).toEqual([]);
    });

    it('询问机构评级中的"买入"是评级术语', () => {
      expect(scanForbiddenPhrases('机构最新评级是买入吗？')).toEqual([]);
      expect(scanForbiddenPhrases('券商给的是买入评级还是增持评级？')).toEqual([]);
    });

    it('但索取自身操作决策仍然拦截，即使含研究性词汇', () => {
      expect(scanForbiddenPhrases('北向资金在买入，我该跟着买入吗？')).not.toEqual([]);
    });
  });
});

describe('detectTradeSeeking', () => {
  const never = async () => false;
  const always = async () => true;

  it('关键词命中时直接拦截，无需调用意图判断', async () => {
    let called = false;
    const llmJudge = async () => {
      called = true;
      return false;
    };
    const v: ComplianceVerdict = await detectTradeSeeking('明天买还是卖', { llmJudge });
    expect(v.blocked).toBe(true);
    expect(v.layer).toBe('keyword');
    expect(called).toBe(false);
  });

  it('关键词未命中但意图判断命中（口语化索取，如"能上车吗"）时拦截', async () => {
    const v = await detectTradeSeeking('这股我还能上车吗', { llmJudge: always });
    expect(v.blocked).toBe(true);
    expect(v.layer).toBe('intent');
  });

  it('两层都未命中时放行', async () => {
    const v = await detectTradeSeeking('中际旭创的营收增速如何', { llmJudge: never });
    expect(v.blocked).toBe(false);
    expect(v.layer).toBeNull();
  });

  it('意图判断抛错时保守拦截（fail-closed），不因模型故障放行违规', async () => {
    const llmJudge = async () => {
      throw new Error('model down');
    };
    const v = await detectTradeSeeking('这个能拿吗', { llmJudge });
    expect(v.blocked).toBe(true);
    expect(v.layer).toBe('fail_closed');
  });

  it('研究性问题交由意图层判断，关键词层不误杀', async () => {
    let called = false;
    const llmJudge = async () => {
      called = true;
      return false;
    };
    const v = await detectTradeSeeking('北向资金最近在买入中际旭创吗？', { llmJudge });
    expect(called).toBe(true);
    expect(v.blocked).toBe(false);
  });
});
