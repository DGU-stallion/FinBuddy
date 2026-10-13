/**
 * @vitest-environment jsdom
 *
 * 提交闸门（防重复提交）
 *
 * 抓到（用户实测发现：点一次预置案例，服务端日志出现**两次完整一轮**）：
 *   50459ms + 58260ms 两轮背靠背跑完。
 * 根因：闸门 `busy` 派生自 React state（`useChat` 的 `status`），
 *   而 state 更新是**异步**的 —— 第二次点击发生在重渲染之前，
 *   此时 `busy` 仍是 false，闸门形同虚设。
 *
 * 漏掉：网络层重试（SDK 内部行为，不在此处）。
 * 关键红线：**一次用户意图 = 一次请求**（否则用户为重复的 LLM 调用付费，
 *          且界面上会出现两条回答）。
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

const presetButton = () =>
  screen.getAllByRole('button').find((b) => b.textContent?.includes('大客户砍单'))!;

describe('提交闸门', () => {
  beforeEach(() => {
    sendMessage.mockClear();
    state.messages = [];
    state.status = 'ready';
  });

  it('单击一次 → 只发 1 次', () => {
    render(<WorkbenchPage />);
    fireEvent.click(presetButton());
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('同一 tick 内连点两次 → 仍只发 1 次（异步 state 不得放行第二次）', () => {
    render(<WorkbenchPage />);
    const btn = presetButton();
    // 关键：不 await、不重渲染，模拟用户快速双击
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('连点五次 → 仍只发 1 次', () => {
    render(<WorkbenchPage />);
    const btn = presetButton();
    for (let i = 0; i < 5; i++) fireEvent.click(btn);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('表单提交与按钮点击同时发生 → 只发 1 次', () => {
    render(<WorkbenchPage />);
    const input = screen.getByPlaceholderText(/输入投资疑问/);
    fireEvent.change(input, { target: { value: '中际旭创怎么样' } });
    const form = input.closest('form')!;
    const submitBtn = form.querySelector('button[type="submit"]')!;
    fireEvent.click(submitBtn);
    fireEvent.submit(form);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('一轮结束后闸门释放 → 可以再发起下一轮（不能一次锁死）', () => {
    const { rerender } = render(<WorkbenchPage />);
    fireEvent.click(presetButton());
    expect(sendMessage).toHaveBeenCalledTimes(1);

    // 走完真实的轮次生命周期：ready → submitted → streaming → ready
    state.status = 'submitted';
    rerender(<WorkbenchPage />);
    state.messages = [{ id: 'a1', role: 'assistant', parts: [] }];
    state.status = 'streaming';
    rerender(<WorkbenchPage />);
    // 轮次结束
    state.status = 'ready';
    rerender(<WorkbenchPage />);

    // 预置卡片在有消息后不再渲染（views.length === 0 才显示），
    // 改用始终存在的输入框 + 提交按钮
    sendMessage.mockClear();
    const input = screen.getByPlaceholderText(/输入投资疑问/);
    fireEvent.change(input, { target: { value: '宁德时代怎么样' } });
    fireEvent.submit(input.closest('form')!);
    expect(sendMessage, '轮次结束后应能再次提交').toHaveBeenCalledTimes(1);
  });

  it('出错后闸门必须释放 —— 否则一次失败会让界面永久锁死', () => {
    const { rerender } = render(<WorkbenchPage />);
    fireEvent.click(presetButton());
    expect(sendMessage).toHaveBeenCalledTimes(1);

    // 轮次失败
    state.status = 'ready';
    (state as { error: Error | null }).error = new Error('模型调用失败');
    rerender(<WorkbenchPage />);

    // 用户重试：必须能再次提交（若闸门没释放，这里会是 0 次）
    sendMessage.mockClear();
    (state as { error: Error | null }).error = null;
    state.messages = [];
    rerender(<WorkbenchPage />);
    fireEvent.click(presetButton());
    expect(sendMessage, '出错后必须能重试，不能永久锁死').toHaveBeenCalledTimes(1);
  });

  it('流式进行中即使闸门被绕过，busy 仍挡住提交', () => {
    state.status = 'streaming';
    state.messages = [{ id: 'a1', role: 'assistant', parts: [] }];
    render(<WorkbenchPage />);
    const input = screen.getByPlaceholderText(/输入投资疑问/);
    fireEvent.change(input, { target: { value: '宁德时代怎么样' } });
    fireEvent.submit(input.closest('form')!);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
