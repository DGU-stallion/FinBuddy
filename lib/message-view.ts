/**
 * Seam 12: 消息 → 视图模型（T4 页面状态机）
 *
 * 设计要点：
 * - **把状态机从 JSX 里拿出来**：`app/page.tsx` 只做渲染，所有解析都在这里，
 *   于是"角标校验集合从哪来""合规轮次怎么分流"这类核心规则可以被精确单测。
 * - **角标校验集合只认 `data-refs`**：缺失时返回空集合（→ 全部角标失效）。
 *   绝不从正文里"推测"集合，否则 ADR-0002 决策 2 的前端强制校验形同虚设。
 * - **合规轮次走独立分支**：合规拦截只有一句引导文案，若按分析轮次渲染会得到
 *   三栏空壳，误导用户以为分析失败。
 * - **流式中必然不完整**：任何 data part 缺失/形状错误都不得抛异常，
 *   否则流式渲染中途会整页崩掉。
 * - 纯函数：无 React 依赖，可在 node 环境下测试。
 */

import { detectDegraded, type RefEntry, type DegradedIndicator } from './evidence';
import { extractSensitivityParams, type SensitivityInjectParams } from './sensitivity';
import type { OrchestrationStep } from './orchestration';
import type { AnalysisPlan } from './analysis';

export type ComplianceLayerName = 'keyword' | 'intent' | 'fail_closed';

export interface ContractView {
  ok: boolean;
  violations: Array<{ code: string; detail: string }>;
  citations: { cited: string[]; valid: string[]; invalid: string[]; hasAny: boolean };
}

export interface AssistantView {
  /** 轮次类型：合规拦截轮次 或 正常分析轮次。 */
  kind: 'analysis' | 'compliance';
  messageId: string;
  /** 该轮对应的用户提问（供展示与重跑）。 */
  userText: string;
  body: string;
  steps: OrchestrationStep[];
  plan: (AnalysisPlan & { fromModel?: boolean }) | null;
  refs: RefEntry[];
  /** 角标强制校验的合法集合（来自 data-refs；缺失即空 → 全部失效）。 */
  allowedRefIds: string[];
  contract: ContractView | null;
  followUps: string[];
  /** L2 降级指示灯；无降级为 null。 */
  degraded: DegradedIndicator | null;
  /** 敏感性测算参数（来自 financials 存证）；不可测算为 null。 */
  sensitivityParams: SensitivityInjectParams | null;
  complianceLayer: ComplianceLayerName | null;
  /** 该轮是否仍在流式接收中。 */
  streaming: boolean;
}

export interface DeriveInput {
  messages: readonly unknown[];
  /** 正在流式的 assistant 消息 id（`useChat` 的 status 派生）。 */
  streamingMessageId?: string | null;
}

function asObj(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function strArr(v: unknown): string[] {
  return asArray(v).filter((x): x is string => typeof x === 'string');
}

/** 取消息的 parts（非数组一律当空）。 */
function partsOf(m: Record<string, unknown>): Array<Record<string, unknown>> {
  return asArray(m.parts).map(asObj);
}

/** 拼接消息里所有 text part（流式中最后一段可能还没结束，依然要展示）。 */
function textOf(parts: Array<Record<string, unknown>>): string {
  return parts
    .filter((p) => p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('');
}

function findPart(parts: Array<Record<string, unknown>>, type: string): Record<string, unknown> | null {
  return parts.find((p) => p.type === type) ?? null;
}

/** 解析 data-refs → RefEntry[]（形状不符则忽略）。 */
function parseRefs(part: Record<string, unknown> | null): RefEntry[] {
  if (!part) return [];
  const raw = asArray(asObj(part.data).refs);
  return raw.map(asObj).flatMap((r) => {
    const refId = r.refId;
    if (typeof refId !== 'string') return [];
    return [
      {
        refId,
        kind: typeof r.kind === 'string' ? r.kind : 'unknown',
        payload: r.payload,
      },
    ];
  });
}

function parseSteps(part: Record<string, unknown> | null): OrchestrationStep[] {
  if (!part) return [];
  return asArray(asObj(part.data).steps).map(asObj).flatMap((s) => {
    if (typeof s.id !== 'string' || typeof s.label !== 'string') return [];
    return [{ id: s.id, label: s.label, detail: typeof s.detail === 'string' ? s.detail : '' }];
  });
}

function parsePlan(part: Record<string, unknown> | null): AssistantView['plan'] {
  if (!part) return null;
  const d = asObj(part.data);
  if (typeof d.reframedClaim !== 'string') return null;

  const subQuestions = asArray(d.subQuestions).map(asObj).flatMap((sq) => {
    if (typeof sq.question !== 'string') return [];
    return [
      {
        question: sq.question,
        verificator: (typeof sq.verificator === 'string' ? sq.verificator : 'unverifiable') as never,
      },
    ];
  });

  return {
    reframedClaim: d.reframedClaim,
    intentTags: strArr(d.intentTags),
    subQuestions,
    fromModel: d.fromModel === true,
  };
}

function parseContract(part: Record<string, unknown> | null): ContractView | null {
  if (!part) return null;
  const d = asObj(part.data);
  const c = asObj(d.citations);
  return {
    ok: d.ok === true,
    violations: asArray(d.violations).map(asObj).flatMap((v) => {
      if (typeof v.code !== 'string') return [];
      return [{ code: v.code, detail: typeof v.detail === 'string' ? v.detail : '' }];
    }),
    citations: {
      cited: strArr(c.cited),
      valid: strArr(c.valid),
      invalid: strArr(c.invalid),
      hasAny: c.hasAny === true,
    },
  };
}

function parseComplianceLayer(part: Record<string, unknown> | null): ComplianceLayerName | null {
  if (!part) return null;
  const layer = asObj(part.data).layer;
  if (layer === 'keyword' || layer === 'intent' || layer === 'fail_closed') return layer;
  // 未知层级按最温和的 keyword 处理，不崩页
  return 'keyword';
}

/**
 * 把消息历史转成可渲染的轮次视图。
 *
 * 用户消息归属紧随其后的 assistant 消息（不串轮）。
 */
export function deriveViews(input: DeriveInput): AssistantView[] {
  const messages = Array.isArray(input.messages) ? input.messages : [];
  const views: AssistantView[] = [];
  let pendingUserText = '';

  for (const m of messages) {
    const msg = asObj(m);
    const role = msg.role;
    const parts = partsOf(msg);

    if (role === 'user') {
      pendingUserText = textOf(parts);
      continue;
    }
    if (role !== 'assistant') continue;

    const compliancePart = findPart(parts, 'data-compliance');
    const complianceLayer = parseComplianceLayer(compliancePart);
    const refs = parseRefs(findPart(parts, 'data-refs'));
    const messageId = typeof msg.id === 'string' ? msg.id : `asst-${views.length}`;

    views.push({
      // 合规轮次只有引导文案，没有分析结构 → 独立分支
      kind: complianceLayer ? 'compliance' : 'analysis',
      messageId,
      userText: pendingUserText,
      body: textOf(parts),
      steps: complianceLayer ? [] : parseSteps(findPart(parts, 'data-steps')),
      plan: complianceLayer ? null : parsePlan(findPart(parts, 'data-plan')),
      refs: complianceLayer ? [] : refs,
      // 只认 data-refs 的集合。缺了就空 → 所有角标失效（绝不猜）
      allowedRefIds: complianceLayer ? [] : refs.map((r) => r.refId),
      contract: complianceLayer ? null : parseContract(findPart(parts, 'data-contract')),
      followUps: complianceLayer
        ? []
        : strArr(asObj(findPart(parts, 'data-followups')?.data).questions),
      degraded: complianceLayer ? null : detectDegraded(refs),
      sensitivityParams: complianceLayer ? null : extractSensitivityParams(refs),
      complianceLayer,
      streaming: input.streamingMessageId != null && input.streamingMessageId === messageId,
    });
  }

  return views;
}

/**
 * 从 `useChat` 的 status 派生"正在流式的消息 id"。
 * 只有 streaming 状态才需要；其它状态返回 null。
 */
export function streamingIdFromStatus(
  status: string,
  messages: readonly unknown[],
): string | null {
  if (status !== 'streaming' && status !== 'submitted') return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = asObj(messages[i]);
    if (m.role === 'assistant' && typeof m.id === 'string') return m.id;
  }
  return null;
}
