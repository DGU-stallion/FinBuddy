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
  const res = await POST(
    new Request('http://localhost/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages }),
    }) as never,
  );
  return parseUiStream(await res.text());
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
  });

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
  });
});
