/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { IntentTags, tagKind } from './IntentTags';

/**
 * Seam 11: 意图标签微调（spec 交互决策）
 *
 * 抓到：改文本时每敲一字就重跑（打爆付费 API）、删除不重跑（用户收窄意图无效）、
 *       空标签/未变更标签被当作有效编辑。
 * 漏掉：重跑后的模型输出质量。
 *
 * 关键红线（spec 交互决策）：删除 → 自动重跑；**修改文本 → 必须点确认才重跑**。
 */

const tags = ['标的: 中际旭创', '事件: 大客户砍单传闻', '核验维度: 财务支撑'];

describe('tagKind', () => {
  it('拆出标签类别与值（半角/全角冒号均可）', () => {
    expect(tagKind('标的: 中际旭创')).toEqual({ kind: '标的', value: '中际旭创' });
    expect(tagKind('事件：砍单')).toEqual({ kind: '事件', value: '砍单' });
  });

  it('无冒号的裸标签归为「标签」类，不丢内容', () => {
    expect(tagKind('随便写的')).toEqual({ kind: '标签', value: '随便写的' });
  });
});

describe('IntentTags', () => {
  it('渲染每个标签的类别与值', () => {
    render(<IntentTags tags={tags} onRerun={() => {}} />);
    expect(screen.getByText('中际旭创')).toBeDefined();
    expect(screen.getByText('大客户砍单传闻')).toBeDefined();
  });

  it('删除标签 → 立即触发重跑，并给出替换后的标签集合', () => {
    const onRerun = vi.fn();
    render(<IntentTags tags={tags} onRerun={onRerun} />);
    fireEvent.click(screen.getByLabelText('删除标签 事件: 大客户砍单传闻'));
    expect(onRerun).toHaveBeenCalledTimes(1);
    const intent = onRerun.mock.calls[0][0];
    expect(intent.reason).toBe('delete');
    expect(intent.nextTags).toEqual(['标的: 中际旭创', '核验维度: 财务支撑']);
  });

  it('修改标签文本时，仅输入不重跑（避免每敲一字调一次模型）', () => {
    const onRerun = vi.fn();
    render(<IntentTags tags={tags} onRerun={onRerun} />);
    fireEvent.click(screen.getByText('中际旭创'));

    const input = screen.getByLabelText('编辑标签 标的') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '宁德' } });
    fireEvent.change(input, { target: { value: '宁德时' } });
    fireEvent.change(input, { target: { value: '宁德时代' } });

    // 敲了 3 次，一次重跑都不该发生
    expect(onRerun).not.toHaveBeenCalled();
  });

  it('点「确认并重跑」才触发，且携带改后的标签集合', () => {
    const onRerun = vi.fn();
    render(<IntentTags tags={tags} onRerun={onRerun} />);
    fireEvent.click(screen.getByText('中际旭创'));

    const input = screen.getByLabelText('编辑标签 标的');
    fireEvent.change(input, { target: { value: '标的: 宁德时代' } });
    fireEvent.click(screen.getByText('确认并重跑'));

    expect(onRerun).toHaveBeenCalledTimes(1);
    expect(onRerun.mock.calls[0][0]).toMatchObject({
      reason: 'edit-confirmed',
      nextTags: ['标的: 宁德时代', '事件: 大客户砍单传闻', '核验维度: 财务支撑'],
    });
  });

  it('未做任何修改就确认 → 不重跑（空动作不烧 token）', () => {
    const onRerun = vi.fn();
    render(<IntentTags tags={tags} onRerun={onRerun} />);
    fireEvent.click(screen.getByText('中际旭创'));
    fireEvent.click(screen.getByText('确认并重跑'));
    expect(onRerun).not.toHaveBeenCalled();
  });

  it('改成空字符串就确认 → 不重跑（不产生空标签）', () => {
    const onRerun = vi.fn();
    render(<IntentTags tags={tags} onRerun={onRerun} />);
    fireEvent.click(screen.getByText('中际旭创'));
    fireEvent.change(screen.getByLabelText('编辑标签 标的'), { target: { value: '   ' } });
    fireEvent.click(screen.getByText('确认并重跑'));
    expect(onRerun).not.toHaveBeenCalled();
  });

  it('取消编辑不重跑且恢复原值', () => {
    const onRerun = vi.fn();
    render(<IntentTags tags={tags} onRerun={onRerun} />);
    fireEvent.click(screen.getByText('中际旭创'));
    fireEvent.change(screen.getByLabelText('编辑标签 标的'), { target: { value: '改了' } });
    fireEvent.click(screen.getByText('取消'));
    expect(onRerun).not.toHaveBeenCalled();
    expect(screen.getByText('中际旭创')).toBeDefined();
  });

  it('无标签时不渲染（不出现空壳）', () => {
    const { container } = render(<IntentTags tags={[]} onRerun={() => {}} />);
    expect(container.textContent).toBe('');
  });

  it('busy 时禁用交互（不允许并发重跑）', () => {
    render(<IntentTags tags={tags} disabled onRerun={() => {}} />);
    expect((screen.getByLabelText('删除标签 事件: 大客户砍单传闻') as HTMLButtonElement).disabled).toBe(true);
  });
});
