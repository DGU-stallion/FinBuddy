/**
 * Seam 11: 网关载荷 -> LLM 上下文文本
 *
 * 设计要点（见 ADR-0001 / ADR-0002）：
 * - 来源、时点、单位、refId 必须出现在文本里，让模型无法"忘记"标注出处。
 * - 缺失字段必须显式写"缺失"，不得静默省略（题目红线）。
 * - 降级数据必须带显著过期警告，防止模型当作实时数据正常陈述。
 */

export interface SnapshotPayload {
  refId: string;
  source: string;
  asOf: number;
  isFallback: boolean;
  fallbackNote?: string;
  data: {
    thscode?: string;
    name?: string;
    last_price?: number;
    price_change_ratio_pct?: number;
    turnover?: number;
    pe_ttm?: number;
    pb_mrq?: number;
  };
}

export interface FinancialsPayload {
  refId: string;
  source: string;
  asOf: number;
  isFallback: boolean;
  data: {
    thscode?: string;
    report?: string;
    baseRevenue?: number;
    revenueBasis?: string;
    netMargin?: number;
    grossMargin?: number;
    taxRate?: number;
  };
}

/** 类型谓词：为 true 时收窄为 undefined，让后续代码可以安全使用数值。 */
function isMissing(v: number | undefined | null): v is undefined | null {
  return v === undefined || v === null || Number.isNaN(v);
}

function fmtDate(ms: number): string {
  if (!ms || Number.isNaN(ms)) return '时点缺失';
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 亿元换算，保留两位小数 */
function toYi(v: number): string {
  return `${(v / 1e8).toFixed(2)} 亿元`;
}

export function formatSnapshotForLLM(p: SnapshotPayload): string {
  const d = p.data;
  const lines: string[] = [];
  lines.push(`【行情快照 · 引用号 ${p.refId}】`);
  lines.push(`数据来源：${p.source}`);
  lines.push(`数据时点：${fmtDate(p.asOf)}`);
  if (p.isFallback) {
    lines.push(`⚠️ 降级存证：外部实时接口不可用，当前为历史存证数据${p.fallbackNote ? `（${p.fallbackNote}）` : ''}，非实时行情。`);
  }
  lines.push(`标的：${d.thscode ?? '缺失'}${d.name ? ` ${d.name}` : ''}`);
  lines.push(`最新价：${isMissing(d.last_price) ? '缺失' : `${d.last_price} 元`}`);
  lines.push(
    `涨跌幅：${isMissing(d.price_change_ratio_pct) ? '缺失' : `${d.price_change_ratio_pct.toFixed(2)}%`}`,
  );
  lines.push(`成交额：${isMissing(d.turnover) ? '缺失' : toYi(d.turnover)}`);
  lines.push(`PE(TTM)：${isMissing(d.pe_ttm) ? '缺失' : d.pe_ttm.toFixed(2)}`);
  lines.push(`PB(MRQ)：${isMissing(d.pb_mrq) ? '缺失' : d.pb_mrq.toFixed(2)}`);
  return lines.join('\n');
}

export function formatFinancialsForLLM(p: FinancialsPayload): string {
  const d = p.data;
  const lines: string[] = [];
  lines.push(`【财务参数 · 引用号 ${p.refId}】`);
  lines.push(`数据来源：${p.source}`);
  lines.push(`数据时点：${fmtDate(p.asOf)}`);
  if (p.isFallback) {
    lines.push(`⚠️ 降级存证：当前为历史存证数据，非最新报告期。`);
  }
  lines.push(`报告期：${d.report ?? '缺失'}`);
  lines.push(
    `基准营收（${d.revenueBasis ?? '口径未标注'}）：${isMissing(d.baseRevenue) ? '缺失' : toYi(d.baseRevenue)}`,
  );
  lines.push(`净利率：${isMissing(d.netMargin) ? '缺失' : `${d.netMargin.toFixed(2)}%`}`);
  lines.push(`毛利率：${isMissing(d.grossMargin) ? '缺失' : `${d.grossMargin.toFixed(2)}%`}`);
  lines.push(`所得税率：${isMissing(d.taxRate) ? '缺失' : `${d.taxRate.toFixed(2)}%`}`);
  return lines.join('\n');
}
