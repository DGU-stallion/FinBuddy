import { NextRequest } from 'next/server';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { streamText, tool, stepCountIs, convertToModelMessages, type UIMessage } from 'ai';
import { z } from 'zod';
import { resolveTicker } from '@/lib/ticker';
import { fetchSnapshotL1 } from '@/lib/gateway';
import { formatSnapshotForLLM } from '@/lib/format';
import { detectTradeSeeking } from '@/lib/compliance';

export const maxDuration = 60;

const deepseek = createOpenAICompatible({
  name: 'deepseek',
  baseURL: (process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com') + '/v1',
  apiKey: process.env.DEEPSEEK_API_KEY ?? '',
});

/** 本轮工具实际返回过的 refId 集合，供前端角标强制校验（ADR-0002 决策 2）。 */
type RefRegistry = Map<string, unknown>;

const SYSTEM_PROMPT = `你是 FinBuddy，一名中立、严谨的投资命题核验助手。

你的职责边界（不可逾越）：
1. 绝不提供投资建议、买卖指令或收益承诺。用户索取买卖决策时，柔性引导至基本面核验。
2. 绝不编造数据。所有事实必须来自工具返回，并标注引用号。
3. 严格区分事实与推断。工具没返回的，不要脑补。

输出要求：
- 引用工具返回的数据时，必须标注该数据的引用号，格式为 [^ref_X]（X 为工具结果中的引用号）。
- 只允许引用本轮工具真正返回过的引用号，不得自行编造。
- 回答使用中文，简洁、高信息密度。`;

export async function POST(req: NextRequest) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const userText =
    lastUser?.parts
      ?.filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join(' ') ?? '';

  // 合规拦截（关键词层；意图层在 T3 接入 LLM 判断）
  const verdict = await detectTradeSeeking(userText);
  if (verdict.blocked) {
    return new Response(
      `FinBuddy 是中立投研工具，不提供任何投资建议、买卖指令或收益承诺。投资有风险，决策需独立。

不过，我可以和您一起核验该标的的基本面与关键传闻。您可以这样问我：
- 「中际旭创的营收与毛利率近期表现如何？」
- 「市场上有哪些关于它的传闻，官方披露了什么？」`,
      { headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
    );
  }

  const refRegistry: RefRegistry = new Map();

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
            // 诚实失败：不猜代码，明确告知未识别（ADR-0001 补充决策 5）
            return {
              ok: false,
              reason: resolved.reason,
              message:
                resolved.reason === 'not_found'
                  ? `未能识别标的「${query}」。请确认名称或代码，或提供一个流动性较好的 A 股标的。`
                  : `数据源暂时不可用：${resolved.message}`,
            };
          }
          const refId = `ref_${refRegistry.size + 1}`;
          try {
            const payload = await fetchSnapshotL1(resolved.thscode, refId);
            refRegistry.set(refId, payload);
            return {
              ok: true,
              refId,
              thscode: resolved.thscode,
              name: resolved.name,
              formatted: formatSnapshotForLLM(payload),
            };
          } catch (e) {
            return {
              ok: false,
              reason: 'upstream_error',
              message: `行情获取失败：${(e as Error).message}`,
            };
          }
        },
      }),
    },
  });

  return result.toUIMessageStreamResponse();
}
