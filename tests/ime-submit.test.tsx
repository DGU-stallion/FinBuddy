/**
 * @vitest-environment jsdom
 *
 * 中文输入法（IME）不得触发表单提交
 *
 * 抓到（用户实测第二次报告"还是显示了两次"，我此前修错了方向）：
 *   中文/日文输入法打字时，**Enter 的首要含义是"确认候选词"**，不是"提交"。
 *   但 `<form onSubmit>` 无法区分两者 —— 于是一次选词就发出一个请求，
 *   内容是**未完成的拼音**（如 "shichang"）；用户继续打完完整问题再按 Enter，
 *   又发一个请求 → 用户看到两轮对话，第一轮是垃圾。
 *
 *   为什么此前测不出来：Playwright 的 fill() 直接赋值，绕过输入法；
 *   我当时的"连点 5 次"用例全在测另一条路径。直到用 CDP 的
 *   Input.imeSetComposition 模拟真实组词才复现。
 *
 * 漏掉：其他输入法（日文/韩文）的具体按键序列差异（同一 isComposing 机制覆盖）。
 *
 * ⚠️ 测试缝隙的诚实说明：
 *   jsdom **不会**由 Enter 触发隐式表单提交，所以这里无法用 keydown 驱动出
 *   "误发"。因此本文件分两层验证：
 *     · 单测层：断言 keydown 处理器在组词时 **preventDefault**（即真正阻止了
 *       浏览器默认提交行为），并断言非组词时不阻止；以及兜底丢弃逻辑。
 *     · 端到端层：`scripts/ime-submit-check.mjs` 用真实 Chromium + CDP 的
 *       Input.imeSetComposition 走真实输入法流程，断言"发出的提问文本"。
 *       该脚本已实测可复现（摘掉修复后变红：发出拼音 "shichang"）。
 *   单测测"是否 preventDefault"就够，因为隐式提交正是由未阻止的默认行为产生。
 * 关键红线：**组词中的 Enter 绝不能提交** —— 否则用户会看到自己没打过的内容
 *          被当成提问发出（既是体验缺陷，也让存证挂在一句拼音上）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const sendMessage = vi.fn();
const state = { messages: [] as unknown[], status: 'ready', error: null };
vi.mock('@ai-sdk/react', () => ({
  useChat: () => ({
    messages: state.messages,
    status: state.status,
    error: state.error,
    sendMessage,
    setMessages: vi.fn(),
  }),
}));

import WorkbenchPage from '@/app/page';

const input = () => screen.getByPlaceholderText(/输入投资疑问/);
const form = () => input().closest('form')!;

describe('IME 组词期间的 Enter 不得提交', () => {
  beforeEach(() => {
    sendMessage.mockClear();
    state.messages = [];
    state.status = 'ready';
  });

  it('组词中按 Enter：被 preventDefault（这才是阻止隐式提交的关键）', () => {
    render(<WorkbenchPage />);
    const el = input();
    fireEvent.change(el, { target: { value: 'shichang' } });
    fireEvent.compositionStart(el);

    // fireEvent 返回 false 表示默认行为已被阻止 → 浏览器不会提交表单
    const notPrevented = fireEvent.keyDown(el, {
      key: 'Enter',
      code: 'Enter',
      keyCode: 229,
      isComposing: true,
    });

    expect(
      notPrevented,
      '组词中的 Enter 未被 preventDefault —— 浏览器会把未打完的拼音当成提问提交',
    ).toBe(false);
  });

  it('组词标志存在时，即使表单仍收到 submit 也会被丢弃', () => {
    render(<WorkbenchPage />);
    const el = input();
    fireEvent.change(el, { target: { value: 'shichang' } });
    fireEvent.compositionStart(el);
    fireEvent.keyDown(el, { key: 'Enter', isComposing: true });
    // 模拟"某个浏览器在组词状态下仍然提交了表单"
    fireEvent.submit(form());
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('非组词的 Enter 不阻止默认行为（真实提交正常放行）', () => {
    render(<WorkbenchPage />);
    const el = input();
    fireEvent.change(el, { target: { value: '市场流传' } });
    const notPrevented = fireEvent.keyDown(el, { key: 'Enter', isComposing: false });
    expect(notPrevented, '非组词的 Enter 被误拦 —— 用户将无法提交').toBe(true);
    fireEvent.submit(form());
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('未使用输入法时 Enter 正常工作（不得因修 IME 而误伤）', () => {
    render(<WorkbenchPage />);
    fireEvent.change(input(), { target: { value: '中际旭创怎么样' } });
    fireEvent.submit(form());
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('只给 keyCode 229（不设 isComposing）也要 preventDefault', () => {
    render(<WorkbenchPage />);
    const el = input();
    fireEvent.change(el, { target: { value: 'shichang' } });
    // 有些浏览器不设 isComposing，只用 keyCode 229 表示 IME 处理中
    const notPrevented = fireEvent.keyDown(el, { key: 'Enter', keyCode: 229 });
    expect(notPrevented).toBe(false);
  });

  it('组词取消（compositionend 后未提交）→ 不影响后续正常提交', () => {
    render(<WorkbenchPage />);
    const el = input();
    fireEvent.compositionStart(el);
    fireEvent.compositionEnd(el);
    fireEvent.change(el, { target: { value: '宁德时代怎么样' } });
    fireEvent.submit(form());
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});

describe('不得因 IME 守卫而永久锁死提交', () => {
  beforeEach(() => {
    sendMessage.mockClear();
    state.messages = [];
    state.status = 'ready';
  });

  it('只见到 keyCode 229 但**没有** compositionend 时，后续仍能正常提交（状态自愈）', () => {
    render(<WorkbenchPage />);
    const el = input();
    // 某些浏览器/输入法组合只给 229，不给 compositionstart/end
    fireEvent.keyDown(el, { key: 'Enter', keyCode: 229 });
    // 用户随后正常输入并按 Enter 提交 → 非组词分支应清除标志
    fireEvent.change(el, { target: { value: '中际旭创怎么样' } });
    fireEvent.keyDown(el, { key: 'Enter', isComposing: false });
    fireEvent.submit(form());
    expect(
      sendMessage,
      '只见过 keyCode 229 就永久锁死提交 —— 用户再也发不出消息（同类"一次失败锁死界面"缺陷）',
    ).toHaveBeenCalledTimes(1);
  });

  it('组词开始后用户放弃并正常提交 → 仍能提交', () => {
    render(<WorkbenchPage />);
    const el = input();
    fireEvent.compositionStart(el);
    fireEvent.change(el, { target: { value: '中际旭创怎么样' } });
    fireEvent.submit(form());
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});
