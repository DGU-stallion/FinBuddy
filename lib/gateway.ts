/**
 * 金融数据网关（L1 实时层）
 *
 * 见 ADR-0001：三源协同 —— 扶摇（行情/财报）、iFinD（公告/新闻）。
 * T1 只实现行情快照的最小可用路径；T2 补齐财报、公告、三级降级。
 *
 * 真实契约（真机验证 2026-10-12）：
 * - 扶摇 MCP 端点 https://fuyao.aicubes.cn/mcp/a-share，认证 X-api-key，JSON-RPC
 * - 行情快照工具 get_a_share_prices_snapshot，入参 thscodes（如 300308.SZ）
 * - 估值快照工具 get_a_share_valuations_snapshot，入参 thscodes
 * - 统一信封 { code, message, request_id, data }
 */

import type { SnapshotPayload } from './format';

const FUYAO_MCP = 'https://fuyao.aicubes.cn/mcp/a-share';

interface McpEnvelope<T> {
  jsonrpc?: string;
  id?: number;
  result?: { content?: Array<{ text?: string }>; structuredContent?: unknown };
  error?: { message: string; code: number };
}

async function callFuyaoTool<T>(toolName: string, args: Record<string, unknown>): Promise<T> {
  const apiKey = process.env.FUYAO_API_KEY ?? '';
  const res = await fetch(FUYAO_MCP, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'X-api-key': apiKey,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    }),
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) throw new Error(`扶摇 MCP 返回 HTTP ${res.status}`);

  const env = (await res.json()) as McpEnvelope<T>;
  if (env.error) throw new Error(`扶摇工具错误：${env.error.message}`);

  // 工具结果可能是 structuredContent 或 content[0].text 里的 JSON 字符串
  const structured = env.result?.structuredContent;
  if (structured && typeof structured === 'object') {
    const sc = structured as { data?: unknown; code?: number; message?: string };
    if (typeof sc.code === 'number' && sc.code !== 0) {
      throw new Error(`扶摇业务错误 code=${sc.code} ${sc.message ?? ''}`);
    }
    if (sc.data !== undefined) return sc.data as T;
    return structured as T;
  }

  const text = env.result?.content?.[0]?.text;
  if (typeof text === 'string' && text.trim()) {
    const parsed = JSON.parse(text) as { code?: number; message?: string; data?: unknown };
    if (typeof parsed.code === 'number' && parsed.code !== 0) {
      throw new Error(`扶摇业务错误 code=${parsed.code} ${parsed.message ?? ''}`);
    }
    return (parsed.data ?? parsed) as T;
  }

  throw new Error('扶摇返回结构无法识别');
}

interface PricesSnapshotData {
  item?: Array<{
    thscode?: string;
    last_price?: number;
    price_change_ratio_pct?: number;
    turnover?: number;
  }>;
}

interface ValuationsData {
  item?: Array<{ thscode?: string; name?: string; pe_ttm?: number; pb_mrq?: number }>;
}

/**
 * L1 实时行情快照。任何一步失败都抛错，由上层决定降级（不静默返回空壳）。
 */
export async function fetchSnapshotL1(
  thscode: string,
  refId: string,
): Promise<SnapshotPayload> {
  const prices = await callFuyaoTool<PricesSnapshotData>('get_a_share_prices_snapshot', {
    thscodes: thscode,
  });

  // 估值与行情并行获取，各自允许失败（估值缺失不应让整条行情链路挂掉）
  let valuations: ValuationsData | null = null;
  try {
    valuations = await callFuyaoTool<ValuationsData>('get_a_share_valuations_snapshot', {
      thscodes: thscode,
    });
  } catch {
    valuations = null;
  }

  const p = prices.item?.[0];
  if (!p) throw new Error(`扶摇未返回 ${thscode} 的行情数据`);

  const v = valuations?.item?.[0];

  return {
    refId,
    source: '扶摇 · 行情/估值快照',
    asOf: Date.now(),
    isFallback: false,
    data: {
      thscode: p.thscode ?? thscode,
      name: v?.name,
      last_price: p.last_price,
      price_change_ratio_pct: p.price_change_ratio_pct,
      turnover: p.turnover,
      pe_ttm: v?.pe_ttm,
      pb_mrq: v?.pb_mrq,
    },
  };
}
