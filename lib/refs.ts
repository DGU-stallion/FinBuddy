/**
 * 引用号分配器（ADR-0002 决策 2）
 *
 * 实测发现的缺陷：原先用 `refRegistry.size + 1` 生成 refId，
 * 但并发工具调用时 registry.set() 尚未执行，4 次调用全部拿到 ref_1，
 * 导致角标无法溯源。
 *
 * 修正：用单调递增计数器分配，与登记动作解耦。
 */

export interface RefEntry<T = unknown> {
  refId: string;
  payload: T;
}

export interface RefAllocator<T = unknown> {
  next(): string;
  register(refId: string, payload: T): void;
  has(refId: string): boolean;
  get(refId: string): T | undefined;
  list(): Array<RefEntry<T>>;
}

export function createRefAllocator<T = unknown>(): RefAllocator<T> {
  let counter = 0;
  const store = new Map<string, T>();
  const order: string[] = [];

  return {
    next() {
      counter += 1;
      return `ref_${counter}`;
    },
    register(refId, payload) {
      if (!store.has(refId)) order.push(refId);
      store.set(refId, payload);
    },
    has(refId) {
      return store.has(refId);
    },
    get(refId) {
      return store.get(refId);
    },
    list() {
      return order.map((refId) => ({ refId, payload: store.get(refId) as T }));
    },
  };
}
