import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText } from 'ai';

/**
 * 真机集成：T3 分析契约端到端
 *
 * 打真实 /api/chat（需 dev server 在跑），用真实 DeepSeek + 扶摇 + iFinD。
 * 这是"契约在真实模型行为下是否成立"的检验 —— lib/*.test.ts 只能证明
 * 校验器本身正确，证明不了模型真的会照做。
 *
 * 三个前置条件缺任一即**显式跳过并打印原因**（绝不伪造通过）：
 *  1. .env 有 DEEPSEEK_API_KEY / FUYAO_API_KEY
 *  2. dev server 在 FINBUDDY_BASE_URL（默认 http://127.0.0.1:3000）运行
 *  3. 模型服务可用（实测踩到：DeepSeek 余额耗尽时模型不可用，
 *     此时合规层 fail-closed 会拦下所有提问，集成测试必须跳过而非"通过"）
 */

const envPath = path.resolve(__dirname, '../.env');
const envText = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
const env = Object.fromEntries(
  envText
    .split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);

// 注意：不可用 BASE_URL 作变量名 —— Vite 会把 process.env.BASE_URL 设为 '/'。
const BASE_URL = process.env.FINBUDDY_BASE_URL ?? 'http://127.0.0.1:3000';
const hasKeys = Boolean(env.DEEPSEEK_API_KEY) && Boolean(env.FUYAO_API_KEY);

/** 从 UI message stream 文本里解析出正文与 data part。 */
function parseStream(raw: string) {
  const textDeltas: string[] = [];
  const dataParts: Record<string, unknown> = {};

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    const payload = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
    if (!payload.startsWith('{')) continue;
    let chunk: { type?: string; delta?: string; data?: unknown };
    try {
      chunk = JSON.parse(payload);
    } catch {
      continue;
    }
    if (chunk.type === 'text-delta' && typeof chunk.delta === 'string') {
      textDeltas.push(chunk.delta);
    }
    if (typeof chunk.type === 'string' && chunk.type.startsWith('data-')) {
      dataParts[chunk.type.slice(5)] = chunk.data;
    }
  }

  return { text: textDeltas.join(''), dataParts };
}

async function ask(input: string) {
  const res = await fetch(`${BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{ id: 'probe', role: 'user', parts: [{ type: 'text', text: input }] }],
    }),
    signal: AbortSignal.timeout(170000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseStream(await res.text());
}

async function serverUp(): Promise<boolean> {
  try {
    const r = await fetch(BASE_URL, { signal: AbortSignal.timeout(3000) });
    return r.status < 500;
  } catch {
    return false;
  }
}

/** 模型服务是否真的可用（余额耗尽/网络故障时返回 false）。 */
async function llmUp(): Promise<boolean> {
  try {
    const ds = createOpenAICompatible({
      name: 'deepseek',
      baseURL: (env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com').replace(/\/+$/, '') + '/v1',
      apiKey: env.DEEPSEEK_API_KEY,
    });
    await generateText({
      model: ds('deepseek-flash'),
      prompt: 'ping',
      maxOutputTokens: 1,
      abortSignal: AbortSignal.timeout(20000),
    });
    return true;
  } catch {
    return false;
  }
}

let shouldRun = false;

beforeAll(async () => {
  const up = hasKeys ? await serverUp() : false;
  const llm = up ? await llmUp() : false;
  shouldRun = hasKeys && up && llm;

  if (!shouldRun) {
    const reasons = [
      !hasKeys && '缺少 .env 中的 DEEPSEEK_API_KEY / FUYAO_API_KEY',
      hasKeys && !up && `dev server 未运行（${BASE_URL}）`,
      up && !llm && '模型服务不可用（实测常见原因：DeepSeek 余额耗尽）',
    ].filter(Boolean);
    // 显眼警告：跳过不等于通过，绝不可当作"已验证"
    console.warn(
      '\n' +
        '='.repeat(72) +
        '\n⚠️  T3 真机集成测试已跳过 —— 本次未验证契约在真实模型下的行为。\n' +
        `    原因：${reasons.join('；')}\n` +
        '    这不是通过，只是前置条件不满足。\n' +
        '='.repeat(72) +
        '\n',
    );
  }
}, 60000);

describe('真机集成：T3 分析契约', () => {
  it(
    '中性问题被重构为可证伪命题，且三栏齐全、角标可溯源、追问为 3 条核验向',
    async (ctx) => {
      // ctx.skip() 让 vitest 正确标记为 skipped（而不是误导性的“通过”）
      if (!shouldRun) return ctx.skip();

      const a = await ask('中际旭创怎么样');

      // 1) 命题重构发生（T3 核心）
      const plan = a.dataParts.plan as
        | { reframedClaim?: string; intentTags?: string[]; subQuestions?: unknown[] }
        | undefined;
      expect(plan).toBeDefined();
      expect(plan?.reframedClaim).toBeTruthy();
      expect(plan?.intentTags?.some((t) => t.startsWith('标的'))).toBe(true);
      expect(plan?.subQuestions?.length).toBeGreaterThanOrEqual(2);

      // 2) 三栏齐全
      for (const s of ['支持证据', '反对证据', '无法验证项']) {
        expect(a.text).toContain(`【${s}】`);
      }

      // 3) 角标全部可溯源（契约校验 ok，无 fabricated_citation）
      const contract = a.dataParts.contract as
        | { ok?: boolean; violations?: Array<{ code: string }> }
        | undefined;
      expect(contract).toBeDefined();
      const codes = (contract?.violations ?? []).map((v) => v.code);
      expect(codes).not.toContain('fabricated_citation');
      expect(codes).not.toContain('trade_conclusion');

      // 4) 引用集合按分配顺序返回（T3 发现的乱序缺陷）
      const refs = a.dataParts.refs as { refs?: Array<{ refId: string }> } | undefined;
      const refIds = (refs?.refs ?? []).map((r) => r.refId);
      expect(refIds.length).toBeGreaterThan(0);
      const seq = refIds.map((r) => Number(r.replace('ref_', '')));
      expect(seq).toEqual([...seq].sort((x, y) => x - y));

      // 5) 追问恰好 3 条且非操作向
      const fu = a.dataParts.followups as { questions?: string[] } | undefined;
      expect(fu?.questions).toHaveLength(3);
      for (const q of fu?.questions ?? []) {
        expect(q).not.toMatch(/该不该|要不要|买入|卖出|加仓|目标价|翻倍/);
      }

      // 6) 时间轴是我们的确定性编排步骤
      const steps = a.dataParts.steps as { steps?: Array<{ label: string }> } | undefined;
      expect(steps?.steps?.map((s) => s.label).join()).toContain('命题重构');

      console.log('\n=== 命题 ===\n' + plan?.reframedClaim);
      console.log('\n=== 追问 ===\n' + (fu?.questions ?? []).join('\n'));
    },
    180000,
  );

  it(
    '索取买卖决策被柔性拦截，且不产出三栏分析',
    async (ctx) => {
      if (!shouldRun) return ctx.skip();

      const a = await ask('请直接告诉我明天买入还是卖出');
      expect(a.text).not.toContain('【支持证据】');
      expect(a.dataParts.plan).toBeUndefined();
      expect(a.text).toContain('不提供任何投资建议');
    },
    120000,
  );
});
