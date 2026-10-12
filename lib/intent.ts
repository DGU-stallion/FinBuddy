/**
 * 意图级合规判断（ADR-0002 决策 1）
 *
 * 用 LLM 判断用户是否在"索取自身的买卖操作决策"，以捕捉关键词层漏网的口语化表达
 * （"这股能上车吗""要不要割肉"）。
 *
 * 与 [lib/compliance.ts] 的关键词层构成双保险。此处只做判定，柔性引导话术在其上层。
 */

import { generateText, type LanguageModel } from 'ai';

/** 供测试注入的假模型接口：给定提示词，返回文本。 */
export type IntentModel = (prompt: string) => Promise<string>;

/** 把 AI SDK 的语言模型适配成 IntentModel（真实路径用）。 */
export function modelAsIntentModel(model: LanguageModel): IntentModel {
  return async (prompt: string) => {
    const r = await generateText({ model, prompt, temperature: 0 });
    return r.text;
  };
}

export function buildIntentPrompt(): string {
  return `你是一个合规判别器。判断用户这句话是否在【索取自身的买卖操作决策】（即想让别人告诉他该不该买、该不该卖、能不能持有）。

判定为"是"的情形（索取操作决策）：
- "这股能上车吗"、"我该不该割肉"、"现在能拿吗"、"要不要加仓"、"帮我看看能不能买"

判定为"否"的情形（研究性提问，只是了解事实）：
- "北向资金最近在买入中际旭创吗"（询问资金流向这一事实）
- "机构最新评级是买入吗"（询问评级这一事实）
- "大股东有没有减持卖出计划"（询问股东行为这一事实）
- "它的毛利率是多少"

关键区分：问的是「市场上的事实」→ 否；问的是「我该怎么做」→ 是。

只输出一个字："是" 或 "否"。不要输出其他任何内容。`;
}

/**
 * 判断文本是否在索取买卖决策。
 * 解析失败时抛错，由调用方 fail-closed 保守拦截。
 */
export async function classifyIntent(text: string, model: IntentModel): Promise<boolean> {
  const raw = await model(`${buildIntentPrompt()}\n\n用户提问：${text}`);
  const s = raw.trim();

  // 允许模型带少量解释，但必须能识别出肯定/否定判断
  if (s.startsWith('是') || s.includes('判断：是') || s.includes('判断:是')) return true;
  if (s.startsWith('否') || s.includes('判断：否') || s.includes('判断:否')) return false;

  throw new Error(`意图判断输出无法解析：${s.slice(0, 40)}`);
}
