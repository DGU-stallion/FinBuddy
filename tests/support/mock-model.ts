/**
 * 可编程的 OpenAI 兼容 Mock 模型服务（测试专用）
 *
 * 用途：**不依赖付费 API 余额**即可端到端验证 /api/chat 的路由编排 ——
 * 包括计划解析、多轮上下文注入、data part 写出顺序、契约校验。
 *
 * 为什么需要它：
 * 1. DeepSeek 余额耗尽时（真机集成测试只能跳过），路由层编排逻辑此前覆盖为**零**。
 *    跳过是诚实的，但零覆盖不是可接受的终局 —— 有了 mock 就不再是零。
 * 2. 评委/CI 可复现：端到端断言不应以"账户里有钱"为前提。
 * 3. 可精确控制模型输出（如故意返回带编造角标的正文）做对抗性测试。
 *
 * 协议：OpenAI Chat Completions 子集。
 *  - 非流式（计划阶段 generateText）→ choices[0].message.content
 *  - 流式（主循环 streamText）→ SSE 分片 + `data: [DONE]`
 * 只实现本项目用到的子集，不做兼容性兜底 —— 那会掩盖真实不匹配。
 */

import { createServer, type Server } from 'node:http';

export interface Scenario {
  /** 计划阶段（非流式）返回的 JSON 文本。 */
  planJson: string;
  /** 主循环（流式）返回的正文分片。 */
  streamChunks: string[];
  /** 主循环先发一个工具调用（用于验证工具链路）。 */
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
  /**
   * 意图合规判断的答复（另一个非流式调用）。默认 "否"。
   * 置为 "是" 可测意图层拦截。
   *
   * 注意：意图判断与计划阶段共用非流式路径，靠**提示词内容**区分 ——
   * 判断"是否索取买卖决策"的请求里含合规定界语句。
   */
  intentVerdict?: string;
  /**
   * 追问生成阶段（本轮末尾的第二个非流式调用）要返回的 JSON 数组文本。
   * 默认返回计划 JSON（非数组）→ 触发 sanitizeFollowUps 的确定性兜底。
   */
  followUpJson?: string;
}

export interface MockModel {
  url: string;
  /** 收到过的全部请求体（按到达顺序），供断言。 */
  requests: Array<Record<string, unknown>>;
  /** 切换后续请求的行为（并重置"只发一次工具调用"计数）。 */
  setScenario: (s: Scenario) => void;
  close: () => Promise<void>;
}

export const DEFAULT_PLAN = JSON.stringify({
  reframedClaim: '中际旭创当前业绩稳健，未出现重大经营风险。',
  intentTags: ['标的: 中际旭创', '事件: 大客户砍单传闻'],
  subQuestions: [
    { question: '营收与净利率是多少？', verificator: 'financials' },
    { question: '公告有无相关披露？', verificator: 'announcements' },
  ],
  followUps: ['其一能否证伪？', '其二口径是否可比？', '同行对比如何？'],
});

export const DEFAULT_BODY = [
  '【意图解析】标的 中际旭创，核验维度为财务支撑。',
  '【命题重构】中际旭创当前业绩稳健，未出现重大经营风险。',
  '【支持证据】营收与净利率保持稳定。',
  '【反对证据】行业价格存在压力。',
  '【无法验证项】大客户集中度尚未披露。',
  '【敏感性测算】见下方卡片。',
].join('\n');

function frame(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => resolve(raw));
  });
}

export async function startMockModel(initial?: Partial<Scenario>): Promise<MockModel> {
  const requests: Array<Record<string, unknown>> = [];
  let scenario: Scenario = {
    planJson: DEFAULT_PLAN,
    streamChunks: [DEFAULT_BODY],
    ...initial,
  };

  // 工具调用只在**切换场景后的第一次**流式请求发出。
  // 因为 streamText 在工具返回后会再次调用模型（stopWhen），若无此限制，
  // mock 会每步都再要一次工具 → 循环到步数上限（实测超时 5s）。
  let toolCallsEmitted = false;

  const server: Server = createServer(async (req, res) => {
    if (req.method !== 'POST' || !req.url?.includes('/chat/completions')) {
      res.writeHead(404).end('{}');
      return;
    }

    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    } catch {
      /* 按非流式处理 */
    }
    requests.push(body);

    // ---- 非流式：意图判断 或 计划阶段 ----
    if (body.stream !== true) {
      // 意图判断请求可从提示词识别：它要求"只输出一个字"且含合规判别语句
      const flat = JSON.stringify(body);
      // 靠提示词文案区分三个非流式端点。**这是脆弱耦合**（Standard 轴评审 #10）：
      // 上游改一句提示词，这里就会静默走错分支，测试以误导性方式失败。
      // 因此加自检：若一个请求都没命中已知端点，直接抛错并打印提示词开头，
      // 让失败原因一目了然（而不是表现为"计划解析失败"之类的假象）。
      const isIntentJudge = flat.includes('合规判别器') || flat.includes('买卖操作决策');
      const isFollowUp = flat.includes('追问生成器');
      const isPlan = flat.includes('前置分析器');

      if (!isIntentJudge && !isFollowUp && !isPlan) {
        throw new Error(
          '[mock-model] 无法识别该非流式请求属于哪个端点 —— 提示词可能已变更，' +
            '请同步更新 tests/support/mock-model.ts 的识别关键词。请求开头：' +
            flat.slice(0, 200),
        );
      }

      const content = isIntentJudge
        ? (scenario.intentVerdict ?? '否')
        : isFollowUp
          ? (scenario.followUpJson ?? scenario.planJson)
          : scenario.planJson;

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: isIntentJudge ? 'mock-intent' : 'mock-plan',
          object: 'chat.completion',
          created: 0,
          model: 'deepseek-flash',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
      return;
    }

    // ---- 流式：主循环 ----
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const base = {
      id: 'mock-stream',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'deepseek-flash',
    };

    const wantsToolCalls = !toolCallsEmitted && (scenario.toolCalls?.length ?? 0) > 0;
    toolCallsEmitted = true;

    for (const call of wantsToolCalls ? scenario.toolCalls! : []) {
      res.write(
        frame({
          ...base,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: `call_${call.name}`,
                    type: 'function',
                    function: { name: call.name, arguments: JSON.stringify(call.args) },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        }),
      );
    }

    // 有工具调用的那一轮只发工具请求，不发正文 —— 因为真实模型是
    // 「先要工具 → 拿到结果 → 再成稿」，若同轮也发正文，工具返回后会再发一遍，
    // 正文就重复了（实测会把六栏文字叠两遍）。
    if (!wantsToolCalls) {
      for (const piece of scenario.streamChunks) {
        res.write(
          frame({ ...base, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] }),
        );
      }
    }

    res.write(frame({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
    res.write('data: [DONE]\n\n');
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    setScenario: (s) => {
      scenario = s;
      toolCallsEmitted = false;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/**
 * 解析 UI message stream（SSE）为 { text, dataParts }。
 * 与 tests/agent-contract.integration.test.ts 使用同一解析思路，
 * 保证离线与真机断言看到的是同一种流。
 */
export function parseUiStream(raw: string): {
  text: string;
  dataParts: Record<string, unknown>;
  /** data part 的到达顺序（用于断言写出顺序）。 */
  order: string[];
  /**
   * **全部** chunk 的类型序列（用于断言流内事件顺序，如 start 必须最前）。
   *
   * 为什么需要它：真缺陷 —— 路由曾把 data-steps/data-plan 写在 start **之前**，
   * 导致 AI SDK 客户端开出**两条** assistant 消息、页面把同一提问渲染两次。
   * 只断言 data part 顺序抓不到这个错（data part 的相对顺序是对的），
   * 必须能看到 start 与 data-* 的**相对位置**。
   */
  chunkTypes: string[];
} {
  const deltas: string[] = [];
  const dataParts: Record<string, unknown> = {};
  const order: string[] = [];
  const chunkTypes: string[] = [];

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    const payload = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
    if (payload === '[DONE]' || !payload.startsWith('{')) continue;
    let chunk: { type?: string; delta?: string; data?: unknown };
    try {
      chunk = JSON.parse(payload) as typeof chunk;
    } catch {
      continue;
    }
    if (typeof chunk.type === 'string') chunkTypes.push(chunk.type);
    if (chunk.type === 'text-delta' && typeof chunk.delta === 'string') {
      deltas.push(chunk.delta);
    }
    if (typeof chunk.type === 'string' && chunk.type.startsWith('data-')) {
      const name = chunk.type.slice(5);
      dataParts[name] = chunk.data;
      order.push(name);
    }
  }

  return { text: deltas.join(''), dataParts, order, chunkTypes };
}
