/**
 * Seam 17: 网关 payload 字段提取（跨模块共享的形状适配）
 *
 * 背景（Standard 轴评审 #7）：`lib/evidence.ts`（存证抽屉摘要）与
 * `lib/context-summary.ts`（多轮事实摘要）各自实现了同一套「字段在哪一层」的
 * 适配规则 —— financials 的顶层优先于 `data` 嵌套、snapshot 的 data 嵌套、
 * announcements 的真空期判定。文案不同是合理的（两个消费者措辞不同），
 * 但**形状规则**必须共享：否则网关 payload 形状一变要改两处，漏一处就静默取不到值。
 *
 * 设计要点：
 * - 只做"取值与形状适配"，不做展示（展示留在各消费者，措辞各自负责）。
 * - 对缺字段返回 undefined，绝不用 0/'' 冒充（调用方据此显式声明"缺失"）。
 * - 纯函数、无 IO：前后端均可复用。
 */

/** 宽松对象视图：payload 形状随网关演进，但不能用 any（会丢类型保护）。 */
export type LooseRecord = Record<string, unknown>;

export function asRecord(v: unknown): LooseRecord {
  return typeof v === 'object' && v !== null ? (v as LooseRecord) : {};
}

/** 取有限数值；非数值/NaN/Infinity 一律 undefined。 */
export function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** 取非空字符串。 */
export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

/**
 * 取某字段：**顶层优先，回退到 data 嵌套**。
 *
 * 真机确认网关的 financials payload 同时有顶层与 `data` 内字段（见 gateway.ts），
 * 两个消费者必须用同一优先级，否则同一份 payload 在两个界面显示不同值。
 */
export function pickTopFirst(payload: unknown, key: string): unknown {
  const p = asRecord(payload);
  if (p[key] !== undefined) return p[key];
  return asRecord(p.data)[key];
}

/** snapshot 字段视图（行情字段在 data 嵌套里）。 */
export interface SnapshotFields {
  name?: string;
  thscode?: string;
  lastPrice?: number;
  changePct?: number;
  turnover?: number;
  peTtm?: number;
  pbMrq?: number;
}

export function readSnapshot(payload: unknown): SnapshotFields {
  const d = asRecord(asRecord(payload).data);
  return {
    name: str(d.name),
    thscode: str(d.thscode),
    lastPrice: num(d.last_price),
    changePct: num(d.price_change_ratio_pct),
    turnover: num(d.turnover),
    peTtm: num(d.pe_ttm),
    pbMrq: num(d.pb_mrq),
  };
}

/** financials 字段视图（顶层优先）。 */
export interface FinancialsFields {
  baseRevenue?: number;
  revenueBasis?: string;
  netMargin?: number;
  grossMargin?: number;
  taxRate?: number;
  report?: string;
}

export function readFinancials(payload: unknown): FinancialsFields {
  return {
    baseRevenue: num(pickTopFirst(payload, 'baseRevenue')),
    revenueBasis: str(pickTopFirst(payload, 'revenueBasis')),
    netMargin: num(pickTopFirst(payload, 'netMargin')),
    grossMargin: num(pickTopFirst(payload, 'grossMargin')),
    taxRate: num(pickTopFirst(payload, 'taxRate')),
    report: str(asRecord(asRecord(payload).data).report),
  };
}

/** announcements 字段视图（含真空期判定）。 */
export interface AnnouncementFields {
  /** 是否处于信息真空期：显式 vacuum=true 或 items 为空。 */
  vacuum: boolean;
  items: Array<{ title?: string; snippet?: string; date?: string }>;
  asOf?: number;
}

export function readAnnouncements(payload: unknown): AnnouncementFields {
  const p = asRecord(payload);
  const raw = Array.isArray(p.items) ? p.items : [];
  const items = raw.map((it) => {
    const o = asRecord(it);
    return { title: str(o.title), snippet: str(o.snippet), date: str(o.date) };
  });
  return {
    vacuum: p.vacuum === true || items.length === 0,
    items,
    asOf: num(p.asOf),
  };
}
