/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ComplianceNotice } from './ComplianceNotice';

/**
 * Seam 1 渲染层：合规拦截提示（ADR-0002 决策 1、6）
 *
 * 抓到：fail_closed 与真拦截文案混淆（**曾谎称用户索取买卖建议**，
 *       这是 T3 code-review 抓出的真实缺陷）、粗心拒答而非柔性引导。
 * 漏掉：服务端文案本身的质量（本组件只负责呈现层级差异）。
 *
 * 关键红线：`fail_closed` 是"合规校验服务不可用"，**绝不能**让用户以为
 * 自己的提问违规。三者文案必须可区分。
 */

describe('ComplianceNotice', () => {
  it('关键词层拦截：柔性引导，不粗暴拒答', () => {
    render(<ComplianceNotice layer="keyword" text="我们转为基本面核验…" />);
    const t = document.body.textContent ?? '';
    expect(t).toContain('已转为基本面核验');
    expect(t).toContain('我们转为基本面核验');
  });

  it('意图层拦截同样归为"已转为基本面核验"', () => {
    render(<ComplianceNotice layer="intent" text="引导文案" />);
    expect(document.body.textContent).toContain('已转为基本面核验');
  });

  it('fail_closed 标题是"服务不可用"，不是"已转为基本面核验"', () => {
    render(<ComplianceNotice layer="fail_closed" text="服务暂时不可用" />);
    const t = document.body.textContent ?? '';
    expect(t).toContain('合规校验服务暂时不可用');
    expect(t).not.toContain('已转为基本面核验');
  });

  it('fail_closed 必须显式声明"不是因为您的问题违规"', () => {
    render(<ComplianceNotice layer="fail_closed" text="x" />);
    expect(document.body.textContent).toContain('不是因为您的问题违规');
  });

  it('真拦截路径不出现"不是因为您的问题违规"（不混淆两种情形）', () => {
    render(<ComplianceNotice layer="keyword" text="引导文案" />);
    expect(document.body.textContent).not.toContain('不是因为您的问题违规');
  });

  it('服务端下发的正文被原样渲染', () => {
    const body = '第一行\n第二行';
    render(<ComplianceNotice layer="intent" text={body} />);
    expect(document.body.textContent).toContain('第一行');
    expect(document.body.textContent).toContain('第二行');
  });

  it('未知 layer 不崩（降级为 keyword 样式）', () => {
    expect(() =>
      render(<ComplianceNotice layer={'weird' as never} text="x" />),
    ).not.toThrow();
  });
});
