import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { searchAnnouncementsAndNews } from '@/lib/gateway';
import { validateAnalysisOutput } from '@/lib/output-contract';

/**
 * T3 缺口补齐：信息真空期 → 【无法验证项】端到端链路
 *
 * code-review Spec 轴指出：真实流的"真空期→无法验证项"链路未被测试。
 * 这里把 gateway（硬编码真空期）与 output-contract（声明校验）串起来验证，
 * 覆盖 ADR-0001 决策 2："网关层强制归入无法验证项，LLM 不得翻案"。
 *
 * 抓到：真空期信号丢失、LLM 脑补成正常结论、契约放过脑补正文、
 *       keyword 与自然语言措辞不一致导致的假违规。
 * 漏掉：真实 iFinD 的网络行为（由 tests/gateway.integration.test.ts 覆盖）。
 */

const deps = {
  // gateway 只用到 ifind；fuyao 不会被调用，占位即可
  fuyao: (async () => {
    throw new Error('fuyao 不应被调用');
  }) as never,
  ifind: vi.fn(),
};

beforeEach(() => {
  deps.ifind.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

// 脑补版：【无法验证项】既没提该子问题的主题，也没声明"查不到"的状态。
const BRAIN_FILLED = `【命题重构】
中际旭创当前业绩强劲。

【支持证据】
- 营收同比增长[^ref_1]。

【反对证据】
- 现金流承压[^ref_1]。

【无法验证项】
- 其他风险可控。

【敏感性测算】
基于 TTM 营收。`;

// 诚实版：明确点名该子问题并声明信息真空期，不做推测。
const HONEST = BRAIN_FILLED.replace(
  '- 其他风险可控。',
  '- 大客户砍单传闻：公告检索未返回任何结果，处于信息真空期，无法核验，不做任何推测。',
);

describe('真空期 → 无法验证项 链路', () => {
  it('iFinD 失败时网关硬编码 vacuum=true（不伪造公告）', async () => {
    deps.ifind.mockRejectedValue(new Error('iFinD down'));
    const r = await searchAnnouncementsAndNews('中际旭创', '客户 订单', 'ref_3', 400, deps);
    expect(r.vacuum).toBe(true);
    expect(r.items).toEqual([]);
  });

  it('LLM 把真空期脑补成正常结论时，契约报 missing_vacuum_disclosure', async () => {
    deps.ifind.mockRejectedValue(new Error('iFinD down'));
    const gw = await searchAnnouncementsAndNews('中际旭创', '客户 订单', 'ref_3', 400, deps);
    expect(gw.vacuum).toBe(true);

    // 模拟 route：把该次检索记录为真空期子问题（keyword 为检索用词）
    const ctx = {
      refIds: ['ref_1', 'ref_3'],
      fallbackRefs: [],
      vacuumSubQuestions: [{ question: '大客户砍单传闻是否有官方披露？', keyword: '客户 订单' }],
    };

    const bad = validateAnalysisOutput(BRAIN_FILLED, ctx);
    expect(bad.violations.map((v) => v.code)).toContain('missing_vacuum_disclosure');

    const good = validateAnalysisOutput(HONEST, ctx);
    expect(good.violations.map((v) => v.code)).not.toContain('missing_vacuum_disclosure');
  });

  it('真空期正文必须显式出现"信息真空期"这类状态词（否则视为脑补）', async () => {
    deps.ifind.mockRejectedValue(new Error('iFinD down'));
    await searchAnnouncementsAndNews('中际旭创', '客户 订单', 'ref_3', 400, deps);
    const ctx = {
      refIds: ['ref_1'],
      fallbackRefs: [],
      vacuumSubQuestions: [{ question: '客户订单是否有披露？', keyword: '客户 订单' }],
    };
    // 用模糊措辞蒙混（提及客户但把它写成了正常结论，没说明真空期状态）
    const evasive = BRAIN_FILLED.replace(
      '- 其他风险可控。',
      '- 客户与订单情况已在公告中有所体现。',
    );
    const r = validateAnalysisOutput(evasive, ctx);
    // 未提到真空期状态 → 应报违规（这正是"不得脑补"的机械判定）
    expect(r.violations.map((v) => v.code)).toContain('missing_vacuum_disclosure');
  });
});
