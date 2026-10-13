/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { render } from '@testing-library/react';
import { EvidenceDrawer } from './EvidenceDrawer';

/**
 * Tailwind 类名有效性守卫。
 *
 * 抓到（真缺陷，用户实测发现）：`bg-slate-950/98` 这类**不在 Tailwind 默认
 * opacity 档位**内的类名会被 Tailwind **静默丢弃** —— 不报错、不警告，
 * 只是样式不生效。抽屉因此完全没有背景色，看起来像"UI 坏了"。
 *
 * 之所以危险：构建照样成功、lint 照样零警告、测试照样全绿。
 * 只有人肉看渲染结果或本文件这样的守卫才能发现。
 *
 * 漏掉：类名语义是否正确（如颜色选得对不对）、Tailwind 之外的 CSS。
 * 关键红线：**不报错的失效必须靠机器守**。
 */

// jsdom 环境下 import.meta.url 不是 file: 协议，用 cwd（vitest 以仓库根为 cwd）
const root = process.cwd();

/** Tailwind v3 默认 opacity 档位（tailwind.config.ts 未 extend opacity，故用默认）。 */
const OPACITY_SCALE = new Set([
  0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100,
]);

function collectFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules' || name === '.next') continue;
      collectFiles(full, out);
    } else if (/\.(tsx|ts)$/.test(name) && !name.endsWith('.test.ts') && !name.endsWith('.test.tsx')) {
      out.push(full);
    }
  }
  return out;
}

/** 从源码里抽出所有 `颜色/透明度` 形式的类名。 */
function findOpacityClasses(src: string): Array<{ cls: string; opacity: number }> {
  const re =
    /\b((?:bg|text|border|ring|from|to|via|divide|placeholder|shadow|outline|decoration|accent|caret|fill|stroke)-[a-z0-9-]+(?:-\d{2,3})?)\/(\d+)\b/g;
  const hits: Array<{ cls: string; opacity: number }> = [];
  for (const m of src.matchAll(re)) hits.push({ cls: m[0], opacity: Number(m[2]) });
  return hits;
}

describe('Tailwind opacity 档位守卫（防静默丢弃）', () => {
  const files = [...collectFiles(join(root, 'app')), ...collectFiles(join(root, 'components'))];

  it('覆盖到了源码文件（守卫本身没瞎）', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it('没有使用非默认档位的透明度（会被 Tailwind 静默丢弃）', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      for (const { cls, opacity } of findOpacityClasses(src)) {
        if (!OPACITY_SCALE.has(opacity)) {
          offenders.push(`${cls}  ← ${f.replace(root, '')}`);
        }
      }
    }
    expect(
      [...new Set(offenders)],
      '这些类名不在 Tailwind 默认 opacity 档位内，会被静默丢弃（不报错但样式不生效）：\n' +
        '修法：改用档位内的值（如 /95），或用任意值语法 bg-slate-950/[.98]',
    ).toEqual([]);
  });

  it('任意值语法（bg-x/[.98]）仍被允许（不受档位限制）', () => {
    // 确认守卫不会误伤合法写法
    const samples = ['bg-slate-950/[.98]', 'bg-black/[0.03]'];
    for (const s of samples) {
      const hits = findOpacityClasses(s);
      // 任意值语法不会被 \d+ 匹配到 → 不产生误报
      expect(hits).toEqual([]);
    }
  });
});

describe('抽屉真的有背景色（回归：/98 被丢弃导致抽屉透明）', () => {
  it('渲染出的 class 含背景色，且不含被丢弃的 /98', () => {
    const { container } = render(
      <EvidenceDrawer
        refId="ref_1"
        refs={[{ refId: 'ref_1', kind: 'snapshot', payload: { data: { name: 'x' } } }]}
        onClose={() => {}}
        onNavigate={() => {}}
      />,
    );
    const aside = container.querySelector('aside');
    expect(aside).not.toBeNull();
    const cls = aside?.className ?? '';
    // 必须有背景色类 —— 否则抽屉会透明（用户看到"UI 坏了"）。
    // 断言目标从深色 token（bg-slate-950/）改为浅色主题 token（bg-chat-ai/）：
    // 守卫的语义是「抽屉背景色类不会被 Tailwind 静默丢弃」，与用哪个色无关。
    expect(cls).toMatch(/bg-chat-ai\//);
    expect(cls).not.toContain('/98');
  });
});
