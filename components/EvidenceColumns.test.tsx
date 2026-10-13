/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EvidenceColumns } from './EvidenceColumns';
import type { RefEntry } from '@/lib/evidence';

/**
 * Seam 8 渲染层：三栏证据卡片
 *
 * 抓到：某栏缺失时静默隐藏（掩盖证据偏斜）、**Markdown 标记原样外露**
 *       （真机输出含 `**加粗**`，曾显示为字面星号）、角标未走强制校验。
 * 漏掉：真实浏览器排版与换行细节。
 *
 * 关键红线：三栏**始终渲染三列** —— 三栏的意义就是暴露不均衡，
 * 静默隐藏缺失栏反而掩盖问题。
 */

const refs: RefEntry[] = [
  { refId: 'ref_1', kind: 'financials', payload: { refId: 'ref_1' } },
];

const BODY = [
  '【支持证据】营收 1245 亿[^ref_1]。',
  '【反对证据】毛利率环比下滑。',
  '【无法验证项】大客户集中度尚未披露。',
].join('\n');

describe('EvidenceColumns', () => {
  it('始终渲染三列（即使某栏缺失）', () => {
    render(
      <EvidenceColumns text="【支持证据】只有这一栏。" refs={refs} onOpenRef={() => {}} />,
    );
    // 三个栏标题都必须在场
    expect(screen.getByText('支持证据')).toBeDefined();
    expect(screen.getByText('反对证据')).toBeDefined();
    expect(screen.getByText('无法验证项')).toBeDefined();
  });

  it('缺失栏显式提示，不静默隐藏', () => {
    render(<EvidenceColumns text="【支持证据】x" refs={refs} onOpenRef={() => {}} />);
    expect(document.body.textContent).toMatch(/本栏缺失|本栏为空/);
  });

  it('**加粗** 渲染为粗体元素，星号不外露（真机回归）', () => {
    const body = '【支持证据】公司**并无经历任何客户订单**变化。\n【反对证据】x\n【无法验证项】y';
    render(<EvidenceColumns text={body} refs={refs} onOpenRef={() => {}} />);

    const txt = document.body.textContent ?? '';
    // 关键：页面上不能出现字面星号
    expect(txt).not.toContain('**');
    // 内容不能丢
    expect(txt).toContain('并无经历任何客户订单');

    // 且确实是 <strong> 粗体元素
    const strong = document.querySelector('strong');
    expect(strong?.textContent).toBe('并无经历任何客户订单');
  });

  it('行首 "- " 渲染为列表项，标记不外露', () => {
    const body = '【支持证据】\n- 第一项\n- 第二项\n【反对证据】x\n【无法验证项】y';
    render(<EvidenceColumns text={body} refs={refs} onOpenRef={() => {}} />);

    expect(document.querySelectorAll('li').length).toBeGreaterThanOrEqual(2);
    expect(document.body.textContent).not.toContain('- 第一项');
    expect(document.body.textContent).toContain('第一项');
  });

  it('有效角标渲染为可点击按钮（走强制校验）', () => {
    render(<EvidenceColumns text={BODY} refs={refs} onOpenRef={() => {}} />);
    expect(screen.getByRole('button', { name: /ref_1/ })).toBeDefined();
  });

  it('编造角标渲染为"引用失效"且不是按钮', () => {
    const body = '【支持证据】传闻已澄清[^ref_9]。\n【反对证据】x\n【无法验证项】y';
    render(<EvidenceColumns text={body} refs={refs} onOpenRef={() => {}} />);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.getByLabelText(/引用失效 ref_9/)).toBeDefined();
  });

  it('抽屉打开时三栏压缩（传 compressed）', () => {
    const { container } = render(
      <EvidenceColumns text={BODY} refs={refs} onOpenRef={() => {}} compressed />,
    );
    expect(container.querySelector('.grid')?.className).toContain('text-[11px]');
  });
});
