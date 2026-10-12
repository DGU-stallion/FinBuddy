/**
 * 扶摇 MCP 客户端（单一来源，避免域名在多处重复硬编码）
 *
 * 真实契约（真机验证 2026-10-12）：
 * - 端点 https://fuyao.aicubes.cn/mcp/a-share，认证 X-api-key，JSON-RPC 2.0
 * - 统一信封 { code, message, request_id, data }，HTTP 恒为 200，靠 code 分发
 * - code=4001 表示限流
 */

export const FUYAO_MCP_URL = 'https://fuyao.aicubes.cn/mcp/a-share';
export const FUYAO_REST_BASE = 'https://fuyao.aicubes.cn';

interface McpEnvelope {
  result?: { content?: Array<{ text?: string }>; structuredContent?: unknown };
  error?: { message: string; code: number };
}

/** 业务错误：上游返回了错误码，调用方可据此决定降级。 */
export class FuyaoError extends Error {
  constructor(
    message: string,
    readonly kind: 'http' | 'business' | 'shape' | 'timeout',
    readonly code?: number,
  ) {
    super(message);
    this.name = 'FuyaoError';
  }
}

/**
 * 调用扶摇 MCP 工具，返回信封里的 data。
 * 任何失败都抛出带 kind 的 FuyaoError，绝不静默返回空壳（ADR-0001 决策 2）。
 */
export async function callFuyaoTool<T>(
  toolName: string,
  args: Record<string, unknown>,
  timeoutMs = 8000,
): Promise<T> {
  const apiKey = process.env.FUYAO_API_KEY ?? '';

  let res: Response;
  try {
    res = await fetch(FUYAO_MCP_URL, {
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
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const err = e as Error;
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new FuyaoError(`扶摇工具 ${toolName} 超时（>${timeoutMs}ms）`, 'timeout');
    }
    throw new FuyaoError(`扶摇工具 ${toolName} 请求失败：${err.message}`, 'http');
  }

  if (res.status === 429) {
    throw new FuyaoError('扶摇接口触发限流（HTTP 429）', 'business', 4001);
  }
  if (!res.ok) throw new FuyaoError(`扶摇 MCP 返回 HTTP ${res.status}`, 'http', res.status);

  const env = (await res.json()) as McpEnvelope;
  if (env.error) {
    throw new FuyaoError(`扶摇工具错误：${env.error.message}`, 'business', env.error.code);
  }

  const structured = env.result?.structuredContent as
    | { data?: unknown; code?: number; message?: string }
    | undefined;
  if (structured && typeof structured === 'object' && 'data' in structured) {
    if (typeof structured.code === 'number' && structured.code !== 0) {
      throw new FuyaoError(
        `扶摇业务错误 code=${structured.code} ${structured.message ?? ''}`,
        'business',
        structured.code,
      );
    }
    return structured.data as T;
  }

  const text = env.result?.content?.[0]?.text;
  if (typeof text === 'string' && text.trim()) {
    const parsed = JSON.parse(text) as { code?: number; message?: string; data?: unknown };
    if (typeof parsed.code === 'number' && parsed.code !== 0) {
      throw new FuyaoError(
        `扶摇业务错误 code=${parsed.code} ${parsed.message ?? ''}`,
        'business',
        parsed.code,
      );
    }
    return (parsed.data ?? parsed) as T;
  }

  throw new FuyaoError(`扶摇工具 ${toolName} 返回结构无法识别`, 'shape');
}
