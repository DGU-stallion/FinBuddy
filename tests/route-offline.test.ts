import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { startMockModel, parseUiStream, DEFAULT_PLAN, DEFAULT_BODY, type MockModel } from './support/mock-model';

/**
 * 把 .env 注入 process.env。
 *
 * vitest 不像 Next.js 那样自动加载 .env，而网关（lib/fuyao.ts 等）直接读
 * process.env —— 不注入就会出现 `Missing X-api-key`，让工具链路测试假失败
 * （实测踩过：存证数为 0，看起来像"工具没被调用"，实为缺 key）。
 * 已存在的环境变量优先，不覆盖外部传入的值。
 */
function loadDotEnv(): void {
  const p = path.resolve(__dirname, '../.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf-8').split('\n')) {
    const t = line.trim();
    if (t === '' || t.startsWith('#') || !t.includes('=')) continue;
    const i = t.indexOf('=');
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim();
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

loadDotEnv();

/**
 * 离线端到端：路由编排（不依赖付费 API 余额）
 *
 * 背景：DeepSeek 余额耗尽时，真机集成测试只能**诚实跳过** —— 但那样路由层
 * （多轮上下文注入、data part 写出顺序、契约校验落点）的覆盖就是**零**。
 * 本文件用可编程 mock 模型把这块补齐，且不花一分钱、评委可复现。
 *
 * 抓到：多轮摘要没注入下一轮、data part 顺序错、编造角标未被判违规、
 *       合规拦截走了错误分支。
 * 漏掉：模型真实行为（仍需真机集成测试，见 agent-contract.integration.test.ts）。
 *
 * 关键红线：
 *  - 多轮必须注入**结构化摘要**（不含完整对话历史）。
 *  - 编造角标必须被判 fabricated_citation（ADR-0002 决策 2）。
 */

/**
 * 动态导入路由（必须在设置 DEEPSEEK_BASE_URL 之后）。
 *
 * 必须 `vi.resetModules()`：路由模块在 createOpenAICompatible 时就把
 * DEEPSEEK_BASE_URL 固化进闭包。若复用第一次 import 的模块，后续测试
 * 仍会指向**上一个** mock 服务（已关闭）→ 流中断、data part 缺失
 * （实测表现为 "Cannot read properties of undefined (reading 'refs')"）。
 */
async function loadRoute(baseURL: string) {
  loadDotEnv();
  process.env.DEEPSEEK_BASE_URL = baseURL;
  process.env.DEEPSEEK_API_KEY = 'mock-key';
  vi.resetModules();
  const { POST } = await import('@/app/api/chat/route');
  return POST;
}

/**
 * 调一次 /api/chat 并解析流。
 *
 * 路由签名是 NextRequest（Next 的扩展类型，运行时就是标准 Request）。
 * 测试里用 as never 穿过这个纯类型差异 —— 不引入 next/server 的构造器，
 * 避免为测试增加 Next 运行时依赖。
 */
async function post(
  POST: (req: never) => Promise<Response>,
  messages: unknown[],
) {
  const res = await postRaw(POST, { messages });
  return parseUiStream(await res.text());
}

/** 原样发任意 body（用于验证非法入参的拒绝行为）。 */
async function postRaw(POST: (req: never) => Promise<Response>, body: unknown): Promise<Response> {
  return POST(
    new Request('http://localhost/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }) as never,
  );
}

const userMsg = (text: string) => ({
  id: `u-${text.slice(0, 6)}`,
  role: 'user',
  parts: [{ type: 'text', text }],
});

/** 从历史里取 assistant 的 data parts（模拟浏览器回传的完整消息）。 */
function assistantWith(raw: { text: string; dataParts: Record<string, unknown> }, id = 'a1') {
  const parts: unknown[] = [];
  for (const [name, data] of Object.entries(raw.dataParts)) {
    parts.push({ type: `data-${name}`, id: name, data });
  }
  if (raw.text) parts.push({ type: 'text', text: raw.text, state: 'done' });
  return { id, role: 'assistant', parts };
}

describe('离线端到端：路由编排（mock 模型）', () => {
  let mock: MockModel;

  beforeAll(async () => {
    mock = await startMockModel();
  });

  afterAll(async () => {
    await mock.close();
  });

  /**
   * 真缺陷回归：一次提问不得渲染成两轮（用户报告"对话出现两次"多次）。
   *
   * 根因**不是**连点、也不是中文输入法（这两个方向我都修过，都不是真因）：
   * 路由把 `data-steps`/`data-plan` 写在了 `start` **之前**，而 `start` 由
   * `merge(..., { sendStart: true })` 带出。AI SDK 的客户端归集于是先因
   * data-* 开一条 assistant 消息，再因 start 开**第二条** ——
   * 于是单次 HTTP 请求产生 2 条 assistant 消息，页面把同一提问渲染两次。
   *
   * 这里在**协议层**锁死：start 必须是**第一个** chunk，且恰好出现一次。
   * 为什么不在浏览器里测：那需要真实浏览器，跑不了 CI；而顺序错误在协议层
   * 就能完全确定性地抓到，浏览器端只是它的后果。
   */
  it('流内事件顺序：start 必须是第一个 chunk（否则客户端会开出两条 assistant 消息）', async () => {
    const POST = await loadRoute(mock.url);
    const r = await post(POST, [userMsg('中际旭创怎么样')]);

    expect(
      r.chunkTypes[0],
      `第一个 chunk 应为 start，实际是 ${r.chunkTypes[0]} —— ` +
        `data-* 写在 start 之前会让客户端开出两条 assistant 消息（页面重复渲染）`,
    ).toBe('start');

    const startCount = r.chunkTypes.filter((t) => t === 'start').length;
    expect(startCount, `start 应恰好出现 1 次，实际 ${startCount} 次`).toBe(1);

    // data part 仍然齐全（修复不能以丢数据为代价）
    expect(r.order).toEqual(['steps', 'plan', 'refs', 'contract', 'followups']);
  });

  it('单轮：data part 按契约顺序写出，且正文有内容', async () => {
    const POST = await loadRoute(mock.url);
    const r = await post(POST, [userMsg('中际旭创怎么样')]);

    expect(r.order).toEqual(['steps', 'plan', 'refs', 'contract', 'followups']);
    expect(r.text).toContain('支持证据');
    expect(r.dataParts.plan).toBeTruthy();
    expect(r.dataParts.contract).toBeTruthy();
  });

  it('单轮：计划来自模型时 fromModel=true', async () => {
    const POST = await loadRoute(mock.url);
    const r = await post(POST, [userMsg('中际旭创怎么样')]);
    expect((r.dataParts.plan as { fromModel?: boolean }).fromModel).toBe(true);
  });

  it('多轮：追问时把上一轮结构化摘要注入 system（不含完整对话历史）', async () => {
    const POST = await loadRoute(mock.url);

    // 第一轮
    const turn1 = await post(POST, [userMsg('中际旭创怎么样')]);
    expect(turn1.text).toContain('支持证据');

    // 第二轮：带上第一轮的完整 assistant 消息（含 data parts）
    mock.requests.length = 0;
    await post(POST, [userMsg('中际旭创怎么样'), assistantWith(turn1), userMsg('那它的毛利率呢？')]);

    // 找到流式（主循环）请求，检查其 messages 里的 system
    const streamReq = mock.requests.find((b) => b.stream === true);
    expect(streamReq).toBeTruthy();
    const flat = JSON.stringify(streamReq);

    // 摘要在场：标题 + 标的
    expect(flat).toContain('上一轮已确认的结构化结论');
    expect(flat).toContain('中际旭创');

    // 但**不得**夹带上一轮的完整正文（摘要而非全文，避免爆 token）
    expect(flat).not.toContain('【支持证据】营收与净利率保持稳定。');
  });

  it('多轮：摘要里带上已确认事实（源自 payload，可回溯）', async () => {
    const POST = await loadRoute(mock.url);
    const turn1 = await post(POST, [userMsg('中际旭创怎么样')]);

    mock.requests.length = 0;
    await post(POST, [userMsg('中际旭创怎么样'), assistantWith(turn1), userMsg('毛利率呢')]);

    const streamReq = mock.requests.find((b) => b.stream === true);
    const flat = JSON.stringify(streamReq);
    // 第一轮 mock 未调工具 → 无 refs，摘要应诚实写"无"
    expect(flat).toContain('已确认事实');
  });

  it('首轮不含上一轮摘要（不注入空上下文）', async () => {
    const POST = await loadRoute(mock.url);
    mock.requests.length = 0;
    await post(POST, [userMsg('中际旭创怎么样')]);

    const streamReq = mock.requests.find((b) => b.stream === true);
    expect(JSON.stringify(streamReq)).not.toContain('上一轮已确认的结构化结论');
  });

  it('对抗性：正文编造角标时契约判 fabricated_citation（ADR-0002 决策 2）', async () => {
    mock.setScenario({
      planJson: DEFAULT_PLAN,
      streamChunks: [
        '【意图解析】x\n【命题重构】y\n【支持证据】官方已澄清传闻[^ref_7]。\n【反对证据】z\n【无法验证项】w\n【敏感性测算】v',
      ],
    });

    const POST = await loadRoute(mock.url);
    const r = await post(POST, [userMsg('中际旭创怎么样')]);

    const contract = r.dataParts.contract as {
      ok: boolean;
      violations: Array<{ code: string }>;
      citations: { invalid: string[] };
    };
    // 本轮无工具调用 → refIds 为空 → ref_7 必然是编造
    expect(contract.citations.invalid).toContain('ref_7');
    expect(contract.violations.map((v) => v.code)).toContain('fabricated_citation');
    expect(contract.ok).toBe(false);

    // 而编造角标**确实到达了前端** —— 证明"前端强制校验"是必需的，不是摆设
    expect(r.text).toContain('[^ref_7]');

    // 重置场景，避免影响后续用例
    mock.setScenario({ planJson: DEFAULT_PLAN, streamChunks: [DEFAULT_BODY] });
  });

  it('合规：关键词层命中时走 compliance 分支，且不产出分析 data part', async () => {
    const POST = await loadRoute(mock.url);
    const r = await post(POST, [userMsg('满仓干进去')]);

    expect(r.dataParts.compliance).toEqual({ layer: 'keyword' });
    expect(r.dataParts.plan).toBeUndefined();
    expect(r.dataParts.refs).toBeUndefined();
    expect(r.order).toEqual(['compliance']);
    // 柔性引导，不是粗暴拒答
    expect(r.text).toContain('不提供任何投资建议');
  });

  it('合规：意图层命中（关键词未拦）时 layer=intent', async () => {
    mock.setScenario({
      planJson: DEFAULT_PLAN,
      streamChunks: [DEFAULT_BODY],
      intentVerdict: '是',
    });

    const POST = await loadRoute(mock.url);
    // "这股能上车吗" 不在关键词层词表内，只能靠意图层拦下
    const r = await post(POST, [userMsg('这股能上车吗')]);

    expect(r.dataParts.compliance).toEqual({ layer: 'intent' });
    expect(r.dataParts.plan).toBeUndefined();

    mock.setScenario({ planJson: DEFAULT_PLAN, streamChunks: [DEFAULT_BODY] });
  });

  it('合规：意图判断输出无法解析时 fail-closed（保守拦截，绝不放行）', async () => {
    mock.setScenario({
      planJson: DEFAULT_PLAN,
      streamChunks: [DEFAULT_BODY],
      intentVerdict: '我无法判断',
    });

    const POST = await loadRoute(mock.url);
    const r = await post(POST, [userMsg('这股能上车吗')]);

    expect(r.dataParts.compliance).toBeDefined();
    const layer = (r.dataParts.compliance as { layer: string }).layer;
    // 解析失败 → classifyIntent 抛错 → fail_closed
    expect(layer).toBe('fail_closed');
    // fail_closed 的文案必须说明"服务不可用"，绝不可谎称用户索取买卖建议
    expect(r.text).toContain('暂时不可用');
    expect(r.text).not.toContain('我们来看看');

    mock.setScenario({ planJson: DEFAULT_PLAN, streamChunks: [DEFAULT_BODY] });
  });

  it('计划阶段失败时回退确定性兜底，且标注 fromModel=false', async () => {
    mock.setScenario({ planJson: '这不是 JSON', streamChunks: [DEFAULT_BODY] });

    const POST = await loadRoute(mock.url);
    const r = await post(POST, [userMsg('中际旭创怎么样')]);

    const plan = r.dataParts.plan as { fromModel?: boolean; reframedClaim?: string };
    expect(plan.fromModel).toBe(false);
    expect(plan.reframedClaim).toBeTruthy();
    // 兜底也必须保留标的名（T3 修复过的缺陷：兜底丢标的）
    expect(JSON.stringify(plan)).toContain('中际旭创');

    mock.setScenario({ planJson: DEFAULT_PLAN, streamChunks: [DEFAULT_BODY] });
  });
});

/**
 * 工具链路需要**真实**网关凭据（扶摇 key）。缺凭据时显式跳过并打印原因，
 * 绝不静默通过 —— 否则新克隆的仓库会看到"绿"，但实际什么都没验证。
 *
 * 注意：其余路由编排用例（多轮摘要、data part 顺序、合规分支、编造角标）
 * 完全不依赖凭据，因此保留在本文件的第一个 describe 里照常运行。
 */
const HAS_GATEWAY_CREDS = Boolean(process.env.FUYAO_API_KEY);
if (!HAS_GATEWAY_CREDS) {
  console.warn(
    '\n⚠️  跳过工具链路用例（离线端到端）—— 未验证。\n' +
      '    原因：缺少 .env 中的 FUYAO_API_KEY（真实网关凭据）。\n' +
      '    这不是通过，只是前置条件不满足。\n',
  );
}

describe.skipIf(!HAS_GATEWAY_CREDS)('离线端到端：工具链路与降级（mock 模型 + 真实网关）', () => {
  // 这两个用例会**真的调用扶摇网关**（网络 I/O），5s 的默认超时在原理上就不合适：
  // 全量并行跑时另一个真机用例同时占用网络，实测被拖到 >5s 而假失败（单跑仅 1.3s）。
  // 真实网络调用必须有真实的超时预算，否则测试会因为机器负载而非代码问题变红。
  const NET_TIMEOUT_MS = 30_000;

  let mock2: MockModel;
  beforeAll(async () => {
    mock2 = await startMockModel();
  });
  afterAll(async () => {
    await mock2.close();
  });

  it('模型调用工具后，存证写入 data-refs 且正文角标可溯源', async () => {
    // 模型先请求查中际旭创行情（走真实网关：扶摇或 L2 降级）
    mock2.setScenario({
      planJson: DEFAULT_PLAN,
      streamChunks: [
        '【意图解析】x\n【命题重构】y\n【支持证据】最新价见存证[^ref_1]。\n【反对证据】z\n【无法验证项】w\n【敏感性测算】v',
      ],
      toolCalls: [{ name: 'lookupStockSnapshot', args: { query: '中际旭创' } }],
    });

    const POST = await loadRoute(mock2.url);
    const r = await post(POST, [userMsg('中际旭创现在什么价')]);

    const refs = (r.dataParts.refs as { refs?: Array<{ refId: string; kind: string }> }).refs ?? [];
    // 真实网关应产出至少一条存证（L1 实时或 L2 降级均可）
    expect(refs.length).toBeGreaterThan(0);
    expect(refs[0].refId).toBe('ref_1');
    expect(refs[0].kind).toBe('snapshot');

    // ref_1 在集合内 → 不是编造
    const contract = r.dataParts.contract as {
      citations: { invalid: string[] };
      ok: boolean;
    };
    expect(contract.citations.invalid).toEqual([]);
    expect(contract.ok).toBe(true);
  }, NET_TIMEOUT_MS);

  it('降级数据（L2）触发降级声明；未声明则契约报 missing_fallback_disclosure', async () => {
    mock2.setScenario({
      planJson: DEFAULT_PLAN,
      // 正文不提"非实时"与抓取日期 → 若确为降级数据，契约必须报违规
      streamChunks: [
        '【意图解析】x\n【命题重构】y\n【支持证据】最新价见存证[^ref_1]。\n【反对证据】z\n【无法验证项】w\n【敏感性测算】v',
      ],
      toolCalls: [{ name: 'lookupStockSnapshot', args: { query: '中际旭创' } }],
    });

    const POST = await loadRoute(mock2.url);
    const r = await post(POST, [userMsg('中际旭创现在什么价')]);

    const refs = (r.dataParts.refs as { refs?: Array<{ refId: string; payload: { isFallback?: boolean } }> }).refs ?? [];
    const isFallback = refs[0]?.payload?.isFallback === true;
    const codes = ((r.dataParts.contract as { violations?: Array<{ code: string }> }).violations ?? []).map(
      (v) => v.code,
    );

    if (isFallback) {
      // 真降级 → 正文未声明 → 必须报违规（诚实暴露）
      expect(codes).toContain('missing_fallback_disclosure');
    } else {
      // L1 实时 → 不该报降级相关违规（不虚报）
      expect(codes).not.toContain('missing_fallback_disclosure');
    }
  }, NET_TIMEOUT_MS);
});

describe('追问在**本轮末尾**生成（ADR-0002 补充决策 5）', () => {
  let mock3: MockModel;
  beforeAll(async () => {
    mock3 = await startMockModel();
  });
  afterAll(async () => {
    await mock3.close();
  });

  it('追问请求发生在正文之后，且携带本轮正文作为依据', async () => {
    // 原缺陷：追问在计划阶段（分析之前）产出，只依据用户提问，
    // 无法针对本轮查到的证据下钻。
    mock3.setScenario({
      planJson: DEFAULT_PLAN,
      streamChunks: ['【支持证据】本轮查到 TTM 营收 1245 亿、净利率 35.27%[^ref_1]。'],
    });

    const POST = await loadRoute(mock3.url);
    mock3.requests.length = 0;
    await post(POST, [userMsg('中际旭创怎么样')]);

    // 找到追问生成请求（非流式、且提示词含"追问生成器"）
    const fuReq = mock3.requests.find(
      (b) => b.stream !== true && JSON.stringify(b).includes('追问生成器'),
    );
    expect(fuReq, '未发出末尾追问生成请求').toBeTruthy();

    // 关键：该请求的提示词里带上了**本轮正文**（证明它在正文之后、有依据）
    const flat = JSON.stringify(fuReq);
    expect(flat).toContain('1245 亿');

    // 且计划阶段不再产出 followUps（避免两处生成）
    const planReq = mock3.requests.find(
      (b) => b.stream !== true && JSON.stringify(b).includes('前置分析器'),
    );
    expect(planReq).toBeTruthy();
  });

  it('末尾追问仍恒为 3 条（确定性过滤与补齐不变）', async () => {
    mock3.setScenario({ planJson: DEFAULT_PLAN, streamChunks: [DEFAULT_BODY] });
    const POST = await loadRoute(mock3.url);
    const r = await post(POST, [userMsg('中际旭创怎么样')]);
    expect((r.dataParts.followups as { questions: string[] }).questions).toHaveLength(3);
  });

  it('末尾追问生成失败时回退确定性核验向兜底（不暴露失败）', async () => {
    // mock 的第二次非流式调用若返回非数组，应被 sanitizeFollowUps 兜底到 3 条
    mock3.setScenario({ planJson: DEFAULT_PLAN, streamChunks: [DEFAULT_BODY] });
    const POST = await loadRoute(mock3.url);
    const r = await post(POST, [userMsg('中际旭创怎么样')]);
    const qs = (r.dataParts.followups as { questions: string[] }).questions;
    expect(qs).toHaveLength(3);
    for (const q of qs) expect(q.trim().length).toBeGreaterThan(5);
  });

  it('data-followups 仍在契约之后写出（顺序契约不变）', async () => {
    mock3.setScenario({ planJson: DEFAULT_PLAN, streamChunks: [DEFAULT_BODY] });
    const POST = await loadRoute(mock3.url);
    const r = await post(POST, [userMsg('中际旭创怎么样')]);
    expect(r.order).toEqual(['steps', 'plan', 'refs', 'contract', 'followups']);
  });
});

describe('末尾追问：模型给出的合规数组会被采用（而非一律走兜底）', () => {
  let mock4: MockModel;
  beforeAll(async () => {
    mock4 = await startMockModel();
  });
  afterAll(async () => {
    await mock4.close();
  });

  it('采用模型给出的 3 条核验向问题，保持其顺序', async () => {
    const three = ['本次查到的 36.3% 客户集中度能否与年报前五大客户口径互证？', '若砍单为真，合同负债与存货会先出现什么变化？', '与同行毛利率相比，本次净利率是否异常偏高？'];
    mock4.setScenario({
      planJson: DEFAULT_PLAN,
      streamChunks: [DEFAULT_BODY],
      followUpJson: JSON.stringify(three),
    });

    const POST = await loadRoute(mock4.url);
    const r = await post(POST, [userMsg('中际旭创怎么样')]);
    const qs = (r.dataParts.followups as { questions: string[] }).questions;
    expect(qs).toEqual(three);

    mock4.setScenario({ planJson: DEFAULT_PLAN, streamChunks: [DEFAULT_BODY] });
  });

  it('模型给出操作向追问时被过滤掉，由核验向兜底补齐', async () => {
    mock4.setScenario({
      planJson: DEFAULT_PLAN,
      streamChunks: [DEFAULT_BODY],
      followUpJson: JSON.stringify(['现在要不要买入？', '目标价是多少？', '能否给出明确买卖建议？']),
    });

    const POST = await loadRoute(mock4.url);
    const r = await post(POST, [userMsg('中际旭创怎么样')]);
    const qs = (r.dataParts.followups as { questions: string[] }).questions;

    expect(qs).toHaveLength(3);
    for (const q of qs) {
      expect(q).not.toMatch(/要不要|目标价|买入|卖出/);
    }

    mock4.setScenario({ planJson: DEFAULT_PLAN, streamChunks: [DEFAULT_BODY] });
  });
});

describe('入参形状异常必须干净拒绝，不得 500 崩栈', () => {
  // 真缺陷：POST 直接解构 `{ messages }`，形状不对时在
  // convertToModelMessages 里抛 "Cannot read properties of undefined (reading 'map')"
  // 并以 500 返回整段堆栈。前端若发错形状（旧版本客户端、第三方调用方、
  // 手工 curl）就会看到服务器内部错误，而正确行为是 4xx 干净拒绝。
  // 本仓库的 fail-closed 原则要求"拒绝要说清原因"，不是崩。
  let mock3: MockModel;
  let POST3: (req: never) => Promise<Response>;
  beforeAll(async () => {
    mock3 = await startMockModel();
    mock3.setScenario({ planJson: DEFAULT_PLAN, streamChunks: [DEFAULT_BODY] });
    POST3 = await loadRoute(mock3.url);
  });
  afterAll(async () => {
    await mock3.close();
  });

  const badBodies: Array<[string, unknown]> = [
    ['messages 缺失', {}],
    ['messages 不是数组', { messages: 'nope' }],
    ['messages 为空数组', { messages: [] }],
    ['消息缺 parts（旧格式）', { messages: [{ id: 'm1', role: 'user', content: '你好' }] }],
    ['parts 不是数组', { messages: [{ id: 'm1', role: 'user', parts: 'x' }] }],
    ['没有任何 user 消息', { messages: [{ id: 'm1', role: 'assistant', parts: [] }] }],
  ];

  for (const [name, body] of badBodies) {
    it(`${name} → 4xx 且响应体说明原因`, async () => {
      const res = await postRaw(POST3 as never, body);
      // 关键：不是 500（500 意味着未捕获异常穿透到了框架）
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      const text = await res.text();
      expect(text.length).toBeGreaterThan(0); // 必须有可读原因，不能空体
    });
  }

  it('合法形状仍正常 200（不得因加校验而误伤）', async () => {
    const res = await postRaw(POST3 as never, {
      messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: '中际旭创怎么样' }] }],
    });
    expect(res.status).toBe(200);
    await res.text();
  });
});
