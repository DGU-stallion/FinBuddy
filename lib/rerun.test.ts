import { describe, it, expect } from 'vitest';
import { buildRerunText } from './rerun';

/**
 * Seam 16: 标签微调后的重跑文本构造（spec 交互决策的下游）
 *
 * 背景：`app/page.tsx` 是最大的渲染面（340 行）却没有测试。它里面真正有规则的部分
 * 就是"把标签变更翻译成一句重跑提问"——抽出来即可精确断言，
 * 同时让页面组件保持纯渲染（与仓库一贯的"纯逻辑与 React 分离"一致）。
 *
 * 抓到：删除与编辑两种意图被混为一谈、标签集合丢失、原命题未带上导致
 *       标的多轮漂移（指代型追问丢标的）。
 * 漏掉：模型收到这句提问后是否真的围绕新标签重做（属模型行为）。
 *
 * 关键红线：重跑提问**必须带住原命题**，否则下一轮的命题重构会失去标的，
 * 标签微调就变成了"换个话题重新开始"。
 */

describe('buildRerunText', () => {
  it('删除标签时明确说明删了什么', () => {
    const t = buildRerunText({
      reason: 'delete',
      tag: '事件: 大客户砍单传闻',
      nextTags: ['标的: 中际旭创'],
      base: '中际旭创业绩稳健。',
    });
    expect(t).toContain('已删除');
    expect(t).toContain('事件: 大客户砍单传闻');
  });

  it('编辑确认时说明是修改后的标签（不写"已删除"）', () => {
    const t = buildRerunText({
      reason: 'edit-confirmed',
      tag: '标的: 宁德时代',
      nextTags: ['标的: 宁德时代'],
      base: '命题',
    });
    expect(t).toContain('修改后');
    expect(t).not.toContain('已删除');
  });

  it('带上变更后的完整标签集合（模型据此收窄）', () => {
    const t = buildRerunText({
      reason: 'delete',
      tag: '事件: x',
      nextTags: ['标的: 中际旭创', '核验维度: 财务支撑'],
      base: '命题',
    });
    expect(t).toContain('标的: 中际旭创');
    expect(t).toContain('核验维度: 财务支撑');
  });

  it('必须带住原命题（否则标的多轮漂移）', () => {
    const t = buildRerunText({
      reason: 'delete',
      tag: 'x',
      nextTags: ['标的: 中际旭创'],
      base: '中际旭创当前业绩强劲，无重大经营风险。',
    });
    expect(t).toContain('中际旭创当前业绩强劲，无重大经营风险。');
  });

  it('base 为空时不留"原命题："空壳（避免模型收到残缺指令）', () => {
    const t = buildRerunText({
      reason: 'delete',
      tag: 'x',
      nextTags: ['标的: 中际旭创'],
      base: '',
    });
    expect(t).not.toMatch(/原命题：\s*$/);
    expect(t).not.toContain('原命题：。');
    expect(t).not.toContain('原命题：');
  });

  it('nextTags 为空时不产生悬空标签串', () => {
    const t = buildRerunText({ reason: 'delete', tag: '唯一标签', nextTags: [], base: '命题' });
    expect(t).not.toMatch(/：\s*。/);
    expect(t).toContain('唯一标签');
  });

  it('确定性：同输入同输出', () => {
    const a = { reason: 'delete' as const, tag: 't', nextTags: ['a', 'b'], base: 'p' };
    expect(buildRerunText(a)).toBe(buildRerunText(a));
  });

  it('是核验向提问，不含买卖操作词（避免重跑先被合规拦下）', () => {
    const t = buildRerunText({
      reason: 'edit-confirmed',
      tag: '标的: 中际旭创',
      nextTags: ['标的: 中际旭创'],
      base: '命题',
    });
    expect(t).not.toMatch(/要不要|该不该|买入|卖出|加仓|满仓|止损/);
    expect(t).toContain('核验');
  });
});
