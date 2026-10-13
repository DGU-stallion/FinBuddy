import type { Config } from "tailwindcss";

/**
 * Tailwind 配置 —— 浅色问财风设计 token。
 *
 * 设计依据：`.scratch/finbuddy-agent/research-wencai-ui.md`（同花顺问财线上
 * bundle 提取的 121 个实证 token）与 `.scratch/finbuddy-agent/ui-redesign-contract.md`。
 *
 * 所有色值分两类，**不要混用**：
 *  - 【实证】直接来自 iwencai.com 线上资源（brand/chat/ink/line/page）。
 *  - 【计算】我按 WCAG 对比度算出的语义色（rise/fall/evidence/warn）——
 *    实证色 #e93030 在白底只有 4.26:1，不达 AA，故涨跌用深一档的值。
 *
 * 为什么要区分：品牌色可以照着抄，但**承载信息**的颜色（涨跌、证据方向）
 * 必须满足可读性下限，否则"照抄"会照抄出一个读不清的界面。
 */
const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // 保留：历史代码可能引用 var(--background)/var(--foreground)
        background: "var(--background)",
        foreground: "var(--foreground)",

        // ---- 主色（【实证】问财 --brand-text-color / --blue-color1）----
        brand: {
          DEFAULT: "#165dff", // 按钮 / 链接 / 激活态
          hover: "#136dff",
          bg: "#f0f4ff", // 浅底
        },

        // ---- 对话（【实证】--chat-*-bubble-bg-color）----
        chat: {
          user: "#d3e0ff", // 用户气泡底（实证 "chat-right-bubble-bg-color":"#d3e0ff"）
          ai: "#ffffff", // AI 气泡/卡片底（实证 "chat-left-bubble-bg-color":"#fff"）
        },

        // ---- 文字层级（【实证】--text-color1/2/3）----
        ink: {
          1: "#10131f", // 一级：结论/标题（白底 18.5:1）
          2: "#5e606a", // 二级：说明（白底 6.3:1）
          3: "#8f9198", // 三级：**仅装饰/大字号**（白底 3.2:1，正文禁用）
        },

        // ---- 边框 / 页底（【实证】--border-color1 / --bg-color1）----
        line: {
          DEFAULT: "#eaeaeb",
          strong: "#dddde0",
        },
        page: {
          DEFAULT: "#f4f4f5", // 页底
          alt: "#fafafa", // 斑马纹/次级底
        },

        // ---- A股涨跌（【计算】白底 ≥4.5:1；红涨绿跌是 A股肌肉记忆）----
        rise: "#c62828", // 涨 5.62:1
        fall: "#0f7b3f", // 跌 5.35:1

        // ---- 三栏证据方向（【计算】）----
        // 刻意避开红绿：A股用户心智里"红=涨=好"，若用红色表示"反对证据"，
        // 第一直觉信号是反的（设计契约 §3.2 红线 R3）。
        evidence: {
          support: "#1d4ed8", // 支持证据 6.70:1
          against: "#b45309", // 反对证据 5.02:1
          unknown: "#475569", // 无法验证项 7.58:1
        },

        // ---- 降级/警示（【计算】5.02:1）----
        warn: {
          DEFAULT: "#b45309",
          bg: "#fffbeb",
          border: "#fcd34d",
        },
      },

      // ---- 字号阶梯（【实证】问财 CSS 频次 14px×45 > 12px×33 > 16px×20）----
      fontSize: {
        aux: ["12px", "18px"], // 辅助/标签
        body: ["14px", "22px"], // 正文（**最小正文**，设计契约红线 R1）
        lead: ["15px", "24px"], // 长段落
        card: ["16px", "24px"], // 卡片标题
        kpi: ["20px", "28px"], // 关键数值
        hero: ["28px", "36px"], // 页面级 KPI
      },

      // ---- 圆角（【实证】问财 4px×23 > 8px×16，小圆角为主）----
      borderRadius: {
        chip: "4px",
        card: "8px",
        bubble: "12px",
        modal: "16px",
      },

      boxShadow: {
        // 卡片轻阴影：浅色界面靠边框+微阴影分层，不用重阴影（会显脏）
        card: "0 1px 2px 0 rgb(16 19 31 / 0.04)",
        pop: "0 8px 32px rgb(16 19 31 / 0.12)",
      },

      keyframes: {
        "fade-in-up": {
          from: { opacity: "0", transform: "translateY(4px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        "fade-in-up": "fade-in-up 0.18s ease-out",
      },
    },
  },
  plugins: [],
};
export default config;
