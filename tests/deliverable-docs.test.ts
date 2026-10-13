import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * 交付文档守卫。
 *
 * 抓到：文档里写了"已部署/已通过"，但实际没做 —— 本仓库有过这类记录。
 * 漏掉：命令能否真的执行（那靠各测试文件自身）。
 * 关键红线：**未发生的事不得写成已完成**。
 *
 * 这里只做机器可判定的部分：文件存在、脚本存在、状态勾选与 git 事实一致。
 * 语义判断（"这句话是否夸大"）不在此处，靠人读。
 */

// 用 fileURLToPath 而非 .pathname：仓库路径含空格时 .pathname 会给出 %20 编码
const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string) => readFileSync(root + p, 'utf8');

describe('原题要求的交付物都真实存在', () => {
  it('README / 测试文档 / AI 使用记录 / 演示指引 / 部署说明 齐全', () => {
    for (const f of ['README.md', 'TESTING.md', 'AI-USAGE.md', 'DEMO.md', 'DEPLOY.md']) {
      expect(existsSync(root + f), `${f} 缺失`).toBe(true);
      expect(read(f).trim().length, `${f} 为空`).toBeGreaterThan(200);
    }
  });

  it('仓库根有 GLOSSARY 与 ADR（领域文档约定）', () => {
    expect(existsSync(root + 'GLOSSARY.md')).toBe(true);
    expect(existsSync(root + 'docs/adr/0001-financial-correctness-guardrails.md')).toBe(true);
    expect(existsSync(root + 'docs/adr/0002-compliance-and-evidence-integrity.md')).toBe(true);
  });

  it('环境变量模板存在且不含真实值', () => {
    const t = read('.env.example');
    // 模板里每个 KEY= 后面必须为空（真实值绝不入模板）
    for (const line of t.split('\n')) {
      const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
      if (m) expect(m[2].trim(), `.env.example 的 ${m[1]} 竟有值`).toBe('');
    }
  });

  it('深链 key 只在 .env.example 中作占位，且 .env 未被 git 跟踪', () => {
    // 真实密钥绝不入库：这条是被公开仓库放大的风险，必须每次 CI 都验
    let tracked = '';
    try {
      tracked = execFileSync('git', ['ls-files'], { cwd: root }).toString();
    } catch {
      return; // 非 git 环境（如打包分发）跳过
    }
    const envFiles = tracked.split('\n').filter((f) => /^\.env/.test(f));
    expect(envFiles).toEqual(['.env.example']);
  });
});

describe('部署验证脚本存在且可执行（不是写在文档里的空命令）', () => {
  it('scripts/verify-deploy.mjs 存在', () => {
    expect(existsSync(root + 'scripts/verify-deploy.mjs')).toBe(true);
  });

  it('DEPLOY.md 引用的脚本路径真实存在', () => {
    const d = read('DEPLOY.md');
    // 文档里出现的 scripts/xxx.mjs 必须都真实存在，否则是"写了命令但跑不了"
    const refs = [...d.matchAll(/scripts\/[a-z0-9-]+\.mjs/g)].map((m) => m[0]);
    expect(refs.length).toBeGreaterThan(0);
    for (const r of new Set(refs)) {
      expect(existsSync(root + r), `DEPLOY.md 引用了不存在的 ${r}`).toBe(true);
    }
  });

  it('与 package.json 里的脚本引用一致（无悬挂引用）', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    for (const cmd of Object.values(pkg.scripts)) {
      for (const m of cmd.matchAll(/scripts\/[a-z0-9-]+\.mjs/g)) {
        expect(existsSync(root + m[0]), `package.json 引用了不存在的 ${m[0]}`).toBe(true);
      }
    }
  });
});

describe('DEPLOY.md 的"未部署"状态与 git 事实一致', () => {
  it('既然本文档说未部署，就不应存在 .vercel 项目目录', () => {
    const d = read('DEPLOY.md');
    const claimsUndeployed = d.includes('未实际部署');
    if (claimsUndeployed) {
      // 若哪天真的部署了 Vercel，会出现 .vercel/；此时必须同步改文档（守卫会失败提醒）
      expect(existsSync(root + '.vercel'), '.vercel 存在但 DEPLOY.md 仍称"未部署" —— 请同步文档').toBe(
        false,
      );
    }
  });

  it('部署记录区块保留为空（未部署就不预填）', () => {
    const d = read('DEPLOY.md');
    const block = d.split('## 7. 部署记录')[1]?.split('## 8.')[0] ?? '';
    expect(block).toContain('待填');
    // 不得出现"已部署成功"这类未发生的断言
    expect(block).not.toMatch(/已部署成功|部署完成于/);
  });
});
