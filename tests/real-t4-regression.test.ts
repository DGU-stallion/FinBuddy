import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deriveViews } from '@/lib/message-view';
import { parseBodyLines } from '@/lib/markdown';

/**
 * T4 真实输出回归（真机 fixture → 前端视图模型）
 *
 * 用 2026-10-13 真机抓取的一份完整运行（中际旭创砍单核验，DeepSeek + 扶摇 + iFinD）
 * 回归前端解析链路。**这是真实模型的原始输出，不是构造数据。**
 *
 * 铁律：fixture 是真实输出，**不得为了让测试通过而修改它**。
 * 若测试失败，先怀疑解析逻辑或词表，而不是改 fixture。
 *
 * 抓到：真实输出里 data part 缺失/形状变化、角标集合解析错误、
 *       财务参数注入断裂（会让 T5 测算卡片消失）。
 * 漏掉：真实浏览器 DOM（由组件测试覆盖）。
 */

const fix = JSON.parse(
  readFileSync(join(process.cwd(), 'tests/fixtures/real-t4-run.json'), 'utf8'),
) as {
  capturedAt: string;
  question: string;
  parts: Array<{ type: string; id?: string; data: unknown }>;
  body: string;
};

function viewsFromFixture() {
  return deriveViews({
    messages: [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: fix.question }] },
      {
        id: 'a1',
        role: 'assistant',
        parts: [...fix.parts, { type: 'text', text: fix.body, state: 'done' }],
      },
    ],
  });
}

describe('T4 真实输出回归', () => {
  it('fixture 含全部 5 个 data part（契约漂移会立刻暴露）', () => {
    const types = fix.parts.map((p) => p.type).sort();
    expect(types).toEqual([
      'data-contract',
      'data-followups',
      'data-plan',
      'data-refs',
      'data-steps',
    ]);
  });

  it('解析为分析轮次（非合规轮次）', () => {
    const [v] = viewsFromFixture();
    expect(v.kind).toBe('analysis');
    expect(v.complianceLayer).toBeNull();
  });

  it('时间轴、命题、标签、子问题均解析出来', () => {
    const [v] = viewsFromFixture();
    expect(v.steps.length).toBeGreaterThanOrEqual(5);
    expect(v.plan).not.toBeNull();
    expect(v.plan!.reframedClaim.length).toBeGreaterThan(10);
    expect(v.plan!.intentTags.some((t) => t.startsWith('标的'))).toBe(true);
    expect(v.plan!.subQuestions.length).toBeGreaterThanOrEqual(2);
  });

  it('存证集合完整，且角标校验集合与之相等', () => {
    const [v] = viewsFromFixture();
    expect(v.refs.length).toBeGreaterThanOrEqual(3);
    expect(v.allowedRefIds).toEqual(v.refs.map((r) => r.refId));
  });

  it('真实输出满足输出契约（三栏非空 + 角标全部可溯源）', () => {
    const [v] = viewsFromFixture();
    expect(v.contract).not.toBeNull();
    expect(v.contract!.violations).toEqual([]);
    expect(v.contract!.ok).toBe(true);
    expect(v.contract!.citations.invalid).toEqual([]);
    expect(v.contract!.citations.hasAny).toBe(true);
  });

  it('三栏在真实正文里都有实质内容（不是占位符糊弄）', () => {
    const [v] = viewsFromFixture();
    for (const name of ['支持证据', '反对证据', '无法验证项']) {
      const m = v.body.match(new RegExp(`【${name}】([\\s\\S]*?)(?=【|$)`));
      expect(m, `缺少分栏【${name}】`).not.toBeNull();
      const content = m![1].trim();
      expect(content.length).toBeGreaterThan(30);
      expect(content).not.toMatch(/^(无|暂无|没有|待补充)$/);
    }
  });

  it('追问为 3 条核验向问题', () => {
    const [v] = viewsFromFixture();
    expect(v.followUps).toHaveLength(3);
    for (const q of v.followUps) expect(q.trim().length).toBeGreaterThan(5);
  });

  it('敏感性参数从真实 financials 存证注入（T5 测算卡片的数据源）', () => {
    const [v] = viewsFromFixture();
    expect(v.sensitivityParams).not.toBeNull();
    expect(v.sensitivityParams!.baseRevenue).toBeGreaterThan(1e11); // 千亿级年化营收
    expect(v.sensitivityParams!.netMargin).toBeGreaterThan(0);
    expect(v.sensitivityParams!.taxRate).toBeGreaterThan(0);
    expect(v.sensitivityParams!.revenueBasis).toBe('TTM');
    expect(v.sensitivityParams!.refId).toMatch(/^ref_\d+$/);
  });

  it('无降级数据时不虚报降级指示灯', () => {
    const [v] = viewsFromFixture();
    expect(v.degraded).toBeNull();
  });

  it('确定性：同 fixture 两次解析结果一致', () => {
    expect(viewsFromFixture()).toEqual(viewsFromFixture());
  });
});

describe('T4 真实输出回归 · Markdown 渲染（真机正文含 ** 与 - ）', () => {
  it('真实正文三栏内**不产生字面星号**（曾显示为 **客户订单** 原样外露）', () => {
    const [v] = viewsFromFixture();
    const cols = ['支持证据', '反对证据', '无法验证项'];
    for (const name of cols) {
      const m = v.body.match(new RegExp(`【${name}】([\\s\\S]*?)(?=【|$)`));
      expect(m).not.toBeNull();
      // parseBodyLines 处理后的**可见文本**不得残留 ** 标记
      const visible = parseBodyLines(m![1].trim())
        .flatMap((l) => l.token)
        .map((t) => t.value)
        .join('');
      expect(visible, `【${name}】仍含字面 ** 标记`).not.toContain('**');
    }
  });

  it('真实正文的加粗内容被识别出来（证明解析确实生效，而非碰巧没有星号）', () => {
    const [v] = viewsFromFixture();
    const hasBold = parseBodyLines(v.body).some((l) => l.token.some((t) => t.type === 'bold'));
    expect(hasBold).toBe(true);
  });

  it('真实正文的列表项被识别（"- " 不被原样显示）', () => {
    const [v] = viewsFromFixture();
    const liCount = parseBodyLines(v.body).filter((l) => l.type === 'li').length;
    expect(liCount).toBeGreaterThan(0);
  });
});
