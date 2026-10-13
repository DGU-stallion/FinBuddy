/**
 * @vitest-environment jsdom
 *
 * 整页渲染守卫（app/page.tsx ↔ 真实 data part）
 *
 * 为什么需要：`app/page.tsx` 是最大的渲染面（340 行）。此前只测了从中抽出的
 * `buildRerunText`，**页面本身的装配**（把 data part 正确接到各组件、
 * 抽屉联动、降级指示灯、合规分支分流）没有验证。装配错了是"每个零件都对、
 * 整机不动"的典型故障，且只会在演示时暴露。
 *
 * 做法：mock `@ai-sdk/react` 的 useChat，喂入**真机 fixture** 的 data part，
 * 断言页面上出现了应有的区块。
 *
 * 抓到：data part 接错组件、合规轮次误渲染三栏、抽屉与三栏未联动、
 *       降级指示灯未渲染、追问按钮缺失。
 * 漏掉：真实流式时序（mock 是静态快照）、CSS 视觉效果。
 *
 * 关键红线：合规轮次**不得**渲染三栏；有财务存证时**必须**渲染测算卡片。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---- mock useChat ----
const chatState: {
  messages: unknown[];
  status: string;
  error: Error | null;
  sendMessage: ReturnType<typeof vi.fn>;
  setMessages: ReturnType<typeof vi.fn>;
} = {
  messages: [],
  status: 'ready',
  error: null,
  sendMessage: vi.fn(),
  setMessages: vi.fn(),
};

vi.mock('@ai-sdk/react', () => ({
  useChat: () => ({
    messages: chatState.messages,
    status: chatState.status,
    error: chatState.error,
    sendMessage: chatState.sendMessage,
    setMessages: chatState.setMessages,
  }),
}));

const fix = JSON.parse(
  readFileSync(join(process.cwd(), 'tests/fixtures/real-t4-run.json'), 'utf8'),
) as {
  question: string;
  parts: Array<{ type: string; id?: string; data: unknown }>;
  body: string;
};

/** 把真机 fixture 装成页面会收到的消息形状。 */
function realMessages() {
  return [
    { id: 'u1', role: 'user', parts: [{ type: 'text', text: fix.question }] },
    {
      id: 'a1',
      role: 'assistant',
      parts: [...fix.parts, { type: 'text', text: fix.body, state: 'done' }],
    },
  ];
}

async function renderPage() {
  const Page = (await import('@/app/page')).default;
  return render(<Page />);
}

describe('整页渲染（真机 fixture 驱动）', () => {
  beforeEach(() => {
    chatState.messages = [];
    chatState.status = 'ready';
    chatState.error = null;
    chatState.sendMessage = vi.fn();
    chatState.setMessages = vi.fn();
  });

  it('首屏渲染搜索框与两张预置案例卡片', async () => {
    await renderPage();
    expect(screen.getByPlaceholderText(/输入投资疑问/)).toBeDefined();
    expect(document.body.textContent).toContain('中际旭创 · 大客户砍单核验');
    expect(document.body.textContent).toContain('宁德时代 · 固态电池量产跳票');
  });

  it('点预置案例把提问发给 sendMessage（一键触发链路）', async () => {
    await renderPage();
    fireEvent.click(screen.getByText('中际旭创 · 大客户砍单核验'));
    expect(chatState.sendMessage).toHaveBeenCalledTimes(1);
    const arg = chatState.sendMessage.mock.calls[0][0] as { text: string };
    expect(arg.text).toContain('中际旭创');
  });

  it('真机 fixture 渲染出三栏 + 时间轴 + 命题 + 追问 + 测算卡片（完整装配）', async () => {
    chatState.messages = realMessages();
    await renderPage();

    const t = document.body.textContent ?? '';
    // 三栏
    for (const n of ['支持证据', '反对证据', '无法验证项']) expect(t, `缺 ${n}`).toContain(n);
    // 时间轴
    expect(t).toContain('思考过程');
    // 命题重构
    expect(t).toContain('命题重构');
    // 追问
    expect(t).toContain('继续核验');
    // 测算卡片（真机 fixture 含 financials 存证 → 必须是**带参数的**卡片）
    // 注意：只断言标题'营收冲击推演'是不够的 —— 参数缺失分支也渲染同一标题，
    // 变异测试证明过该断言会漏掉"参数注入断裂"（卡片恒显示不可测算）。
    // 因此断言只在该分支出现的滑块与口径标注。
    expect(t).toContain('营收冲击推演');
    expect(t).toContain('营收整体下滑幅度'); // 滑块标签：仅参数就位时渲染
    expect(t).toContain('参数溯源'); // 口径与 refId 标注
    expect(t).not.toContain('本轮未取得可测算的财务参数');
  });

  it('命题来自模型时不显示"兜底命题"标注', async () => {
    chatState.messages = realMessages();
    await renderPage();
    expect(document.body.textContent).not.toContain('兜底命题');
  });

  it('三栏内不出现字面 Markdown 星号（整页级确认）', async () => {
    chatState.messages = realMessages();
    await renderPage();
    expect(document.body.textContent).not.toContain('**');
  });

  it('点角标滑出存证抽屉，抽屉含原始 JSON 层（三栏↔抽屉联动）', async () => {
    chatState.messages = realMessages();
    await renderPage();

    const btns = screen.getAllByRole('button').filter((b) => /^ref_\d+$/.test(b.textContent ?? ''));
    expect(btns.length).toBeGreaterThan(0);
    fireEvent.click(btns[0]);

    const t = document.body.textContent ?? '';
    expect(t).toContain('查看完整原始 JSON');
    expect(t).toContain('存证');
  });

  it('合规轮次渲染提示而**不**渲染三栏', async () => {
    chatState.messages = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: '买入吗' }] },
      {
        id: 'a1',
        role: 'assistant',
        parts: [
          { type: 'data-compliance', id: 'compliance', data: { layer: 'fail_closed' } },
          { type: 'text', text: '合规校验服务暂时不可用。', state: 'done' },
        ],
      },
    ];
    await renderPage();

    const t = document.body.textContent ?? '';
    expect(t).toContain('合规校验服务暂时不可用');
    expect(t).toContain('不是因为您的问题违规');
    // 关键：不得渲染三栏与测算卡片
    expect(t).not.toContain('支持证据');
    expect(t).not.toContain('营收冲击推演');
  });

  it('L2 降级时渲染降级指示灯', async () => {
    chatState.messages = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: '中际旭创什么价' }] },
      {
        id: 'a1',
        role: 'assistant',
        parts: [
          {
            type: 'data-steps',
            id: 'steps',
            data: { steps: [{ id: 'step-reframe', label: '命题重构', detail: 'x' }] },
          },
          {
            type: 'data-refs',
            id: 'refs',
            data: {
              refs: [
                {
                  refId: 'ref_1',
                  kind: 'snapshot',
                  payload: {
                    refId: 'ref_1',
                    source: 'L2 本地存证 · 扶摇历史快照',
                    asOf: Date.UTC(2026, 9, 12),
                    isFallback: true,
                    fallbackNote: '抓取于 2026-10-12，非实时行情',
                    data: { name: '中际旭创', thscode: '300308.SZ', last_price: 724.47 },
                  },
                },
              ],
            },
          },
          {
            type: 'text',
            text: '【支持证据】非实时数据 2026-10-12[^ref_1]。\n【反对证据】x\n【无法验证项】y',
            state: 'done',
          },
        ],
      },
    ];
    await renderPage();

    const t = document.body.textContent ?? '';
    expect(t).toContain('降级存证');
    expect(t).toContain('非实时');
  });

  it('清空上下文按钮调用 setMessages([])（票面要求）', async () => {
    chatState.messages = realMessages();
    await renderPage();
    fireEvent.click(screen.getByText('清空上下文'));
    expect(chatState.setMessages).toHaveBeenCalledWith([]);
  });

  it('错误时显示错误信息而不白屏', async () => {
    chatState.error = new Error('模拟上游故障');
    await renderPage();
    expect(document.body.textContent).toContain('模拟上游故障');
  });
});
