/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SensitivityCard } from './SensitivityCard';

/**
 * Seam 9 渲染层：滑块实时联动且**零网络请求**（票面硬性验收）
 *
 * 抓到：拖动滑块触发 LLM 请求、结果不随滑块更新、参数缺失时显示 0（被读成"无影响"）。
 * 漏掉：真实帧率（jsdom 无渲染管线，只验证"每次 change 都重算且不发请求"）。
 *
 * 关键红线（ADR-0001 决策 1）：测算零 LLM 参与。这必须靠"拖动期间没有任何
 * fetch/XHR"来证明，而不是靠"代码里没写 fetch"这种自述。
 */

const params = {
  refId: 'ref_3',
  baseRevenue: 1112821442000,
  netMargin: 16.9837,
  taxRate: 15,
  revenueBasis: 'TTM',
  report: '2026-2',
  asOf: Date.UTC(2026, 9, 12),
};

describe('SensitivityCard', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn(() => Promise.resolve(new Response('{}')));
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('参数缺失时明确"不可测算"，不显示 0', () => {
    render(<SensitivityCard params={null} />);
    expect(screen.getByText(/不可测算|无法进行确定性算账/)).toBeDefined();
    expect(screen.queryByText('−0.00 亿元')).toBeNull();
  });

  it('渲染基准营收与口径（TTM + 报告期，不得静默换口径）', () => {
    render(<SensitivityCard params={params} />);
    const body = document.body.textContent ?? '';
    expect(body).toContain('TTM');
    expect(body).toContain('2026-2');
  });

  it('显式声明线性一阶近似与"不构成精确盈利预测"', () => {
    render(<SensitivityCard params={params} />);
    const body = document.body.textContent ?? '';
    expect(body).toContain('线性一阶近似');
    expect(body).toContain('不构成精确盈利预测');
  });

  it('拖动滑块实时重算，且全程零网络请求（ADR-0001 决策 1）', () => {
    render(<SensitivityCard params={params} />);
    const slider = screen.getByLabelText('营收整体下滑幅度百分比') as HTMLInputElement;

    const before = document.body.textContent ?? '';

    // 连续拖动多帧，模拟"每帧重算"
    for (const v of [5, 10, 20, 25, 30]) {
      fireEvent.change(slider, { target: { value: String(v) } });
    }

    const after = document.body.textContent ?? '';

    // 1) 结果确实变化了（说明每帧都重算，而非只在松手时算）
    expect(after).not.toBe(before);
    // 2) 而且一个网络请求都没发
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('下滑幅度越大，冲击金额越大（单调性）', () => {
    render(<SensitivityCard params={params} />);
    const slider = screen.getByLabelText('营收整体下滑幅度百分比') as HTMLInputElement;

    fireEvent.change(slider, { target: { value: '5' } });
    const small = document.body.textContent ?? '';
    fireEvent.change(slider, { target: { value: '30' } });
    const large = document.body.textContent ?? '';

    // 从渲染文本里抓出冲击金额做数值比较（避免依赖内部 state）
    const yiOf = (t: string, labelBefore: string) => {
      const i = t.indexOf(labelBefore);
      const m = t.slice(i).match(/−([\d.]+) 亿元/);
      return m ? Number(m[1]) : NaN;
    };
    expect(yiOf(large, '净利润冲击')).toBeGreaterThan(yiOf(small, '净利润冲击'));
  });

  it('显示参数溯源 refId（结论可回溯到原始字段）', () => {
    render(<SensitivityCard params={params} />);
    expect(document.body.textContent ?? '').toContain('ref_3');
  });

  it('滑块区间为 5%~30%', () => {
    render(<SensitivityCard params={params} />);
    const slider = screen.getByLabelText('营收整体下滑幅度百分比') as HTMLInputElement;
    expect(slider.min).toBe('5');
    expect(slider.max).toBe('30');
  });
});
