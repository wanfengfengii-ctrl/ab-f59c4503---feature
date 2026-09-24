import { applyCmp, PetriModel } from './types';

/** 轨迹中的一步：触发哪个变迁，以及触发前后的完整标记。 */
export interface Step {
  /** 变迁下标（0 起，展示时编号 +1） */
  t: number;
  before: number[];
  after: number[];
}

export interface AuditStats {
  /** 已探索的可达状态数（含验收吸收态） */
  states: number;
  /** 可达状态图上的变迁边数 */
  edges: number;
  /** 最长有限前缀深度 */
  maxDepth: number;
  timeMs: number;
}

export type AuditResult =
  | { kind: 'verified'; stats: AuditStats }
  | { kind: 'forbidden'; trace: Step[]; stats: AuditStats }
  | { kind: 'deadlock'; trace: Step[]; stats: AuditStats }
  | { kind: 'lasso'; prefix: Step[]; cycle: Step[]; stats: AuditStats }
  | { kind: 'error'; message: string; stats?: AuditStats };

/** finish 的入参：尚未附带统计信息的结果 */
type AuditDraft =
  | { kind: 'verified' }
  | { kind: 'forbidden'; trace: Step[] }
  | { kind: 'deadlock'; trace: Step[] }
  | { kind: 'lasso'; prefix: Step[]; cycle: Step[] }
  | { kind: 'error'; message: string };

export const VERDICT_TEXT: Record<AuditResult['kind'], string> = {
  verified: '已验证：所有执行均终止于验收标记，且从未进入禁态',
  forbidden: '反例：可达禁态',
  deadlock: '反例：非验收死锁',
  lasso: '反例：存在无限执行（套索见证）',
  error: '审计中止',
};

/** 二叉最小堆，按 (深度, 变迁编号序列字典序) 排序。 */
class MinHeap<T> {
  private a: T[] = [];
  constructor(private cmp: (x: T, y: T) => number) {}
  get size(): number {
    return this.a.length;
  }
  push(v: T): void {
    const a = this.a;
    a.push(v);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.cmp(a[p], v) <= 0) break;
      a[i] = a[p];
      i = p;
    }
    a[i] = v;
  }
  pop(): T {
    const a = this.a;
    const top = a[0];
    const last = a.pop()!;
    if (a.length > 0) {
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let s = i;
        if (l < a.length && this.cmp(a[l], a[s]) < 0) s = l;
        if (r < a.length && this.cmp(a[r], a[s]) < 0) s = r;
        if (s === i) break;
        a[i] = a[s];
        i = s;
      }
      a[i] = last;
    }
    return top;
  }
}

interface QueueEntry {
  key: number;
  depth: number;
  /** 路径的变迁编号序列（2 位定长编码，字典序比较即变迁编号字典序） */
  seq: string;
  parentKey: number;
  parentT: number;
}

const pad2 = (t: number) => String(t).padStart(2, '0');

function cmpEntry(a: QueueEntry, b: QueueEntry): number {
  if (a.depth !== b.depth) return a.depth - b.depth;
  if (a.seq < b.seq) return -1;
  if (a.seq > b.seq) return 1;
  return 0;
}

/**
 * 完整探索有界 Petri 网的可达状态图，判定：
 *  1. 是否可达禁态或非验收死锁 —— 返回步数最短、变迁编号序列字典序最小的轨迹；
 *  2. 否则是否存在无限执行 —— 返回前缀最短、循环最短、同规则决胜的套索见证；
 *  3. 否则证明：每条执行都终止于验收标记且从未进入禁态。
 *
 * 验收标记为吸收态（到达即结束）；禁态判定优先于验收判定。
 */
export function runAudit(model: PetriModel, maxStates = 200_000): AuditResult {
  const started = Date.now();
  const P = model.places.length;
  const T = model.transitions.length;
  const cap = model.places.map((p) => p.capacity);
  const acc = model.places.map((p) => p.acceptance);
  const pre = model.transitions.map((t) => t.pre);
  const post = model.transitions.map((t) => t.post);

  // 容量 ≤ 3，每个库所 2 bit，18 个库所共 36 bit，远小于 2^53，可安全编码为 number。
  const pow4: number[] = [];
  for (let i = 0; i < P; i++) pow4.push(4 ** i);
  const encode = (m: number[]): number => {
    let k = 0;
    for (let i = 0; i < P; i++) k += m[i] * pow4[i];
    return k;
  };
  const decode = (k: number): number[] => {
    const m = new Array<number>(P);
    for (let i = 0; i < P; i++) m[i] = Math.floor(k / pow4[i]) % 4;
    return m;
  };
  // 变迁对状态编码的净增量：key' = key + delta[t]
  const delta = model.transitions.map((t) => {
    let d = 0;
    for (let i = 0; i < P; i++) d += (t.post[i] - t.pre[i]) * pow4[i];
    return d;
  });

  const isAcceptance = (m: number[]): boolean => {
    for (let i = 0; i < P; i++) if (m[i] !== acc[i]) return false;
    return true;
  };
  const isForbidden = (m: number[]): boolean =>
    model.forbidden.some(
      (group) =>
        group.length > 0 &&
        group.every((c) => applyCmp(m[c.place], c.op, c.value)),
    );

  const stats: AuditStats = { states: 0, edges: 0, maxDepth: 0, timeMs: 0 };
  const finish = (r: AuditDraft): AuditResult => {
    stats.timeMs = Date.now() - started;
    return { ...r, stats } as AuditResult;
  };

  const visited = new Set<number>();
  const parent = new Map<number, { p: number; t: number }>();
  const dist = new Map<number, number>();
  const adj = new Map<number, { t: number; to: number }[]>();

  /** 沿父指针回溯从初始状态到 key 的最短、字典序最小轨迹。 */
  const buildTrace = (key: number): Step[] => {
    const chain: { key: number; t: number }[] = [];
    let cur = key;
    for (;;) {
      const par = parent.get(cur);
      if (!par || par.p < 0) break;
      chain.push({ key: cur, t: par.t });
      cur = par.p;
    }
    chain.reverse();
    const steps: Step[] = [];
    let prev = cur; // 初始状态
    for (const { key: k, t } of chain) {
      steps.push({ t, before: decode(prev), after: decode(k) });
      prev = k;
    }
    return steps;
  };

  // ---------- 阶段一：按 (深度, 序列字典序) 的均匀代价搜索，完整探索可达状态 ----------
  const heap = new MinHeap<QueueEntry>(cmpEntry);
  const initMarking = model.places.map((p) => p.initial);
  const initKey = encode(initMarking);
  heap.push({ key: initKey, depth: 0, seq: '', parentKey: -1, parentT: -1 });

  const m = new Array<number>(P);
  while (heap.size > 0) {
    const e = heap.pop();
    if (visited.has(e.key)) continue;
    visited.add(e.key);
    dist.set(e.key, e.depth);
    parent.set(e.key, { p: e.parentKey, t: e.parentT });
    stats.states++;
    if (e.depth > stats.maxDepth) stats.maxDepth = e.depth;
    // 解码标记
    for (let i = 0; i < P; i++) m[i] = Math.floor(e.key / pow4[i]) % 4;

    // 禁态优先判定：进入禁态的执行已经违规
    if (isForbidden(m)) {
      return finish({ kind: 'forbidden', trace: buildTrace(e.key) });
    }
    // 验收标记为吸收态：该次执行成功结束，不再展开
    if (isAcceptance(m)) continue;

    if (stats.states > maxStates) {
      return finish({
        kind: 'error',
        message: `状态空间超过上限（>${maxStates} 个状态），审计中止。请缩小模型规模或提高上限后重试。`,
      });
    }

    let any = false;
    let edges = adj.get(e.key);
    if (!edges) {
      edges = [];
      adj.set(e.key, edges);
    }
    for (let t = 0; t < T; t++) {
      const tp = pre[t];
      const tq = post[t];
      let ok = true;
      for (let i = 0; i < P; i++) {
        const mi = m[i];
        if (mi < tp[i] || mi - tp[i] + tq[i] > cap[i]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      any = true;
      const to = e.key + delta[t];
      edges.push({ t, to });
      stats.edges++;
      if (!visited.has(to)) {
        heap.push({
          key: to,
          depth: e.depth + 1,
          seq: e.seq + pad2(t),
          parentKey: e.key,
          parentT: t,
        });
      }
    }
    if (!any) {
      // 非验收态且无可用变迁：非验收死锁
      return finish({ kind: 'deadlock', trace: buildTrace(e.key) });
    }
  }

  // ---------- 阶段二：在有限子图上寻找套索（无限执行见证） ----------
  // 状态空间有限，无限执行 ⟺ 从初始态可达一个环（不经过验收吸收态）。
  const onCycle = statesOnCycles(adj);
  if (onCycle.size === 0) {
    return finish({ kind: 'verified' });
  }

  // 候选环入口按距离升序处理，保证前缀最短优先
  const candidates = [...onCycle].sort((a, b) => dist.get(a)! - dist.get(b)!);

  interface LassoCand {
    prefixLen: number;
    cycleLen: number;
    seq: string; // 前缀序列 + 循环序列，用于字典序决胜
    entry: number;
    cycle: { t: number; to: number }[];
  }
  let best: LassoCand | null = null;
  for (const s of candidates) {
    const d = dist.get(s)!;
    if (best && d > best.prefixLen) break; // 距离已超最优前缀，提前结束
    const cyc = shortestCycle(s, adj);
    if (!cyc) continue;
    const prefixSeq = buildTrace(s)
      .map((st) => pad2(st.t))
      .join('');
    const cand: LassoCand = {
      prefixLen: d,
      cycleLen: cyc.edges.length,
      seq: prefixSeq + cyc.edges.map((e2) => pad2(e2.t)).join(''),
      entry: s,
      cycle: cyc.edges,
    };
    if (
      !best ||
      cand.prefixLen < best.prefixLen ||
      (cand.prefixLen === best.prefixLen && cand.cycleLen < best.cycleLen) ||
      (cand.prefixLen === best.prefixLen &&
        cand.cycleLen === best.cycleLen &&
        cand.seq < best.seq)
    ) {
      best = cand;
    }
  }

  if (!best) {
    // 理论上不可达：onCycle 非空则必存在环
    return finish({ kind: 'verified' });
  }

  // 还原循环轨迹：从 entry 出发沿 cycle 边回到 entry
  const cycleSteps: Step[] = [];
  let curKey = best.entry;
  for (const { t, to } of best.cycle) {
    cycleSteps.push({ t, before: decode(curKey), after: decode(to) });
    curKey = to;
  }
  return finish({ kind: 'lasso', prefix: buildTrace(best.entry), cycle: cycleSteps });
}

/** Kosaraju（迭代实现）：返回位于某个环上的状态集合（含自环）。 */
function statesOnCycles(adj: Map<number, { t: number; to: number }[]>): Set<number> {
  const nodes = [...adj.keys()];
  const rev = new Map<number, number[]>();
  for (const [u, es] of adj) {
    for (const { to } of es) {
      let l = rev.get(to);
      if (!l) {
        l = [];
        rev.set(to, l);
      }
      l.push(u);
    }
  }

  // 第一遍：按完成时间排序
  const done = new Set<number>();
  const order: number[] = [];
  for (const s of nodes) {
    if (done.has(s)) continue;
    const stack: { v: number; it: { t: number; to: number }[]; i: number }[] = [
      { v: s, it: adj.get(s) ?? [], i: 0 },
    ];
    done.add(s);
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top.i < top.it.length) {
        const nxt = top.it[top.i++].to;
        if (!done.has(nxt)) {
          done.add(nxt);
          stack.push({ v: nxt, it: adj.get(nxt) ?? [], i: 0 });
        }
      } else {
        order.push(top.v);
        stack.pop();
      }
    }
  }

  // 第二遍：在逆图上按逆完成序划分强连通分量
  const result = new Set<number>();
  const seen = new Set<number>();
  for (let oi = order.length - 1; oi >= 0; oi--) {
    const s = order[oi];
    if (seen.has(s)) continue;
    const comp: number[] = [];
    const stack = [s];
    seen.add(s);
    while (stack.length > 0) {
      const v = stack.pop()!;
      comp.push(v);
      for (const w of rev.get(v) ?? []) {
        if (!seen.has(w)) {
          seen.add(w);
          stack.push(w);
        }
      }
    }
    if (comp.length > 1) {
      for (const v of comp) result.add(v);
    } else {
      // 单点分量：仅当存在自环时在环上
      const v = comp[0];
      if ((adj.get(v) ?? []).some((e) => e.to === v)) result.add(v);
    }
  }
  return result;
}

/** 从 s 出发回到 s 的最短环（等长时取变迁编号序列字典序最小）。 */
function shortestCycle(
  s: number,
  adj: Map<number, { t: number; to: number }[]>,
): { edges: { t: number; to: number }[] } | null {
  interface E {
    key: number;
    depth: number;
    seq: string;
    parentKey: number;
    parentT: number;
  }
  const heap = new MinHeap<E>(cmpEntry);
  // 注意：s 不加入 seen，否则无法发现回到 s 的边；s 一旦出队即命中返回，不会被扩展。
  const seen = new Set<number>();
  const parent = new Map<number, { p: number; t: number }>();
  for (const { t, to } of adj.get(s) ?? []) {
    heap.push({ key: to, depth: 1, seq: pad2(t), parentKey: s, parentT: t });
  }
  while (heap.size > 0) {
    const e = heap.pop();
    if (e.key !== s) {
      if (seen.has(e.key)) continue;
      seen.add(e.key);
    }
    parent.set(e.key, { p: e.parentKey, t: e.parentT });
    if (e.key === s) {
      // 回溯环边
      const edges: { t: number; to: number }[] = [];
      let cur = s;
      for (;;) {
        const par = parent.get(cur)!;
        edges.push({ t: par.t, to: cur });
        if (par.p === s) break;
        cur = par.p;
      }
      edges.reverse();
      return { edges };
    }
    for (const { t, to } of adj.get(e.key) ?? []) {
      if (!seen.has(to)) {
        heap.push({ key: to, depth: e.depth + 1, seq: e.seq + pad2(t), parentKey: e.key, parentT: t });
      }
    }
  }
  return null;
}
