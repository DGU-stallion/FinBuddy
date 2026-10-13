import { describe, it, expect } from 'vitest';
import { parsePlanJson, buildPlanPrompt, buildSystemPrompt, buildFollowUpPrompt } from './analysis';

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

  it('无上一轮摘要时不注入上下文段（首轮）', () => {
    const p = buildSystemPrompt(plan);
    expect(p).not.toContain('上一轮');
  });
});

describe('buildSystemPrompt · 多轮上下文（T5）', () => {
  const plan = {
    reframedClaim: '宁德时代固态电池量产未出现官方确认的重大延期。',
    intentTags: ['标的: 宁德时代'],
    subQuestions: [{ question: '公告有无披露？', verificator: 'announcements' as const }],
  };

  it('注入上一轮结构化摘要（标的 + 已确认事实）', () => {
    const summary = '【上一轮已确认的结构化结论】\n本轮标的：宁德时代\n已确认事实：\n- [ref_4] 行情快照：宁德时代(300750.SZ)，最新价 298.38 元';
    const p = buildSystemPrompt(plan, summary);
    expect(p).toContain('298.38');
    expect(p).toContain('上一轮');
  });

  it('注入的是摘要而非完整对话：长正文不应出现在提示词里', () => {
    const p = buildSystemPrompt(plan, '本轮标的：宁德时代');
    expect(p.length).toBeLessThan(6000);
  });
});

describe('buildPlanPrompt · 多轮上下文（T5）', () => {
  it('追问时把上一轮标的写进提示词，避免标的多轮漂移', () => {
    const p = buildPlanPrompt('那它的毛利率呢？', '本轮标的：宁德时代');
    expect(p).toContain('宁德时代');
  });

  it('首轮不带摘要时提示词不含上下文段', () => {
    const p = buildPlanPrompt('宁德时代怎么样');
    expect(p).not.toContain('本轮标的：');
  });
});

describe('buildFollowUpPrompt（追问必须在**本轮末尾**基于本轮发现生成）', () => {
  // ADR-0002 补充决策 5 原文：「底部 3 个追问按钮由 LLM **在本轮末尾**生成
  // （保证逻辑递进）」。原实现把追问放在计划阶段（分析之前）产出，
  // 与本轮证据发现完全无关 —— 无法像票面例子那样针对本轮结果下钻。
  const plan = {
    reframedClaim: '中际旭创业绩未因砍单传闻恶化。',
    intentTags: ['标的: 中际旭创'],
    subQuestions: [{ question: '营收多少？', verificator: 'financials' as const }],
  };

  it('把本轮正文摘要交给提示词（追问才有依据下钻）', () => {
    const p = buildFollowUpPrompt(plan, '【支持证据】TTM 营收 1245 亿，净利率 35%。', 3);
    expect(p).toContain('1245 亿');
  });

  it('要求恰好 3 条，且是证伪/下钻/对比三类方向', () => {
    const p = buildFollowUpPrompt(plan, '正文', 3);
    expect(p).toContain('3');
    expect(p).toMatch(/证伪|下钻|对比/);
  });

  it('禁止操作向与预测向（复用合规红线措辞）', () => {
    const p = buildFollowUpPrompt(plan, '正文', 3);
    expect(p).toMatch(/禁止|不得|绝不/);
    expect(p).toMatch(/买入|卖出|操作/);
  });

  it('要求围绕本轮已查到的具体事实下钻（而非泛泛而谈）', () => {
    const p = buildFollowUpPrompt(plan, '正文', 3);
    expect(p).toMatch(/本轮|已查到|具体/);
  });

  it('无正文时不崩（降级为空摘要）', () => {
    expect(() => buildFollowUpPrompt(plan, '', 3)).not.toThrow();
  });

  it('确定性：同输入同输出', () => {
    expect(buildFollowUpPrompt(plan, 'x', 3)).toBe(buildFollowUpPrompt(plan, 'x', 3));
  });
});
