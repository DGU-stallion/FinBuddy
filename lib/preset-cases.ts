/**
 * Seam 13: 预置案例（T5「一键触发完整链路」）
 *
 * 设计要点：
 * - **标的名一律从 lib/fallback.ts 派生**，不硬编码。原因（ADR-0001 决策 3）：
 *   L2 兜底存证只覆盖预置案例；若案例列表与兜底存证漂移，断网演示时
 *   用户点进案例会发现没有兜底数据 —— 而那正是最需要它的时刻。
 * - 提问设计为**核验向**（传闻是否成立、公告有无披露），不含买卖操作词，
 *   保证点进去不会被合规层先拦下，能直接展示完整链路。
 * - 纯数据模块：可在 node 环境测试，无 React 依赖。
 */

import { listFallbackCases } from './fallback';

export interface PresetCase {
  /** 标的代码（作为稳定 key 与查找键）。 */
  thscode: string;
  /** 卡片标题，含标的名。 */
  title: string;
  /** 一键提问文本（核验向）。 */
  question: string;
  /** 卡片角标文案。 */
  tag: string;
}

/** 每个标的对应的核验向提问。 */
const QUESTIONS: Record<string, { topic: string; question: string }> = {
  '300308.SZ': {
    topic: '大客户砍单核验',
    question: '中际旭创大客户砍单传闻导致业绩要崩，这个说法成立吗？',
  },
  '300750.SZ': {
    topic: '固态电池量产跳票',
    question: '网传宁德时代固态电池量产跳票，公告里有相关披露吗？',
  },
};

const DEFAULT_TAG = '预置案例 · 真机验证';

/**
 * 从兜底存证派生的预置案例清单。
 *
 * 兜底存证里出现但未定义提问的标的，会得到一个通用的核验向提问 ——
 * 宁可给通用提问，也不让案例与会话里的存证覆盖脱节。
 */
export const PRESET_CASES: PresetCase[] = listFallbackCases().map((rec) => {
  const q = QUESTIONS[rec.thscode];
  return {
    thscode: rec.thscode,
    title: `${rec.name} · ${q?.topic ?? '基本面核验'}`,
    question: q?.question ?? `${rec.name}近期业绩与公告披露情况如何，有无需要关注的经营风险？`,
    tag: DEFAULT_TAG,
  };
});

export function presetFor(thscode: string): PresetCase | null {
  return PRESET_CASES.find((c) => c.thscode === thscode) ?? null;
}
