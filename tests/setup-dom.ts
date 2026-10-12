/**
 * 组件测试的 DOM 清理。
 *
 * @testing-library/react 的自动 cleanup 依赖 vitest 的 `globals: true`
 * （它靠全局 afterEach 注册）。本仓库未开 globals（测试显式 import），
 * 因此必须手动注册 cleanup —— 否则上一个用例的 DOM 会残留到下一个用例，
 * 让 "queryAllByRole 应返回 0 个" 这类断言假失败（踩过）。
 */
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(cleanup);
