/**
 * iFinD MCP 客户端（公告 / 新闻语义检索）
 *
 * 真实契约（真机验证 2026-10-12，来自官方 SKILL 包 call-node.js）：
 * - 端点 https://api-mcp.51ifind.com:8643/ds-mcp-servers/hexin-ifind-ds-{type}-mcp
 * - 认证 Authorization: <token>（注意：无 Bearer 前缀）
 * - 需先 initialize 拿 Mcp-Session-Id，再发 notifications/initialized
 * - search_notice / search_news 必填 time_start、time_end（YYYY-MM-DD）
 * - 返回语义检索【片段】而非全文，片段中带公告标题与日期
 */

const IFIND_BASE = 'https://api-mcp.51ifind.com:8643/ds-mcp-servers';

export const IFIND_SERVERS = {
  stock: `${IFIND_BASE}/hexin-ifind-ds-stock-mcp`,
  fund: `${IFIND_BASE}/hexin-ifind-ds-fund-mcp`,
  edb: `${IFIND_BASE}/hexin-ifind-ds-edb-mcp`,
  news: `${IFIND_BASE}/hexin-ifind-ds-news-mcp`,
  bond: `${IFIND_BASE}/hexin-ifind-ds-bond-mcp`,
  global_stock: `${IFIND_BASE}/hexin-ifind-ds-global-stock-mcp`,
  index: `${IFIND_BASE}/hexin-ifind-ds-index-mcp`,
  future: `${IFIND_BASE}/hexin-ifind-ds-futures-mcp`,
} as const;

export type IfindServerType = keyof typeof IFIND_SERVERS;

export class IfindError extends Error {
  constructor(
    message: string,
    readonly kind: 'http' | 'business' | 'shape' | 'timeout' | 'auth',
    readonly code?: number,
  ) {
    super(message);
    this.name = 'IfindError';
  }
}

/** 会话缓存：iFinD 要求同一 server 复用 Mcp-Session-Id。 */
const sessions = new Map<IfindServerType, string>();
const reqIds = new Map<IfindServerType, number>();

function nextId(t: IfindServerType): number {
  const n = (reqIds.get(t) ?? 0) + 1;
  reqIds.set(t, n);
  return n;
}

function headers(t: IfindServerType): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: process.env.IFIND_MCP_KEY ?? '',
  };
  const sid = sessions.get(t);
  if (sid) h['Mcp-Session-Id'] = sid;
  return h;
}

async function post(
  t: IfindServerType,
  payload: unknown,
  timeoutMs = 15000,
): Promise<{ status: number; ok: boolean; data: unknown; sessionId: string | null }> {
  let res: Response;
  try {
    res = await fetch(IFIND_SERVERS[t], {
      method: 'POST',
      headers: headers(t),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const err = e as Error;
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new IfindError(`iFinD ${t} 请求超时`, 'timeout');
    }
    throw new IfindError(`iFinD ${t} 请求失败：${err.message}`, 'http');
  }

  if (res.status === 401 || res.status === 403) {
    throw new IfindError(`iFinD 认证失败（HTTP ${res.status}）`, 'auth', res.status);
  }

  const text = await res.text();
  let data: unknown = null;
  if (text.trim()) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  return {
    status: res.status,
    ok: res.ok,
    data,
    sessionId: res.headers.get('mcp-session-id'),
  };
}

async function init(t: IfindServerType): Promise<void> {
  if (sessions.has(t)) return;

  const r = await post(t, {
    jsonrpc: '2.0',
    id: nextId(t),
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'finbuddy', version: '1.0.0' },
    },
  });

  if (!r.sessionId) throw new IfindError(`iFinD ${t} initialize 未返回 Mcp-Session-Id`, 'shape');
  sessions.set(t, r.sessionId);

  await post(t, { jsonrpc: '2.0', method: 'notifications/initialized' });
}

/** 调用 iFinD 工具，返回 result.content[0].text 解析后的对象（或其原始文本）。 */
export async function callIfindTool<T>(
  t: IfindServerType,
  toolName: string,
  args: Record<string, unknown>,
): Promise<T> {
  await init(t);

  const r = await post(t, {
    jsonrpc: '2.0',
    id: nextId(t),
    method: 'tools/call',
    params: { name: toolName, arguments: args },
  });

  const body = r.data as
    | { error?: { message: string; code: number }; result?: { content?: Array<{ text?: string }> } }
    | null;

  if (body?.error) {
    throw new IfindError(`iFinD 工具错误：${body.error.message}`, 'business', body.error.code);
  }
  if (!r.ok) throw new IfindError(`iFinD ${t} 返回 HTTP ${r.status}`, 'http', r.status);

  const text = body?.result?.content?.[0]?.text;
  if (typeof text !== 'string') {
    throw new IfindError(`iFinD ${toolName} 返回结构无法识别`, 'shape');
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new IfindError(`iFinD ${toolName} 返回非 JSON`, 'shape');
  }
}
