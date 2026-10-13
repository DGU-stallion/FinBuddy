import { describe, it, expect } from 'vitest';
import { shouldPersist, nextTitleFrom, sessionMessagesOf } from './session-switch';

/**
 * Seam 19: 会话切换规则（页面 ↔ session-store 之间的判断）
 *
 * 公共接口：
 *  - shouldPersist(status): 何时把 messages 落盘
 *  - nextTitleFrom(currentTitle, question): 首轮提问后的标题
 *  - sessionMessagesOf(session): 从会话里取可回填的消息
 *
 * 抓到：流式途中落盘导致存到半截正文、已改名的会话被首轮标题覆盖、
 *       空会话回填为 undefined 让页面崩。
 * 漏掉：落盘的字节量（由 session-store 的上限负责）。
 *
 * 关键红线：**流式未结束时不得落盘** —— 否则刷新后看到半句回答，
 * 用户会以为是模型坏了（而不是自己刷新太早）。
 */

describe('shouldPersist：何时落盘', () => {
  it('流式进行中不落盘（避免存半截正文）', () => {
    expect(shouldPersist('streaming')).toBe(false);
  });

  it('已提交但未开始输出时也不落盘', () => {
    expect(shouldPersist('submitted')).toBe(false);
  });

  it('空闲且已有消息时落盘', () => {
    expect(shouldPersist('ready')).toBe(true);
  });

  it('出错时落盘（保住已生成的部分，别让用户白等）', () => {
    expect(shouldPersist('error')).toBe(true);
  });
});

describe('nextTitleFrom：首轮提问派生标题', () => {
  it('会话还是默认标题时，用首轮提问替换', () => {
    expect(nextTitleFrom('新对话', '中际旭创怎么样')).toBe('中际旭创怎么样');
  });

  it('会话已被用户重命名 → 不覆盖（尊重用户意图）', () => {
    expect(nextTitleFrom('我的中际旭创研究', '宁德时代怎么样')).toBe('我的中际旭创研究');
  });

  it('空标题视为默认，用提问替换', () => {
    expect(nextTitleFrom('', '宁德时代怎么样')).toBe('宁德时代怎么样');
  });

  it('空提问不产生空标题', () => {
    expect(nextTitleFrom('新对话', '   ')).toBe('新对话');
  });
});

describe('sessionMessagesOf：回填消息', () => {
  it('有消息时原样返回', () => {
    const m = [{ id: 'a' }];
    expect(sessionMessagesOf({ messages: m } as never)).toEqual(m);
  });

  it('空会话返回空数组（不是 undefined，避免页面崩）', () => {
    expect(sessionMessagesOf({ messages: [] } as never)).toEqual([]);
  });

  it('字段缺失也返回空数组（旧数据容错）', () => {
    expect(sessionMessagesOf({} as never)).toEqual([]);
    expect(sessionMessagesOf(undefined)).toEqual([]);
  });
});
