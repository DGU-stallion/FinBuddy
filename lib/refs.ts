/**
 * 引用号分配器（ADR-0002 决策 2）
 *
 * 实测发现的缺陷：原先用 `refRegistry.size + 1` 生成 refId，
 * 但并发工具调用时 registry.set() 尚未执行，4 次调用全部拿到 ref_1，
 * 导致角标无法溯源。
 *
 * 修正：用单调递增计数器分配，与登记动作解耦。
 *
 * 补充（T3 真机验收发现）：list() 的顺序契约。register() 发生在工具调用**完成**时，
 * 4 路并发调用完成顺序 = 网络完成顺序，与 next() 的分配顺序不一致，
 * 实测得到 ref_2, ref_4, ref_3, ref_1 —— 存证抽屉里的引用号会随网络抖动乱序。
 * 因此 list() 必须按 refId 的**分配序号**排序，而非登记顺序。
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
      // 按分配序号排序，使存证抽屉/角标顺序稳定可预期（不随并发完成顺序抖动）
      return order
        .slice()
        .sort((a, b) => refSeq(a) - refSeq(b))
        .map((refId) => ({ refId, payload: store.get(refId) as T }));
    },
  };
}

/** 抽取 refId 的分配序号；非 ref_N 形状的排在最后（保持相对稳定）。 */
function refSeq(refId: string): number {
  const m = /^ref_(\d+)$/.exec(refId);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}
