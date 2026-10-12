import { describe, it, expect } from 'vitest';
import { buildOrchestrationSteps, refKind, extractSubjectHint } from './orchestration';
import type { AnalysisPlan } from './analysis';

/**
 * Seam 7: 编排步骤时间轴（T4「思考过程时间轴」的数据源）
 *
 * 公共接口：
 *  - buildOrchestrationSteps(plan, fromModel): 生成确定性中文步骤清单
 *  - refKind(payload): 判定存证 payload 属于哪个数据源（供抽屉分组展示）
 *
 * 抓到：步骤文案为空、步骤未覆盖工具预算、payload 形状无法归类。
 * 漏掉：真实耗时（运行时数据，由前端计时，不在此处伪造）。
 *
 * 关键红线（handoff 第 6 条）：时间轴必须展示**我们自己的编排步骤**（确定性中文），
 * 不得依赖模型原始推理（模型倾向英文且不稳定）。因此这里是纯函数，不含模型调用。
 */

const plan: AnalysisPlan = {
  reframedClaim: '中际旭创当前业绩强劲，无重大经营风险。',
  intentTags: ['标的: 中际旭创', '事件: 大客户砍单传闻'],
  subQuestions: [
    { question: '营收与净利率是多少？', verificator: 'financials' },
    { question: '公告有无相关披露？', verificator: 'announcements' },
  ],
};

describe('buildOrchestrationSteps', () => {
  it('产出非空的中文步骤，且覆盖命题重构与子问题核验', () => {
    const steps = buildOrchestrationSteps(plan, true);
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.map((s) => s.label).join()).toContain('命题重构');
    for (const sq of plan.subQuestions) {
      expect(steps.map((s) => s.detail).join()).toContain(sq.question);
    }
  });

  it('每个步骤都有非空的中文标签（供时间轴渲染）', () => {
    for (const s of buildOrchestrationSteps(plan, true)) {
      expect(s.label.trim()).not.toBe('');
      expect(s.label).toMatch(/[\u4e00-\u9fa5]/);
      expect(s.id.trim()).not.toBe('');
    }
  });

  it('步骤 id 唯一（前端用作 React key）', () => {
    const ids = buildOrchestrationSteps(plan, true).map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('回退到兜底计划时显式标注（不伪装成模型产出）', () => {
    const steps = buildOrchestrationSteps(plan, false);
    expect(steps.some((s) => s.detail.includes('兜底'))).toBe(true);
  });

  it('确定性：同输入两次结果一致', () => {
    expect(buildOrchestrationSteps(plan, true)).toEqual(buildOrchestrationSteps(plan, true));
  });
});

describe('refKind', () => {
  it('按 payload 的 source 归类数据源', () => {
    expect(refKind({ source: '扶摇 · 行情/估值快照', data: {} })).toBe('snapshot');
    expect(refKind({ source: '扶摇 · 利润表/财务指标', data: {} })).toBe('financials');
    expect(refKind({ source: 'iFinD · 公告检索', items: [] })).toBe('announcements');
  });

  it('无法归类时返回 unknown（不猜）', () => {
    expect(refKind(null)).toBe('unknown');
    expect(refKind({})).toBe('unknown');
    expect(refKind({ source: '某个未知来源' })).toBe('unknown');
  });
});

describe('extractSubjectHint（兜底计划的标的不丢失）', () => {
  it('从用户原话里取显式 6 位代码（这是用户自己给的，不是猜）', () => {
    expect(extractSubjectHint('300308 大客户砍单，业绩会崩吗')).toBe('中际旭创');
    expect(extractSubjectHint('600519 最近怎么样')).toBe('600519');
  });

  it('命中预置案例名时取其规范名（仓库内已知实体）', () => {
    expect(extractSubjectHint('宁德时代固态电池冲击大吗')).toBe('宁德时代');
    expect(extractSubjectHint('中际旭创大客户砍单传闻')).toBe('中际旭创');
  });

  it('无法识别时返回 null（调用方兜底为"该标的"，绝不猜）', () => {
    expect(extractSubjectHint('随便看看')).toBeNull();
    expect(extractSubjectHint('')).toBeNull();
  });

  it('确定性：同输入同输出', () => {
    expect(extractSubjectHint('宁德时代')).toBe(extractSubjectHint('宁德时代'));
  });
});
