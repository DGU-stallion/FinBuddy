/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CitationText } from './CitationText';

/**
 * Seam 8 渲染层：角标强制校验的 UI（ADR-0002 决策 2）
 *
 * 公共接口：<CitationText text allowedRefIds onOpenRef />
 *
 * 抓到：编造角标被渲染成可点击按钮、失效角标仍能触发抽屉、正文丢字。
 * 漏掉：服务端是否真的把 refId 集合给全（由 route 集成测试负责）。
 *
 * 关键红线（ADR-0002 决策 2，题目核心考点）：
 *  - 角标不在本轮返回集合内 → 渲染为灰色"引用失效"且**不可点击**。
 *  - 这条必须在前端强制，因为服务端是"正文先 merge、校验后跑"，
 *    编造角标一定会到达前端。
 */

describe('CitationText', () => {
  it('有效角标渲染为可点击按钮', () => {
    render(<CitationText text="营收 1245 亿[^ref_1]" allowedRefIds={['ref_1']} onOpenRef={() => {}} />);
    const btn = screen.getByRole('button', { name: /ref_1/ });
    expect(btn).toBeDefined();
  });

  it('编造的角标渲染为"引用失效"且不是按钮（不可点击）', () => {
    render(<CitationText text="官方已澄清[^ref_7]" allowedRefIds={['ref_1']} onOpenRef={() => {}} />);
    // 整段里没有任何按钮 —— 失效角标不可是可点击元素
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.getByLabelText(/引用失效 ref_7/)).toBeDefined();
  });

  it('点击失效角标不会触发存证抽屉（onOpenRef 不被调用）', () => {
    const onOpen = vi.fn();
    render(<CitationText text="官方已澄清[^ref_7]" allowedRefIds={['ref_1']} onOpenRef={onOpen} />);
    fireEvent.click(screen.getByLabelText(/引用失效 ref_7/));
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('点击有效角标把对应 refId 交给抽屉', () => {
    const onOpen = vi.fn();
    render(<CitationText text="营收[^ref_2]" allowedRefIds={['ref_2']} onOpenRef={onOpen} />);
    fireEvent.click(screen.getByRole('button', { name: /ref_2/ }));
    expect(onOpen).toHaveBeenCalledWith('ref_2');
  });

  it('混合有效与失效角标：只有有效的是按钮', () => {
    render(
      <CitationText text="营收[^ref_1] 传闻[^ref_9]" allowedRefIds={['ref_1']} onOpenRef={() => {}} />,
    );
    const btns = screen.queryAllByRole('button');
    expect(btns).toHaveLength(1);
    expect(btns[0].textContent).toContain('ref_1');
    expect(screen.getByLabelText(/引用失效 ref_9/)).toBeDefined();
  });

  it('工具全挂（无 refId）时任何角标都失效', () => {
    render(<CitationText text="数据显示增长[^ref_1]" allowedRefIds={[]} onOpenRef={() => {}} />);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.getByLabelText(/引用失效 ref_1/)).toBeDefined();
  });

  it('正文文本完整保留（不因切 token 丢字）', () => {
    const { container } = render(
      <CitationText text="营收 1245 亿[^ref_1]，净利率 35.27%[^ref_2]。" allowedRefIds={['ref_1', 'ref_2']} onOpenRef={() => {}} />,
    );
    const txt = container.textContent ?? '';
    expect(txt).toContain('营收 1245 亿');
    expect(txt).toContain('净利率 35.27%');
    expect(txt).toContain('。');
  });
});
