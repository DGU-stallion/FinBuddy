/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ThinkingTimeline } from './ThinkingTimeline';

/**
 * Seam 7 渲染层：思考过程时间轴
 *
 * 抓到：默认展开（干扰正文阅读）、步骤文案被前端加工改写（应原样来自服务端）、
 *       无步骤时渲染空壳、无法看到耗时。
 * 漏掉：真实耗时准确性（由父组件计时，本组件只展示）。
 *
 * 关键红线（handoff 第 6 条）：步骤文案必须**原样来自服务端确定性产出**，
 * 前端不做任何措辞加工，也不展示模型原始 thinking。
 */

const STEPS = [
  { id: 'step-compliance', label: '合规校验', detail: '关键词层 + 意图层双保险' },
  { id: 'step-reframe', label: '命题重构', detail: '将用户输入重构为可证伪命题：X' },
  { id: 'step-synthesis', label: '三栏证据对齐', detail: '按三栏归类工具返回的事实' },
];

describe('ThinkingTimeline', () => {
  it('默认折叠（不干扰正文阅读）', () => {
    render(<ThinkingTimeline steps={STEPS} />);
    // 折叠时不渲染步骤明细
    expect(screen.queryByText('关键词层 + 意图层双保险')).toBeNull();
    expect(screen.getByText(/思考过程/)).toBeDefined();
  });

  it('点击展开后显示全部步骤（文案原样来自服务端）', () => {
    render(<ThinkingTimeline steps={STEPS} />);
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    for (const s of STEPS) {
      expect(screen.getByText(s.label)).toBeDefined();
      expect(screen.getByText(s.detail)).toBeDefined();
    }
  });

  it('展示步数与耗时（耗时由父组件传入，不伪造）', () => {
    render(<ThinkingTimeline steps={STEPS} elapsedMs={31200} />);
    expect(screen.getByText(/3 步/)).toBeDefined();
    expect(screen.getByText('31.2s')).toBeDefined();
  });

  it('流式中显示当前执行步骤', () => {
    render(<ThinkingTimeline steps={STEPS} activeIndex={1} />);
    expect(screen.getByText(/正在执行：命题重构/)).toBeDefined();
  });

  it('无步骤时渲染空（不出现空壳面板）', () => {
    const { container } = render(<ThinkingTimeline steps={[]} />);
    expect(container.textContent).toBe('');
  });

  it('确定性：同 props 渲染一致', () => {
    const a = render(<ThinkingTimeline steps={STEPS} elapsedMs={1000} />);
    const first = a.container.textContent;
    a.unmount();
    const b = render(<ThinkingTimeline steps={STEPS} elapsedMs={1000} />);
    expect(b.container.textContent).toBe(first);
  });
});
