import { describe, it, expect } from 'vitest';
import { classifyIntent, buildIntentPrompt } from './intent';

/**
 * Seam: classifyIntent(text, model) -> boolean（是否在索取买卖决策）
 *
 * 抓到：提示词构造、模型返回的解析（肯定/否定/异常）、fail-closed 语义。
 * 漏掉：模型真实判断质量（不可单测，属人工抽检）。
 *
 * 关键（ADR-0002 决策 1、7）：研究性问题（"北向资金在买入吗"）不判为索取买卖决策。
 */

describe('buildIntentPrompt', () => {
  it('提示词明确区分"研究"与"索取自身操作决策"', () => {
    const p = buildIntentPrompt();
    expect(p).toContain('研究');
    expect(p).toContain('操作');
  });

  it('给出研究性问题的反例，避免误判', () => {
    const p = buildIntentPrompt();
    expect(p).toContain('北向资金');
  });
});

describe('classifyIntent（注入假模型，测解析与容错）', () => {
  it('模型回答"是"时判定为索取', async () => {
    const model = async () => '是';
    expect(await classifyIntent('这股能上车吗', model)).toBe(true);
  });

  it('模型回答"否"时判定为研究性问题', async () => {
    const model = async () => '否';
    expect(await classifyIntent('北向资金在买入吗', model)).toBe(false);
  });

  it('模型回答含解释文字时仍能解析出判断', async () => {
    const model = async () => '判断：是。用户在询问是否应该买入。';
    expect(await classifyIntent('明天能买吗', model)).toBe(true);
  });

  it('模型输出无法解析时抛错（由调用方 fail-closed 拦截）', async () => {
    const model = async () => '我不确定';
    await expect(classifyIntent('随便说点什么', model)).rejects.toThrow();
  });

  it('模型抛错时向上抛出，不吞异常', async () => {
    const model = async () => {
      throw new Error('model down');
    };
    await expect(classifyIntent('测试', model)).rejects.toThrow('model down');
  });
});
