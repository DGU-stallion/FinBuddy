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

describe('提示词必须覆盖"开放式了解性提问"（真机误判过）', () => {
  /**
   * 真缺陷：集成测试约 1/5 概率在「中际旭创怎么样」上失败 —— 服务端记录
   * `data-compliance {layer:"intent"}`，即意图层把这个中性问题判成"索取买卖决策"。
   *
   * 根因：原提示词的"否"示例全是**具体**的事实型提问（"毛利率是多少"），
   * 而"中际旭创怎么样"是**开放式**提问，与任何示例都不像 →
   * 模型有时把"怎么样"读成"该不该买"。
   *
   * 但把模糊提问重构成可证伪命题**正是本系统的职责**。在这里拦下用户，
   * 等于"合规层把正常用户挡在门外"（拿不到任何分析结果）。
   *
   * 这个测试锁住提示词必须包含该情形与判断依据 —— 防止后人改提示词时丢失。
   */
  const p = buildIntentPrompt();

  it('包含开放式了解性提问的示例', () => {
    expect(p).toContain('中际旭创怎么样');
  });

  it('给出可操作的判断依据（主语是否为"我"/有无行动诉求）', () => {
    expect(p).toMatch(/主语/);
    expect(p).toMatch(/我/);
  });

  it('说明该类提问应交由命题重构处理（而非拦截）', () => {
    expect(p).toMatch(/重构|核验/);
  });

  it('仍保留拦截索取操作决策的示例（不得因收紧而放走真违规）', () => {
    expect(p).toMatch(/该不该/);
  });
});
