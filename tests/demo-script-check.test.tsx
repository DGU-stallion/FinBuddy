/**
 * @vitest-environment jsdom
 *
 * 演示脚本与真实渲染的一致性守卫（DEMO.md ↔ 组件实际输出）
 *
 * 为什么要有这个文件：本仓库有"文档与实现漂移"的前科（曾写过未发生的完成记录）。
 * DEMO.md 描述录制时的画面文案，如果文案与真实渲染不符，录制者会以为环境坏了，
 * 或更糟 —— 照着脚本念了台上根本不存在的字。
 *
 * 公共接口：无（这是守卫测试，断言 DEMO.md 引用的画面文案确实会被渲染）
 * 抓到：DEMO.md 声称的画面上不存在（如把"本轮未取得可测算的财务参数"写成"不可测算"）
 * 漏掉：脚本的叙事节奏与口播质量（人判断）
 *
 * 关键红线：DEMO.md 的每个"画面验收点"都应能被渲染断言覆盖；
 * 断言失败时改**脚本文案**或改**实现**，而不是删断言。
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { SensitivityCard } from '@/components/SensitivityCard';
import { EvidenceDrawer } from '@/components/EvidenceDrawer';

const params = { refId:'ref_3', baseRevenue: 124519000000, netMargin: 35.27, taxRate: 15, revenueBasis:'TTM', report:'2026-2', asOf: Date.UTC(2026,9,12) };

describe('DEMO.md 画面文案核对（渲染后真实可见）', () => {
  it('SensitivityCard 渲染出所有脚本声称的文案', () => {
    render(<SensitivityCard params={params} />);
    const t = document.body.textContent ?? '';
    for (const k of ['营收冲击推演','确定性公式','净利润冲击','营收整体下滑幅度','线性一阶近似','不构成精确盈利预测','模型简化声明','TTM','2026-2','ref_3']) {
      expect(t, `缺少「${k}」`).toContain(k);
    }
  });

  it('参数缺失时明确说明无法测算（DEMO.md 排查表按此文案修正）', () => {
    render(<SensitivityCard params={null} />);
    expect(document.body.textContent).toContain('本轮未取得可测算的财务参数');
  });

  it('EvidenceDrawer 含原始 JSON 折叠层与状态标签', () => {
    render(<EvidenceDrawer refId="ref_1" refs={[{refId:'ref_1',kind:'snapshot',payload:{refId:'ref_1',source:'扶摇 · 行情/估值快照',asOf:Date.UTC(2026,9,12),isFallback:false,data:{name:'中际旭创',thscode:'300308.SZ',last_price:724.47,price_change_ratio_pct:-6.411}}}]} onClose={()=>{}} onNavigate={()=>{}} />);
    const t = document.body.textContent ?? '';
    for (const k of ['查看完整原始 JSON','实时返回','最新价','724.47']) expect(t,`缺少「${k}」`).toContain(k);
  });

  it('降级存证时渲染降级标签', () => {
    render(<EvidenceDrawer refId="ref_1" refs={[{refId:'ref_1',kind:'snapshot',payload:{refId:'ref_1',source:'L2 本地存证',asOf:Date.UTC(2026,9,12),isFallback:true,fallbackNote:'抓取于 2026-10-12，非实时行情'}}]} onClose={()=>{}} onNavigate={()=>{}} />);
    const t = document.body.textContent ?? '';
    expect(t).toContain('降级存证');
    expect(t).toContain('非实时');
    expect(t).toContain('2026-10-12');
  });
});
