import { NextRequest } from 'next/server';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {
  streamText,
  tool,
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
import { detectTradeSeeking } from '@/lib/compliance';
import { classifyIntent, modelAsIntentModel } from '@/lib/intent';
import { createRefAllocator } from '@/lib/refs';

export const maxDuration = 60;

const deepseek = createOpenAICompatible({
  name: 'deepseek',
  baseURL: (process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com') + '/v1',
  apiKey: process.env.DEEPSEEK_API_KEY ?? '',
});

const SYSTEM_PROMPT = `你是 FinBuddy，一名中立、严谨的投资命题核验助手。

你的职责边界（不可逾越）：
1. 绝不提供投资建议、买卖指令或收益承诺。用户索取买卖决策时，柔性引导至基本面核验。
2. 绝不编造数据。所有事实必须来自工具返回，并标注引用号。
3. 严格区分事实与推断。工具没返回的，不要脑补。
4. 公告检索返回 vacuum=true 时，表示该问题处于信息真空期，必须明确归入【无法验证项】，不得脑补。

输出要求：
- 引用工具返回的数据时，必须标注该数据的引用号，格式为 [^ref_X]（X 为工具结果中的引用号）。
- 只允许引用本轮工具真正返回过的引用号，不得自行编造。
- 推理过程与最终回答一律使用中文。
- 若工具未覆盖用户所问的维度，必须明确声明「本轮工具不含该数据」，不得推测、不得用相近字段替代。
- 回答简洁、高信息密度。`;

export async function POST(req: NextRequest) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const userText =
    lastUser?.parts
      ?.filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join(' ') ?? '';

  // 合规拦截（关键词层 + 意图层），必须以 UI 消息流协议返回（ADR-0002 决策 6）
  const verdict = await detectTradeSeeking(userText, {
    llmJudge: (t) => classifyIntent(t, modelAsIntentModel(deepseek('deepseek-flash'))),
  });
  if (verdict.blocked) {
    const blockMessage = `FinBuddy 是中立投研工具，不提供任何投资建议、买卖指令或收益承诺。投资有风险，决策需独立。

不过，我可以和您一起核验该标的的基本面与关键传闻。您可以这样问我：
- 「中际旭创的营收与毛利率近期表现如何？」
- 「市场上有哪些关于它的传闻，官方披露了什么？」`;

    const stream = createUIMessageStream({
      execute: ({ writer }) => {
        const id = 'compliance-notice';
        writer.write({ type: 'text-start', id });
        writer.write({ type: 'text-delta', id, delta: blockMessage });
        writer.write({ type: 'text-end', id });
      },
    });
    return createUIMessageStreamResponse({ stream });
  }

  // 引用号分配器：单调递增，与登记解耦（修复并发下 refId 重复的缺陷）
  const refs = createRefAllocator<unknown>();

  const result = streamText({
    model: deepseek('deepseek-flash'),
    system: SYSTEM_PROMPT,
    messages: await convertToModelMessages(messages),
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

  return result.toUIMessageStreamResponse();
}
