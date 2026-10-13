/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EvidenceDrawer } from './EvidenceDrawer';
import type { RefEntry } from '@/lib/evidence';

/**
 * Seam 8 渲染层：存证抽屉（ADR-0002 决策 4）
 *
 * 抓到：抽屉数据取自正文转述而非原始 payload、降级状态未显著标注、
 *       原始 JSON 不可下钻、引用集合外的角标也能开抽屉。
 * 漏掉：滑出动画的视觉平滑度（jsdom 不体现）。
 *
 * 关键红线：
 *  - **抽屉数据以工具原始 payload 为准，不信正文转述**。
 *  - 默认层是人类可读摘要；完整原始 JSON 在可折叠的第二层。
 *  - 降级存证必须显著标注"非实时"与抓取日期。
 *  - 本轮返回集合外的角标**无法开抽屉**（ADR-0002 决策 2）。
 */

const snapshotRef: RefEntry = {
  refId: 'ref_4',
  kind: 'snapshot',
  payload: {
    refId: 'ref_4',
    source: '扶摇 · 行情/估值快照',
    asOf: Date.UTC(2026, 9, 12, 3, 30),
    isFallback: false,
    data: {
      thscode: '300308.SZ',
      name: '中际旭创',
      last_price: 724.47,
      price_change_ratio_pct: -6.411316,
      pe_ttm: 41.722396,
    },
  },
};

const fallbackRef: RefEntry = {
  refId: 'ref_1',
  kind: 'snapshot',
  payload: {
    refId: 'ref_1',
    source: 'L2 本地存证 · 扶摇历史快照',
    asOf: Date.UTC(2026, 9, 12),
    isFallback: true,
    fallbackNote: '抓取于 2026-10-12，非实时行情',
    data: { thscode: '300308.SZ', name: '中际旭创', last_price: 724.47 },
  },
};

const open = (refId: string, refs: RefEntry[], onClose = () => {}, onNavigate = () => {}) =>
  render(
    <EvidenceDrawer refId={refId} refs={refs} onClose={onClose} onNavigate={onNavigate} />,
  );

describe('EvidenceDrawer', () => {
  it('refId 为 null 时关闭（不显示内容）', () => {
    render(<EvidenceDrawer refId={null} refs={[snapshotRef]} onClose={() => {}} onNavigate={() => {}} />);
    expect(document.body.textContent).not.toContain('最新价');
  });

  it('默认层展示人类可读摘要（标的名 + 关键字段）', () => {
    open('ref_4', [snapshotRef]);
    const t = document.body.textContent ?? '';
    expect(t).toContain('中际旭创');
    expect(t).toContain('300308.SZ');
    expect(t).toContain('最新价');
    expect(t).toContain('724.47');
  });

  it('第二层可折叠展示完整原始 JSON（回到原始字段）', () => {
    open('ref_4', [snapshotRef]);
    expect(screen.getByText(/查看完整原始 JSON/)).toBeDefined();
    // pre 里应是原始 payload 的序列化
    const pre = document.querySelector('pre');
    expect(pre?.textContent).toContain('"price_change_ratio_pct"');
    expect(pre?.textContent).toContain('-6.411316'); // 未被四舍五入 → 确为原始值
  });

  it('实时数据显示"实时返回"状态', () => {
    open('ref_4', [snapshotRef]);
    expect(document.body.textContent).toContain('实时返回');
  });

  it('降级数据显示"降级存证 · 非实时"与抓取日期（ADR-0001 决策 3）', () => {
    open('ref_1', [fallbackRef]);
    const t = document.body.textContent ?? '';
    expect(t).toContain('降级存证');
    expect(t).toContain('非实时');
    expect(t).toContain('2026-10-12');
  });

  it('引用集合外的角标无法开抽屉（显示编造提示）', () => {
    open('ref_99', [snapshotRef]);
    const t = document.body.textContent ?? '';
    expect(t).toMatch(/不在本轮工具返回的存证集合内/);
    // 不应泄露任何存证内容
    expect(t).not.toContain('724.47');
  });

  it('数据源名与时间戳被标注', () => {
    open('ref_4', [snapshotRef]);
    const t = document.body.textContent ?? '';
    expect(t).toContain('扶摇 · 行情/估值快照');
    expect(t).toMatch(/时点/);
  });

  it('点关闭触发 onClose', () => {
    const onClose = vi.fn();
    open('ref_4', [snapshotRef], onClose);
    fireEvent.click(screen.getByLabelText('关闭存证抽屉'));
    expect(onClose).toHaveBeenCalled();
  });

  it('多个存证时提供导航，点击切换', () => {
    const onNavigate = vi.fn();
    open('ref_4', [snapshotRef, fallbackRef], () => {}, onNavigate);
    // footer 里的 ref_1 按钮
    const btn = screen.getByRole('button', { name: 'ref_1' });
    fireEvent.click(btn);
    expect(onNavigate).toHaveBeenCalledWith('ref_1');
  });

  it('红涨绿跌：负涨幅显示为绿色（A 股惯例）', () => {
    open('ref_4', [snapshotRef]);
    const t = document.body.textContent ?? '';
    expect(t).toContain('-6.41%');
    const dd = [...document.querySelectorAll('dd')].find((el) => el.textContent?.includes('-6.41%'));
    expect(dd?.className).toContain('emerald');
  });

  it('末尾字段值不含 undefined/NaN（缺失写"缺失"）', () => {
    const sparse: RefEntry = {
      refId: 'ref_9',
      kind: 'snapshot',
      payload: { refId: 'ref_9', source: 'x', asOf: 0, isFallback: false, data: {} },
    };
    open('ref_9', [sparse]);
    const t = document.body.textContent ?? '';
    expect(t).toContain('缺失');
    expect(t).not.toMatch(/undefined|NaN/);
  });
});
