import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { startMockModel, parseUiStream, DEFAULT_PLAN, DEFAULT_BODY, type MockModel } from './support/mock-model';
import type { NextRequest } from 'next/server';

/**
 * 端到端：数值对账闸门是否真的**走到客户端**
 *
 * 为什么需要这个文件：`lib/reconcile.test.ts` 全部是**纯函数单测** ——
 * 它只证明"规则本身工作"，证明不了"结论被接进了路由、写出了 data part、
 * 到达了浏览器"。本仓库有过前科：护栏写好了、测试也绿了，
 * 但只报告不拦截（`output-contract` 曾经就是），等于没接。
 *
 * 因此这里断言的是**接线**，不是规则：
 *  1. 真实工具链（用真网关取真数据）产出的对账结论进入 `data-contract`
 *  2. block 级结论 → `contract.ok === false`，且违规码为 data_reconciliation_failed
 *  3. 被拦下的数据**不得**出现在测算参数里（滑块取数口也要闸住）
 *
 * 漏掉：模型真实行为（见 agent-contract.integration.test.ts）。
 *
 * 关键红线：对账结论若不能改变交付结果，它就是又一个"只报告、没人管"的模块。
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

async function loadRoute(baseURL: string) {
  loadDotEnv();
  process.env.DEEPSEEK_BASE_URL = baseURL;
  process.env.DEEPSEEK_API_KEY = 'mock-key';
  vi.resetModules();
  const { POST } = await import('@/app/api/chat/route');
  return POST;
}

function chatBody(text: string) {
  return {
    messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text }] }],
  };
}

async function callRoute(POST: (req: NextRequest) => Promise<Response>, text: string) {
  const res = await POST(
    new Request('http://127.0.0.1:3000/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(chatBody(text)),
    }) as never,
  );
  const raw = await res.text();
  return { status: res.status, ...parseUiStream(raw) };
}

/**
 * 每个用例独立起一个 mock。
 *
 * 为什么不能共用：mock 的 `toolCallsEmitted` 标志确保"工具调用只在切换场景后的
 * 第一次流式请求发出"（否则会循环到步数上限）。共用实例时，第二个用例就拿不到
 * 工具调用 → 取不到存证 → 断言"未覆盖真实链路"而失败（实测踩过）。
 * 测试之间共享会自行改变状态的 fixture，是让测试变得不可信的最快方式。
 */
async function withFinancialMock<T>(
  fn: (mock: MockModel) => Promise<T>,
): Promise<T> {
  const mock = await startMockModel({
    toolCalls: [{ name: 'lookupFinancialReport', args: { query: '宁德时代' } }],
  });
  try {
    return await fn(mock);
  } finally {
    await mock.close();
  }
}

describe('端到端：对账闸门接线', () => {
  it('财务参数工具被调用后，data-contract 里带着 reconciliation 结论', async () => {
    await withFinancialMock(async (mock) => {
    const POST = await loadRoute(mock.url);
    const { status, dataParts } = await callRoute(POST, '宁德时代的营收和净利率是多少？');

    expect(status).toBe(200);

    // 存证：必须真的取到了数据（否则本测试没在测真实链路）
    const refs = dataParts.refs as { refs?: Array<{ refId: string; kind: string }> } | undefined;
    expect(refs?.refs?.length ?? 0).toBeGreaterThan(0);

    const contract = dataParts.contract as
      | {
          ok?: boolean;
          violations?: Array<{ code: string; detail?: string }>;
          reconciliation?: Array<{ code: string; severity: string; detail: string }>;
        }
      | undefined;
    expect(contract).toBeDefined();

    // 对账结论必须被写进契约 part（接线点 1）
    expect(Array.isArray(contract?.reconciliation)).toBe(true);
    });
  });

  it('宁德时代（累计口径被求和）→ contract.ok=false 且违规码为 data_reconciliation_failed', async () => {
    await withFinancialMock(async (mock) => {
    const POST = await loadRoute(mock.url);
    const { dataParts } = await callRoute(POST, '宁德时代的营收和净利率是多少？');

    const contract = dataParts.contract as
      | { ok?: boolean; violations?: Array<{ code: string }> }
      | undefined;
    const codes = (contract?.violations ?? []).map((v) => v.code);

    // 真机数据的累计口径必须被拦住 —— 这是本次重构要证明的核心能力
    expect(codes).toContain('data_reconciliation_failed');

    // 且必须真的让契约不通过（否则闸门形同虚设）
    expect(contract?.ok).toBe(false);

    // 正文若把该数据当事实陈述，还要额外报"未声明不可采信"
    expect(codes).toContain('reconciled_data_asserted');
    });
  });

  it('被拦下的财务数据不得进入测算参数（滑块取数口也要闸住）', async () => {
    await withFinancialMock(async (mock) => {
    const POST = await loadRoute(mock.url);
    const { dataParts } = await callRoute(POST, '宁德时代的营收和净利率是多少？');

    const refs = dataParts.refs as
      | {
          refs?: Array<{
            refId: string;
            kind: string;
            payload?: { baseRevenue?: number; reconciliation?: unknown };
          }>;
        }
      | undefined;
    const fin = (refs?.refs ?? []).find((r) => r.kind === 'financials');

    // 前提：确实取到了财务存证（否则本断言无意义）
    expect(fin, '未取到 financials 存证，测试未覆盖真实链路').toBeDefined();

    // 存证 payload 上必须挂着 block 级对账结论（供前端/提取器拒绝）
    const stamped = fin!.payload?.reconciliation as Array<{ severity?: string }> | undefined;
    expect(Array.isArray(stamped)).toBe(true);
    expect(stamped!.some((f) => f.severity === 'block')).toBe(true);

    // 端到端确认：提取器必须拒绝该存证（不返回可测算参数）
    const { extractSensitivityParams } = await import('@/lib/sensitivity');
    const params = extractSensitivityParams([
      { refId: fin!.refId, kind: 'financials', payload: fin!.payload },
    ]);
    expect(params, '被对账拦下的数据仍被注入测算卡 —— 闸门未生效').toBeNull();
    });
  }, 30_000);

  it('对账未触发时（无 block）契约仍可通过 —— 闸门不是无条件拦截', async () => {
    // 用一次**不调任何工具**的提问，确认闸门不会把一切都拦死
    const clean = await startMockModel({ toolCalls: [] });
    try {
      const POST = await loadRoute(clean.url);
      const { dataParts } = await callRoute(POST, '今天天气如何？');
      const contract = dataParts.contract as { violations?: Array<{ code: string }> } | undefined;
      const codes = (contract?.violations ?? []).map((v) => v.code);
      expect(codes).not.toContain('data_reconciliation_failed');
    } finally {
      await clean.close();
    }
  });
});
