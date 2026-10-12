/**
 * Seam 10: 多轮上下文结构化摘要（spec 交互决策「多轮上下文」）
 *
 * 设计要点：
 * - **只带结构化结论摘要，不带完整对话历史**：追问时把「本轮标的 + 已确认事实」
 *   压缩成一段紧凑文本注入下一轮，避免 token 爆炸与噪音污染（spec 明示）。
 * - **已确认事实必须源自工具原始 payload**，不采信模型正文里的转述 ——
 *   模型正文可能转述错误，而 payload 是网关签发的原始材料（ADR-0002 决策 4）。
 * - 从历史消息的 data part 反推（`data-plan` 给标的与命题、`data-refs` 给事实），
 *   因此**不需要客户端额外配合**：客户端只要照常回传消息即可。
 * - 纯函数：便于测试与复用（服务端注入 + 未来可能的会话恢复）。
 */

/** 抽出事实的最大条数（摘要必须紧凑，不能退化成完整数据倾倒）。 */
const MAX_FACTS = 12;

export interface ConfirmedFact {
  refId: string;
  label: string;
  value: string;
}

export interface ContextSummary {
  /** 本轮标的（取自意图标签）。 */
  subject: string;
  /** 已确认的可证伪命题（上一轮的重构结果）。 */
  claim: string;
  facts: ConfirmedFact[];
  /** 渲染为可注入下一轮的紧凑文本。 */
  toPromptText(): string;
}

interface RefLike {
  refId?: unknown;
  kind?: unknown;
  payload?: unknown;
}

interface PayloadLike {
  isFallback?: unknown;
  fallbackNote?: unknown;
  vacuum?: unknown;
  items?: unknown;
  baseRevenue?: unknown;
  revenueBasis?: unknown;
  netMargin?: unknown;
  grossMargin?: unknown;
  data?: unknown;
}

function asObj(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

function numStr(v: unknown, digits: number): string | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : undefined;
}

function toYi(v: unknown): string | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? `${(v / 1e8).toFixed(2)} 亿元` : undefined;
}

/**
 * 从存证 payload 提炼「已确认事实」。
 *
 * 只提炼可回溯到字段的数值/状态，不做任何推断。真空期单独记为一条事实，
 * 让下一轮知道"这件事查不到"，而不是当成没发生过。
 */
export function summarizeFacts(refs: readonly RefLike[]): ConfirmedFact[] {
  const facts: ConfirmedFact[] = [];

  for (const r of refs) {
    const refId = str(r.refId);
    if (!refId) continue;
    const kind = str(r.kind) ?? 'unknown';
    const p = asObj(r.payload) as PayloadLike;
    const nested = asObj(p.data);

    if (kind === 'snapshot') {
      const name = str(nested.name);
      const code = str(nested.thscode);
      const price = numStr(nested.last_price, 2);
      const pe = numStr(nested.pe_ttm, 2);
      const parts = [
        name ? `${name}${code ? `(${code})` : ''}` : code,
        price ? `最新价 ${price} 元` : undefined,
        pe ? `PE(TTM) ${pe}` : undefined,
      ].filter(Boolean);
      if (parts.length > 0) facts.push({ refId, label: '行情快照', value: parts.join('，') });
      continue;
    }

    if (kind === 'financials') {
      const pick = (k: keyof PayloadLike) => p[k] ?? nested[k as string];
      const rev = toYi(pick('baseRevenue'));
      const basis = str(p.revenueBasis) ?? str(nested.revenueBasis);
      const margin = numStr(pick('netMargin'), 2);
      const gross = numStr(pick('grossMargin'), 2);
      const parts = [
        rev ? `基准营收 ${rev}${basis ? `（口径 ${basis}）` : ''}` : undefined,
        margin ? `净利率 ${margin}%` : undefined,
        gross ? `毛利率 ${gross}%` : undefined,
      ].filter(Boolean);
      if (parts.length > 0) facts.push({ refId, label: '财务参数', value: parts.join('，') });
      continue;
    }

    if (kind === 'announcements') {
      const items = Array.isArray(p.items) ? p.items : [];
      if (p.vacuum === true || items.length === 0) {
        facts.push({ refId, label: '公告检索', value: '未返回结果（信息真空期，不得据此脑补结论）' });
      } else {
        const titles = items
          .slice(0, 3)
          .map((it) => str(asObj(it).title))
          .filter((t): t is string => Boolean(t));
        facts.push({
          refId,
          label: '公告检索',
          value: `命中 ${items.length} 条${titles.length > 0 ? `：${titles.join('；')}` : ''}`,
        });
      }
      continue;
    }
  }

  return facts.slice(0, MAX_FACTS);
}

/** 历史消息里出现的 data part 类型（AI SDK 5 形状）。 */
interface PartLike {
  type?: unknown;
  data?: unknown;
}

interface MessageLike {
  role?: unknown;
  parts?: unknown;
}

/**
 * 从消息历史构建下一轮要携带的结构化摘要。
 *
 * @returns 无可依据的历史（首轮 / 历史里没有计划）返回 null —— 绝不猜标的。
 */
export function buildContextSummary(messages: readonly MessageLike[]): ContextSummary | null {
  // 从后往前找最近一条带 data-plan 的消息（标的不被更早轮次污染）
  let plan: { reframedClaim?: unknown; intentTags?: unknown } | null = null;
  let refs: RefLike[] = [];

  for (let i = messages.length - 1; i >= 0; i--) {
    const parts = Array.isArray(messages[i].parts) ? (messages[i].parts as PartLike[]) : [];
    const planPart = parts.find((p) => p.type === 'data-plan');
    if (!planPart) continue;

    plan = asObj(planPart.data);
    // 同一轮里的 refs 才是与之配套的事实（避免跨轮混用）
    const refsPart = parts.find((p) => p.type === 'data-refs');
    const rawRefs = refsPart ? asObj(refsPart.data).refs : undefined;
    refs = Array.isArray(rawRefs) ? (rawRefs as RefLike[]) : [];
    break;
  }

  if (!plan) return null;

  const tags = Array.isArray(plan.intentTags) ? plan.intentTags.filter((t): t is string => typeof t === 'string') : [];
  const subjectTag = tags.find((t) => /^标的\s*[:：]/.test(t));
  const subject = subjectTag ? subjectTag.replace(/^标的\s*[:：]\s*/, '').trim() : '该标的';
  const claim = str(plan.reframedClaim) ?? '';
  const facts = summarizeFacts(refs);

  return {
    subject,
    claim,
    facts,
    toPromptText() {
      const lines: string[] = ['【上一轮已确认的结构化结论】', `本轮标的：${subject}`];
      if (claim) lines.push(`已重构命题：${claim}`);
      if (facts.length > 0) {
        lines.push('已确认事实（源自工具原始 payload，可直接复用，无需重复调用）：');
        for (const f of facts) lines.push(`- [${f.refId}] ${f.label}：${f.value}`);
      } else {
        lines.push('已确认事实：无（上一轮未取得可回溯数据）');
      }
      lines.push('注意：以上为结构化摘要，不含完整对话历史；如需新事实请重新调用工具核验。');
      return lines.join('\n');
    },
  };
}
