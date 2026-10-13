import { describe, it, expect } from 'vitest';
import {
  detectTradeSeeking,
  scanForbiddenPhrases,
  complianceNotice,
  type ComplianceVerdict,
} from './compliance';

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

describe('complianceNotice', () => {
  it('关键词/意图层拦截：柔性引导至基本面核验，不粗暴拒答', () => {
    for (const layer of ['keyword', 'intent'] as const) {
      const msg = complianceNotice(layer);
      expect(msg).toContain('不提供任何投资建议');
      expect(msg).toContain('核验');
      // 不得输出买卖结论
      expect(msg).not.toMatch(/建议(买入|卖出)/);
    }
  });

  it('fail_closed（合规服务不可用）：不得谎称用户在索取买卖建议', () => {
    const msg = complianceNotice('fail_closed');
    // 关键：必须说明是"校验服务不可用"，而不是"你问了买卖建议"
    expect(msg).toContain('暂时不可用');
    // 不得断言用户意图（那会误导用户以为自己违规了）
    expect(msg).not.toContain('不提供任何投资建议、买卖指令或收益承诺');
  });

  it('fail_closed 文案与拦截文案不同（用户可区分）', () => {
    // keyword 与 intent 含义相同（都在索取买卖决策），共用文案是预期的；
    // 关键是 fail_closed 必须与它们不同。
    expect(complianceNotice('keyword')).toBe(complianceNotice('intent'));
    expect(complianceNotice('fail_closed')).not.toBe(complianceNotice('keyword'));
  });

  it('fail_closed 文案明确否认用户违规（不得让用户误以为自己问了违规问题）', () => {
    const msg = complianceNotice('fail_closed');
    expect(msg).toContain('不是因为您的问题违规');
  });
});

describe('意图层不得误伤中性提问（真机偶发，见下方说明）', () => {
  /**
   * 真缺陷记录：真机集成测试曾约 1/5 概率在「中际旭创怎么样」上失败，
   * 服务端日志显示：
   *   data: {"type":"data-compliance","data":{"layer":"intent"}}
   * 即**意图层把这个纯事实性问题判成了"索取买卖决策"**。
   *
   * 严重后果：用户问一个中性问题，却被回以"不提供投资建议"的合规话术，
   * 且**拿不到任何核验结果** —— 这是合规层把正常用户挡在门外。
   *
   * 下面是确定性复现（注入一个"总是判是"的判官），锁住"意图层误判会拦截"
   * 这一**机制**；真实模型的误判率需靠 prompt 收紧来解决，不在单测范围内。
   */
  it('意图层返回"是"时确实拦截（机制确认）', async () => {
    const v = await detectTradeSeeking('中际旭创怎么样', {
      llmJudge: async () => true, // 模拟模型误判
    });
    expect(v.blocked).toBe(true);
    expect(v.layer).toBe('intent');
  });

  it('意图层返回"否"时不拦截（中性问题应正常分析）', async () => {
    const v = await detectTradeSeeking('中际旭创怎么样', {
      llmJudge: async () => false,
    });
    expect(v.blocked).toBe(false);
  });

  it('关键词层优先于意图层（命中关键词不再调模型）', async () => {
    let called = false;
    const v = await detectTradeSeeking('请告诉我明天买入还是卖出', {
      llmJudge: async () => {
        called = true;
        return false;
      },
    });
    expect(v.blocked).toBe(true);
    expect(v.layer).toBe('keyword');
    expect(called, '关键词已命中却仍调用了意图判官 —— 白白消耗一次模型调用').toBe(false);
  });
});
