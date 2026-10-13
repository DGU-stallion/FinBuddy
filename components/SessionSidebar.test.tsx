/**
 * @vitest-environment jsdom
 *
 * 会话侧栏（新建 / 切换 / 删除）
 *
 * 抓到：列表渲染、当前项高亮、新建/切换回调、删除需二次确认、
 *       时间与条数展示、空列表状态。
 * 漏掉：滑入动画（jsdom 不体现）、窄屏遮罩的实际点击区域。
 *
 * 关键红线：**删除必须二次确认** —— 误删整轮核验结果的代价远高于多一次点击。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SessionSidebar } from './SessionSidebar';
import type { Session } from '@/lib/session-store';

const mk = (id: string, title: string, msgs = 0): Session => ({
  id,
  title,
  messages: Array.from({ length: msgs }, (_, i) => ({ id: `m${i}` })),
  createdAt: Date.now(),
  updatedAt: Date.now(),
});

const noop = () => {};

describe('SessionSidebar', () => {
  // 用 vi.fn 自查而非 spy：vitest 的 spy 类型在 tsc 下推不干净，
  // 直接替换 window.confirm 更简单，也更容易断言"是否被调用过"
  let confirmSpy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    confirmSpy = vi.fn(() => true);
    window.confirm = confirmSpy as unknown as typeof window.confirm;
  });
  afterEach(() => {
    window.confirm = () => true;
  });

  it('渲染所有会话标题', () => {
    render(
      <SessionSidebar
        sessions={[mk('a', '中际旭创核验'), mk('b', '宁德时代核验')]}
        currentId="a"
        open
        disabled={false}
        onNew={noop}
        onSwitch={noop}
        onRemove={noop}
        onClose={noop}
      />,
    );
    expect(screen.getByText('中际旭创核验')).toBeTruthy();
    expect(screen.getByText('宁德时代核验')).toBeTruthy();
  });

  it('当前会话有 aria-current 标记（可访问性 + 高亮依据）', () => {
    render(
      <SessionSidebar
        sessions={[mk('a', 'A'), mk('b', 'B')]}
        currentId="b"
        open
        disabled={false}
        onNew={noop}
        onSwitch={noop}
        onRemove={noop}
        onClose={noop}
      />,
    );
    const btns = screen.getAllByRole('button').filter((b) => b.getAttribute('aria-current'));
    expect(btns).toHaveLength(1);
    expect(btns[0].textContent).toContain('B');
  });

  it('点击会话触发 onSwitch（带正确 id）', () => {
    const onSwitch = vi.fn();
    render(
      <SessionSidebar
        sessions={[mk('a', 'A'), mk('b', 'B')]}
        currentId="a"
        open
        disabled={false}
        onNew={noop}
        onSwitch={onSwitch}
        onRemove={noop}
        onClose={noop}
      />,
    );
    fireEvent.click(screen.getByText('B'));
    expect(onSwitch).toHaveBeenCalledWith('b');
  });

  it('点击"新建"触发 onNew', () => {
    const onNew = vi.fn();
    render(
      <SessionSidebar
        sessions={[]}
        currentId={null}
        open
        disabled={false}
        onNew={onNew}
        onSwitch={noop}
        onRemove={noop}
        onClose={noop}
      />,
    );
    fireEvent.click(screen.getByText('＋ 新建'));
    expect(onNew).toHaveBeenCalledTimes(1);
  });

  it('删除：确认后才回调 onRemove', () => {
    const onRemove = vi.fn();
    confirmSpy.mockReturnValue(true);
    render(
      <SessionSidebar
        sessions={[mk('a', '要删的')]}
        currentId="a"
        open
        disabled={false}
        onNew={noop}
        onSwitch={noop}
        onRemove={onRemove}
        onClose={noop}
      />,
    );
    fireEvent.click(screen.getByTitle('删除对话'));
    expect(confirmSpy).toHaveBeenCalled();
    expect(onRemove).toHaveBeenCalledWith('a');
  });

  it('删除：取消则**不**回调（红线：不可逆操作需确认）', () => {
    const onRemove = vi.fn();
    confirmSpy.mockReturnValue(false);
    render(
      <SessionSidebar
        sessions={[mk('a', '要删的')]}
        currentId="a"
        open
        disabled={false}
        onNew={noop}
        onSwitch={noop}
        onRemove={onRemove}
        onClose={noop}
      />,
    );
    fireEvent.click(screen.getByTitle('删除对话'));
    expect(onRemove).not.toHaveBeenCalled();
  });

  it('删除按钮的点击不冒泡到会话切换', () => {
    const onSwitch = vi.fn();
    render(
      <SessionSidebar
        sessions={[mk('a', 'A')]}
        currentId="a"
        open
        disabled={false}
        onNew={noop}
        onSwitch={onSwitch}
        onRemove={noop}
        onClose={noop}
      />,
    );
    fireEvent.click(screen.getByTitle('删除对话'));
    expect(onSwitch).not.toHaveBeenCalled();
  });

  it('空列表给出可读提示（不显示空白）', () => {
    render(
      <SessionSidebar
        sessions={[]}
        currentId={null}
        open
        disabled={false}
        onNew={noop}
        onSwitch={noop}
        onRemove={noop}
        onClose={noop}
      />,
    );
    expect(screen.getByText('还没有对话')).toBeTruthy();
  });

  it('busy 时禁用新建议/切换（避免流式途中切走丢结果）', () => {
    const onNew = vi.fn();
    const onSwitch = vi.fn();
    render(
      <SessionSidebar
        sessions={[mk('a', 'A')]}
        currentId={null}
        open
        disabled
        onNew={onNew}
        onSwitch={onSwitch}
        onRemove={noop}
        onClose={noop}
      />,
    );
    fireEvent.click(screen.getByText('＋ 新建'));
    fireEvent.click(screen.getByText('A'));
    expect(onNew).not.toHaveBeenCalled();
    expect(onSwitch).not.toHaveBeenCalled();
  });

  it('展示消息条数（让用户知道哪些会话有内容）', () => {
    render(
      <SessionSidebar
        sessions={[mk('a', '有内容的', 4)]}
        currentId="a"
        open
        disabled={false}
        onNew={noop}
        onSwitch={noop}
        onRemove={noop}
        onClose={noop}
      />,
    );
    expect(screen.getByText(/4 条/)).toBeTruthy();
  });

  it('声明数据只存在本机（隐私说明可见）', () => {
    render(
      <SessionSidebar
        sessions={[]}
        currentId={null}
        open
        disabled={false}
        onNew={noop}
        onSwitch={noop}
        onRemove={noop}
        onClose={noop}
      />,
    );
    expect(screen.getByText(/仅保存在本机浏览器/)).toBeTruthy();
  });
});
