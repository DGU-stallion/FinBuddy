import { describe, it, expect } from 'vitest';
import { parsePlanJson, buildPlanPrompt, buildSystemPrompt } from './analysis';

/**
 * Seam 3b: 模型产出的解析与提示词构造（lib/analysis.ts 的另一半）
 *
 * 公共接口：
 *  - parsePlanJson(raw): 容错解析模型输出的 JSON（含 ```json 围栏、前后废话）
 *  - buildPlanPrompt(userText): 构造要求模型输出分析计划的提示词
 *  - buildSystemPrompt(plan): 构造主循环系统提示词，把已确认的命题与子问题写进去
 *
 * 抓到：模型套 Markdown 代码围栏、输出前后带解释文字、返回非 JSON。
 * 漏掉：模型是否真的遵守提示词（模型行为，不可测）。
 *
 * 关键红线：解析失败必须抛错或返回 null，由调用方回退兜底，
 * 绝不能"尽力猜"出一个半成品计划 —— 那会让三栏建立在错误命题上。
 */

const PLAN_JSON = JSON.stringify({
  reframedClaim: '中际旭创当前业绩强劲，无重大经营风险。',
  intentTags: ['标的: 中际旭创'],
  subQuestions: [
    { question: '营收与净利率是多少？', verificator: 'financials' },
    { question: '公告有无相关披露？', verificator: 'announcements' },
  ],
});

describe('parsePlanJson', () => {
  it('解析裸 JSON', () => {
    const r = parsePlanJson(PLAN_JSON);
    expect(r).not.toBeNull();
    expect(r?.reframedClaim).toContain('中际旭创');
  });

  it('解析被 ```json 围栏包裹的输出', () => {
    const r = parsePlanJson('```json\n' + PLAN_JSON + '\n```');
    expect(r?.reframedClaim).toContain('中际旭创');
  });

  it('解析前后带解释文字的输出（取第一个完整 JSON 对象）', () => {
    const r = parsePlanJson('好的，分析如下：\n' + PLAN_JSON + '\n以上，请核验。');
    expect(r?.subQuestions).toHaveLength(2);
  });

  it('解析不带围栏的 ``` 包裹', () => {
    const r = parsePlanJson('```\n' + PLAN_JSON + '\n```');
    expect(r).not.toBeNull();
  });

  it('非 JSON 输出返回 null（不猜）', () => {
    expect(parsePlanJson('我无法完成该请求。')).toBeNull();
    expect(parsePlanJson('')).toBeNull();
  });

  it('JSON 合法但不是对象（数组/字符串）返回 null', () => {
    expect(parsePlanJson('[1,2,3]')).toBeNull();
    expect(parsePlanJson('"一段文字"')).toBeNull();
    expect(parsePlanJson('null')).toBeNull();
  });

  it('嵌套花括号能正确配对（不是靠第一个 } 截断）', () => {
    const nested = '前言 ' + JSON.stringify({ a: { b: 1 }, reframedClaim: 'x' }) + ' 后语';
    const r = parsePlanJson(nested);
    expect(r).toEqual({ a: { b: 1 }, reframedClaim: 'x' });
  });
});

describe('buildPlanPrompt', () => {
  it('包含用户原话，并要求标的标签与 2~3 个子问题', () => {
    const p = buildPlanPrompt('中际旭创大客户砍单，业绩会崩吗');
    expect(p).toContain('中际旭创大客户砍单，业绩会崩吗');
    expect(p).toMatch(/标的\s*[:：]/);
    expect(p).toContain('2');
    expect(p).toContain('3');
  });

  it('要求命题是基本面可证伪陈述，禁止股价预测与买卖指令', () => {
    const p = buildPlanPrompt('x');
    expect(p).toMatch(/预测|目标价/);
    expect(p).toMatch(/证伪/);
  });

  it('列出可供选择的核验方名称（与工具名对齐）', () => {
    const p = buildPlanPrompt('x');
    expect(p).toContain('financials');
    expect(p).toContain('announcements');
    expect(p).toContain('snapshot');
  });

  it('要求输出 JSON 且含 followUps（核验向 3 条）', () => {
    const p = buildPlanPrompt('x');
    expect(p).toContain('followUps');
    expect(p).toContain('JSON');
  });
});

describe('buildSystemPrompt', () => {
  const plan = {
    reframedClaim: '中际旭创当前业绩强劲，无重大经营风险。',
    intentTags: ['标的: 中际旭创', '事件: 大客户砍单传闻'],
    subQuestions: [
      { question: '营收与净利率是多少？', verificator: 'financials' as const },
      { question: '公告有无相关披露？', verificator: 'announcements' as const },
    ],
  };

  it('把已确认的命题与子问题写进提示词（模型不必再拆解）', () => {
    const p = buildSystemPrompt(plan);
    expect(p).toContain('中际旭创当前业绩强劲');
    expect(p).toContain('营收与净利率是多少？');
  });

  it('强制三栏输出与角标规范', () => {
    const p = buildSystemPrompt(plan);
    for (const s of ['命题重构', '支持证据', '反对证据', '无法验证项']) {
      expect(p).toContain(s);
    }
    expect(p).toContain('[^ref_');
  });

  it('禁止买卖结论与股价预测', () => {
    const p = buildSystemPrompt(plan);
    expect(p).toMatch(/绝不.*建议|不得.*建议/);
  });

  it('要求信息真空期归入无法验证项，不得脑补', () => {
    const p = buildSystemPrompt(plan);
    expect(p).toContain('真空');
    expect(p).toMatch(/不得|禁止/);
  });

  it('不再要求模型生成追问（追问由计划阶段产出，走确定性过滤）', () => {
    const p = buildSystemPrompt(plan);
    expect(p).not.toContain('生成 3 个');
  });
});
