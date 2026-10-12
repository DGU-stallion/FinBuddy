/**
 * Seam 1: 标的解析（把自然语言标的解析为规范 thscode）
 *
 * 设计要点（见 ADR-0001 补充决策 5）：
 * - 全 A 股范围，靠扶摇标的检索解析，不硬编码白名单。
 * - 解析失败必须返回结构化"未识别"，绝不猜一个代码（诚实优于硬撑）。
 * - 上游报错与"零命中"是两种不同结果，不可混淆（题目红线：数据缺失不得静默生成正常结论）。
 */

const FUYAO_BASE = 'https://fuyao.aicubes.cn';

/** A 股交易所后缀推断：6/9 开头为上交所，0/3 开头为深交所，其余不收口。 */
const SH_PREFIXES = ['6', '9'];
const SZ_PREFIXES = ['0', '3'];

export function normalizeTickerQuery(raw: string): string {
  const q = raw.trim();
  // 已是 thscode（含 .XX 后缀）：规范后缀为大写
  if (/^\d{6}\.[A-Za-z]{2}$/.test(q)) {
    return q.slice(0, 7) + q.slice(7).toUpperCase();
  }
  // 纯 6 位代码：按前缀推断交易所后缀
  if (/^\d{6}$/.test(q)) {
    const head = q[0];
    if (SH_PREFIXES.includes(head)) return `${q}.SH`;
    if (SZ_PREFIXES.includes(head)) return `${q}.SZ`;
  }
  // 中文名 / 代码片段 / 其他：交给检索接口消歧
  return q;
}

export interface TickerCandidate {
  thscode: string;
  ticker: string;
  name: string;
  asset_type: string;
}

export type TickerResolution =
  | { ok: true; thscode: string; name: string; candidates: TickerCandidate[] }
  | { ok: false; reason: 'not_found' | 'upstream_error'; message: string };

interface ResolveOptions {
  fetchFn?: typeof fetch;
  apiKey?: string;
}

export async function resolveTicker(
  query: string,
  options: ResolveOptions = {},
): Promise<TickerResolution> {
  const fetchFn = options.fetchFn ?? fetch;
  const apiKey = options.apiKey ?? process.env.FUYAO_API_KEY ?? '';
  const q = normalizeTickerQuery(query);

  const url = `${FUYAO_BASE}/api/meta/tickers/search?q=${encodeURIComponent(q)}&asset_type=a-share&limit=10`;

  let res: Response;
  try {
    res = await fetchFn(url, { headers: { 'X-api-key': apiKey } });
  } catch (e) {
    return {
      ok: false,
      reason: 'upstream_error',
      message: `标的检索请求失败：${(e as Error).message}`,
    };
  }

  if (!res.ok) {
    return {
      ok: false,
      reason: 'upstream_error',
      message: `标的检索接口返回 ${res.status}`,
    };
  }

  const body = (await res.json()) as {
    code?: number;
    message?: string;
    data?: { item?: TickerCandidate[] };
  };

  // 统一信封：非 0 code 视为上游错误，不能当作"未找到"
  if (body.code !== 0) {
    return {
      ok: false,
      reason: 'upstream_error',
      message: `标的检索接口错误 code=${body.code} ${body.message ?? ''}`,
    };
  }

  const items = body.data?.item ?? [];
  if (items.length === 0) {
    return { ok: false, reason: 'not_found', message: `未识别标的：${query}` };
  }

  const first = items[0];
  return { ok: true, thscode: first.thscode, name: first.name, candidates: items };
}
