import { NextRequest } from 'next/server';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {
  streamText,
  tool,
  generateText,
  stepCountIs,
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessage,
} from 'ai';
import { z } from 'zod';
import { resolveTicker } from '@/lib/ticker';
import {
  lookupStockSnapshot,
  lookupFinancialReport,
  searchAnnouncementsAndNews,
} from '@/lib/gateway';
import { formatSnapshotForLLM, formatFinancialsForLLM } from '@/lib/format';
import { detectTradeSeeking, complianceNotice } from '@/lib/compliance';
import { classifyIntent, modelAsIntentModel } from '@/lib/intent';
import { createRefAllocator } from '@/lib/refs';
import type { SnapshotPayload, FinancialsPayload } from '@/lib/format';
import {
  parsePlanJson,
  validateAnalysisPlan,
  buildPlanPrompt,
  buildSystemPrompt,
  buildFollowUpPrompt,
  fallbackReframe,
  type AnalysisPlan,
} from '@/lib/analysis';
import { sanitizeFollowUps, FOLLOWUP_COUNT } from '@/lib/followups';
import { validateAnalysisOutput } from '@/lib/output-contract';
import { checkCitations } from '@/lib/citations';
import { buildOrchestrationSteps, refKind, extractSubjectHint } from '@/lib/orchestration';
import { buildContextSummary, selectCurrentTurn } from '@/lib/context-summary';

// T4 前端消费的 data part 名（route 文件只得导出 HTTP 方法，故不 export 此常量）
const PART = {
  steps: 'steps',
  plan: 'plan',
  refs: 'refs',
  contract: 'contract',
  followups: 'followups',
  compliance: 'compliance',
} as const;

export const maxDuration = 60;

const MODEL_ID = 'deepseek-flash';

const deepseek = createOpenAICompatible({
  name: 'deepseek',
  baseURL: (process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com') + '/v1',
  apiKey: process.env.DEEPSEEK_API_KEY ?? '',
});

// ---------- 分析契约（T3） ----------

/** 从意图标签里取标的名（用于兜底命题与兜底追问的主语）。 */
function subjectFromTags(tags: string[]): string {
  const tag = tags.find((t) => /^标的\s*[:：]/.test(t));
  return tag ? tag.replace(/^标的\s*[:：]\s*/, '').trim() : '该标的';
}

/** 确定性兜底计划：绝不产出“没有命题”的状态（那会让三栏失去辩证基准）。 */
function fallbackPlan(subject: string): AnalysisPlan {
  return {
    reframedClaim: fallbackReframe(subject),
    intentTags: [`标的: ${subject}`],
    subQuestions: [
      { question: `${subject}最近报告期的营收、净利率与毛利率是多少？`, verificator: 'financials' },
      { question: `${subject}近期公告与新闻中是否有相关披露？`, verificator: 'announcements' },
    ],
  };
}

/**
 * 在本轮末尾生成追问（ADR-0002 补充决策 5：「由 LLM 在本轮末尾生成」）。
 *
 * 与原实现的区别（T4 Spec 轴评审抓出的缺陷）：原先把追问放在**计划阶段**
 * 与命题一并产出，只依据用户提问，与本轮查到的证据无关 —— 无法针对本轮结果下钻。
 * 现在把已成稿的正文作为依据，三个方向：证伪 / 下钻 / 对比。
 *
 * 任何失败都回退到确定性核验向兜底，绝不暴露失败，也绝不放行操作向问题。
 */
async function generateFollowUps(
  plan: AnalysisPlan,
  body: string,
  subject: string,
): Promise<string[]> {
  let raw: string;
  try {
    const r = await generateText({
      model: deepseek(MODEL_ID),
      prompt: buildFollowUpPrompt(plan, body, FOLLOWUP_COUNT),
      temperature: 0,
    });
    raw = r.text;
  } catch {
    return sanitizeFollowUps([], { subject });
  }

  // 追问是 JSON 数组（不是对象），单独解析
  let arr: unknown = null;
  try {
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fence?.[1] ?? raw;
    const start = candidate.indexOf('[');
    const end = candidate.lastIndexOf(']');
    if (start !== -1 && end > start) arr = JSON.parse(candidate.slice(start, end + 1));
  } catch {
    arr = null;
  }

  // 无论模型给了什么，都必须过确定性核验向过滤并补齐到恒 3 条
  return sanitizeFollowUps(arr, { subject });
}

interface PlannedAnalysis {
  plan: AnalysisPlan;
  /**
   * 计划阶段的追问**已废弃**：追问改到本轮末尾生成（见 generateFollowUps），
   * 因为它需要本轮查到的证据作为依据。保留字段仅用于兜底路径的立即填值。
   */
  followUps: string[];
  /** 计划是否由模型产出（false 表示已回退到确定性兜底，供前端标注）。 */
  fromModel: boolean;
}

/**
 * 命题重构 + 子问题拆解 + 追问生成。
 *
 * 一次非流式轻量调用拿结构化计划。任何失败（超时/解析错/校验不过）
 * 一律回退到确定性兜底，绝不把失败暴露给用户，也绝不让模型自由发挥三栏。
 */
async function planAnalysis(userText: string, priorSummary?: string): Promise<PlannedAnalysis> {
  const fallback = (): PlannedAnalysis => {
    // 尽量保留用户提到的标的名（绝不猜代码：无法识别时用"该标的"）
    const subject = extractSubjectHint(userText) ?? '该标的';
    return {
      plan: fallbackPlan(subject),
      followUps: sanitizeFollowUps([], { subject }),
      fromModel: false,
    };
  };

  let raw: string;
  try {
    const r = await generateText({
      model: deepseek(MODEL_ID),
      prompt: buildPlanPrompt(userText, priorSummary),
      temperature: 0,
    });
    raw = r.text;
  } catch {
    return fallback();
  }

  // 只解析一次，复用给校验与追问抽取（避免重复 parse）
  const parsed = parsePlanJson(raw);
  const validation = validateAnalysisPlan(parsed);
  if (!validation.ok) return fallback();

  const plan = validation.plan;
  const subject = subjectFromTags(plan.intentTags);

  // 追问模型单独给了一份，此处一并抽出来过确定性过滤
  const followUps = sanitizeFollowUps(parsed?.followUps, { subject });

  return { plan, followUps, fromModel: true };
}

/**
 * 校验 UI 消息流入参形状。
 *
 * 真缺陷（补跑真机测试时发现）：此前直接解构 `{ messages }` 就用，
 * 形状不对时在 convertToModelMessages 里抛
 * "Cannot read properties of undefined (reading 'map')" 并以 **500 + 整段堆栈**返回。
 * 更糟的是 `messages: 'nope'` 这种非数组值会让 `[...'nope']` 静默展开成字符数组，
 * 一路走到 200 —— 不报错、也不是我们要处理的东西。
 *
 * 为什么必须是 4xx 而非 500：本仓库的 fail-closed 原则要求"拒绝要说清原因"。
 * 前端发错形状（旧客户端 / 第三方调用方 / 手工 curl）是**调用方错误**，
 * 不是服务端故障；500 会让调用方误以为是我们的问题而重试。
 *
 * 返回 null 表示通过（保持调用点扁平）。
 */
function validateMessages(input: unknown): { ok: true; messages: UIMessage[] } | { ok: false; reason: string } {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, reason: '请求体必须是 JSON 对象' };
  }
  const { messages } = input as { messages?: unknown };
  if (!Array.isArray(messages)) {
    return { ok: false, reason: '字段 messages 必须是数组' };
  }
  if (messages.length === 0) {
    return { ok: false, reason: 'messages 不能为空' };
  }
  for (const [i, m] of messages.entries()) {
    if (typeof m !== 'object' || m === null) {
      return { ok: false, reason: `messages[${i}] 必须是对象` };
    }
    const msg = m as { role?: unknown; parts?: unknown };
    if (msg.role !== 'user' && msg.role !== 'assistant' && msg.role !== 'system') {
      return { ok: false, reason: `messages[${i}].role 必须是 user/assistant/system` };
    }
    if (!Array.isArray(msg.parts)) {
      // 旧格式（content 字符串）也在此拦下：要么升级客户端，要么在服务端适配，
      // 但绝不能靠"碰巧不崩"来兼容。
      return { ok: false, reason: `messages[${i}].parts 必须是数组（UI 消息流协议）` };
    }
  }
  if (!messages.some((m) => (m as { role?: unknown }).role === 'user')) {
    return { ok: false, reason: 'messages 中至少需要一条 user 消息' };
  }
  return { ok: true, messages: messages as UIMessage[] };
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: '请求体不是合法 JSON' }, { status: 400 });
  }

  const v = validateMessages(body);
  if (!v.ok) {
    // 回显原因（调用方需要知道自己错在哪），但不回显任何内部堆栈
    return Response.json({ error: v.reason }, { status: 400 });
  }
  const { messages } = v;

  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const userText =
    lastUser?.parts
      ?.filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join(' ') ?? '';

  // 合规拦截（关键词层 + 意图层），必须以 UI 消息流协议返回（ADR-0002 决策 6）
  const verdict = await detectTradeSeeking(userText, {
    llmJudge: (t) => classifyIntent(t, modelAsIntentModel(deepseek(MODEL_ID))),
  });
  if (verdict.blocked) {
    // 三种情形文案不同：fail_closed 必须说明“服务不可用”，不得谎称用户索取买卖建议
    const layer = verdict.layer === 'fail_closed' ? 'fail_closed' : verdict.layer ?? 'keyword';
    const notice = complianceNotice(layer === 'fail_closed' ? 'fail_closed' : 'keyword');
    const stream = createUIMessageStream({
      execute: ({ writer }) => {
        // 与主分析分支保持同一不变量：**start 必须第一个写**
        // （真缺陷 #24：data-* 写在 start 之前会让客户端开出两条 assistant 消息）。
        // 此分支原先没有 start（靠 data-compliance 隐式开消息）—— 实测能渲染，
        // 但"能跑"来自一个未被断言的巧合，一旦后续改动引入 start 就会重复渲染。
        writer.write({ type: 'start' });
        // 机器可读信号：合规测试集与 T4 前端据此区分"真拦截"与"服务降级兜底"，
        // 不靠嗅探文案字符串（改文案会静默失效 —— code-review Spec 轴发现）。
        writer.write({ type: 'data-compliance', id: PART.compliance, data: { layer } });
        const id = 'compliance-notice';
        writer.write({ type: 'text-start', id });
        writer.write({ type: 'text-delta', id, delta: notice });
        writer.write({ type: 'text-end', id });
      },
    });
    return createUIMessageStreamResponse({ stream });
  }

  // 命题重构 + 子问题拆解 + 追问（T3）：失败一律回退确定性兜底，不暴露给用户
  // 多轮上下文（T5）：只带上一轮的「标的 + 已确认事实」结构化摘要，不带完整对话历史。
  // 从历史 data part 反推，故客户端无需额外配合（spec 交互决策）。先算摘要，
  // 因为计划阶段也要用它消解指代型追问（否则标签会丢掉标的）。
  const priorSummary = buildContextSummary(messages);
  const { plan, fromModel } = await planAnalysis(userText, priorSummary?.toPromptText());
  const subject = subjectFromTags(plan.intentTags);

  // 引用号分配器：单调递增，与登记解耦（修复并发下 refId 重复的缺陷）
  const refs = createRefAllocator<unknown>();

  // 契约校验所需的上下文：降级项与真空期子问题必须被正文声明
  const fallbackRefs: Array<{ refId: string; asOf: number; note?: string }> = [];
  const vacuumSubQuestions: Array<{ question: string; keyword?: string }> = [];

  const result = streamText({
    model: deepseek(MODEL_ID),
    system: buildSystemPrompt(plan, priorSummary?.toPromptText()),
    // spec 交互决策：只带**结构化结论摘要**（已注入 system），
    // 不把完整对话历史送进模型 —— 否则爆 token 且噪音污染，
    // 模型也会绕过摘要直接复述旧正文。
    messages: await convertToModelMessages(selectCurrentTurn(messages) as UIMessage[]),
    stopWhen: stepCountIs(5),
    tools: {
      lookupStockSnapshot: tool({
        description:
          '查询 A 股标的的实时行情快照与估值（最新价、涨跌幅、成交额、PE、PB）。当用户询问股价、涨跌、估值时使用。',
        inputSchema: z.object({
          query: z.string().describe('标的名称或代码，如 "中际旭创" 或 "300308"'),
        }),
        execute: async ({ query }) => {
          const resolved = await resolveTicker(query);
          if (!resolved.ok) {
            return {
              ok: false,
              reason: resolved.reason,
              message:
                resolved.reason === 'not_found'
                  ? `未能识别标的「${query}」。请确认名称或代码。`
                  : `数据源暂时不可用：${resolved.message}`,
            };
          }
          const refId = refs.next();
          try {
            const payload = await lookupStockSnapshot(resolved.thscode, refId);
            refs.register(refId, payload);
            if (payload.isFallback) {
              fallbackRefs.push({ refId, asOf: payload.asOf, note: payload.fallbackNote });
            }
            return {
              ok: true,
              refId,
              thscode: resolved.thscode,
              name: resolved.name,
              formatted: formatSnapshotForLLM(payload),
            };
          } catch (e) {
            return { ok: false, reason: 'upstream_error', message: `行情获取失败：${(e as Error).message}` };
          }
        },
      }),

      lookupFinancialReport: tool({
        description:
          '查询 A 股标的的财务参数：TTM 年化营收、净利率、毛利率。用于测算营收下滑对净利润的冲击。',
        inputSchema: z.object({
          query: z.string().describe('标的名称或代码'),
        }),
        execute: async ({ query }) => {
          const resolved = await resolveTicker(query);
          if (!resolved.ok) {
            return { ok: false, reason: resolved.reason, message: `未能识别标的「${query}」。` };
          }
          const refId = refs.next();
          try {
            const payload = await lookupFinancialReport(resolved.thscode, refId);
            refs.register(refId, payload);
            return {
              ok: true,
              refId,
              thscode: resolved.thscode,
              name: resolved.name,
              formatted: formatFinancialsForLLM(payload),
              sensitivityParams: {
                baseRevenue: payload.baseRevenue,
                revenueBasis: payload.revenueBasis,
                netMargin: payload.netMargin,
                grossMargin: payload.grossMargin,
                taxRate: payload.taxRate,
              },
            };
          } catch (e) {
            return { ok: false, reason: 'upstream_error', message: `财务数据获取失败：${(e as Error).message}` };
          }
        },
      }),

      searchAnnouncementsAndNews: tool({
        description:
          '检索 A 股上市公司的法定公告与财经新闻（语义检索片段）。当用户询问传闻、订单、客户、官方披露时使用。',
        inputSchema: z.object({
          query: z.string().describe('标的名称或代码'),
          keyword: z.string().describe('检索关键词，如 "客户 订单" 或 "固态电池"'),
        }),
        execute: async ({ query, keyword }) => {
          const resolved = await resolveTicker(query);
          if (!resolved.ok) {
            return { ok: false, reason: resolved.reason, message: `未能识别标的「${query}」。` };
          }
          const refId = refs.next();
          const payload = await searchAnnouncementsAndNews(resolved.name, keyword, refId);
          refs.register(refId, payload);
          if (payload.vacuum) {
            // 真空期硬编码（ADR-0001 决策 2）：记录到契约上下文，成稿后校验是否被点名
            const sq = plan.subQuestions.find((s) => s.verificator === 'announcements');
            vacuumSubQuestions.push({
              question: sq?.question ?? `「${keyword}」是否有官方披露？`,
              keyword,
            });
            return {
              ok: true,
              refId,
              vacuum: true,
              message:
                '公告检索未返回结果，该问题处于信息真空期，请将此事项明确归入【无法验证项】，不得推测。',
            };
          }
          const formatted = payload.items
            .map((it) => `[${it.date}] ${it.title}\n${it.snippet}`)
            .join('\n\n');
          return { ok: true, refId, vacuum: false, count: payload.items.length, formatted };
        },
      }),
    },
  });


  // ---------- 组装 UI 消息流（T3 契约） ----------
  //
  // 单条流里按序写入：**start** → 编排步骤 → 计划 → 引用集合 → 正文 → 契约校验 → 追问。
  // 全部数据 part 都挂在同一条 assistant 消息上，前端只解析一次消息即可渲染
  // 时间轴、三栏、存证抽屉与追问按钮（T4）。
  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      // 0) **必须先写 start**。真缺陷（用户报告"对话出现两次"数次，我此前误判为
      //    连点与输入法）：
      //    原先顺序是 data-steps → data-plan → start（start 由下面 merge 的
      //    sendStart:true 带出）。此时 AI SDK 的客户端消息归集会**先**因为
      //    data-* 而开一条 assistant 消息，随后 start 又开**第二条** ——
      //    结果一次提问渲染出两个回答区块（第二条再把 data 追加一次）。
      //    实测：单次 HTTP 请求 → 客户端 2 条 assistant 消息 → 页面重复。
      //    最小复现：`data-steps + data-plan + start` ⇒ 2 条消息；
      //              把 start 提到最前 ⇒ 1 条消息。
      //    这不是连点、也不是输入法 —— 是**流内事件顺序**错了，与模型无关，
      //    因此每次请求都必然复现（此前"偶发"的观感来自流式过程中两块的可见时点差异）。
      writer.write({ type: 'start' });

      // 1) 我们自己的编排步骤（确定性中文，不依赖模型原始推理 —— 见 handoff 第 6 条）
      writer.write({
        type: 'data-steps',
        id: PART.steps,
        data: {
          steps: buildOrchestrationSteps(plan, fromModel),
        },
      });

      // 2) 已确认的分析计划：命题 + 意图标签 + 子问题（供 T4 标签微调、T5 重跑）
      writer.write({ type: 'data-plan', id: PART.plan, data: { ...plan, fromModel } });

      // 3) 把主循环的输出并入同一条流。
      //    sendStart 必须为 false：start 已由第 0 步显式写出，再发一次会**再开一条消息**
      //    （正是本次缺陷的成因）。
      writer.merge(result.toUIMessageStream({ sendStart: false, sendFinish: false }));

      // 4) 流结束后做契约校验（writer.write 在流关闭后不生效，必须先校验再写）
      await result.consumeStream();

      const refList = refs.list();
      const text = await result.text;

      // 引用集合：前端据此把编造角标渲染为灰色"引用失效"（ADR-0002 决策 2）
      writer.write({
        type: 'data-refs',
        id: PART.refs,
        data: {
          refs: refList.map((r) => ({
            refId: r.refId,
            kind: refKind(r.payload),
            payload: r.payload,
          })),
        },
      });

      // 契约校验：违规清单交给前端（T4 角标校验/降级角标）与审计
      const check = validateAnalysisOutput(text, {
        refIds: refList.map((r) => r.refId),
        fallbackRefs,
        vacuumSubQuestions,
      });
      writer.write({
        type: 'data-contract',
        id: PART.contract,
        data: {
          ok: check.ok,
          violations: check.violations,
          citations: checkCitations(text, refList.map((r) => r.refId)),
        },
      });

      // 追问：**在本轮末尾**基于本轮已核验的正文生成（ADR-0002 补充决策 5），
      // 再经确定性核验向过滤与补齐（恒 3 条）。
      const finalFollowUps = await generateFollowUps(plan, text, subject);
      writer.write({
        type: 'data-followups',
        id: PART.followups,
        data: { questions: finalFollowUps },
      });
    },
  });

  return createUIMessageStreamResponse({ stream });
}
