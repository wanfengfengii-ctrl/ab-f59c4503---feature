/**
 * 联锁综合（可控性监督）引擎。
 *
 * 在保持既有令牌、容量、验收与禁态语义完全不变的前提下，对每个变迁标注：
 *  - controllable = true  可控变迁：联锁可以拒绝（拦截）其触发；
 *  - controllable = false 不可控变迁：现场必然发生，联锁无法拒绝，一旦可用即必须纳入保证。
 *
 * 综合目标：从初始标记出发，求一份状态相关的放行策略，使得
 *  1. 任意被允许的执行都在有限步内到达验收标记，且从不进入禁态；
 *  2. 在满足 1 的前提下尽可能多地放行可控变迁（最大宽容）。
 *
 * 方法（吸引子不动点 / 可达性博弈获胜区）：
 *  - 完整探索可达状态图（验收态为吸收态，禁态为失败终点）；
 *  - 获胜区 W 从验收标记（第 0 层）出发逐层外扩：标记 m 进入第 r 层当且仅当
 *      · m 的每条不可控出边都已在更低层（现场必然发生的动作全部安全，且严格向验收推进）；
 *      · 并且：m 存在不可控出边（现场自己会推进），或存在一条可控出边进入更低层
 *        （联锁至少有一个可放行的推进动作）；
 *  - 策略：获胜标记上，放行所有“目标层严格小于当前层”的可控变迁；其余可控变迁一律拦截；
 *    不可控变迁不拦截（也无法拦截）。
 *
 * 有限性证明：在获胜标记上，无论触发的是放行的可控变迁（按策略只放严格降层的）
 * 还是必然发生的不可控变迁（入区条件保证其目标层严格更低），收敛层数 r 都严格递减；
 * r = 0 恰为验收标记，故任意被允许的执行至多 r 步到达验收，且不可能进入禁态
 * （禁态永不在获胜区内，没有任何获胜区上的边被允许/必然进入禁态）。
 *
 * 初始标记不在获胜区时，给出最早无法受控化解的标记、导致失败的不可控变迁及其后果
 * （进入禁态 / 非验收死锁 / 在失败区域内无限循环）。
 */
import { applyCmp, PetriModel } from './types';
import type { Step } from './audit';

export interface PolicyEntry {
  /** 收敛层数：0 = 验收标记；> 0 = 获胜区（任意被允许执行至多 rank 步到验收）；-1 = 失败区 */
  rank: number;
  /** 从初始标记的最短到达步数（字典序决胜） */
  depth: number;
  /** 该标记本身是否为禁态 */
  forbidden: boolean;
}

export type ContinuationType = 'forbidden' | 'deadlock' | 'cycle';

export interface Continuation {
  type: ContinuationType;
  /** 从后果标记出发到终点（禁态/死锁）或循环入口的步骤 */
  steps: Step[];
  /** type === 'cycle' 时的循环段步骤（末态回到循环入口） */
  cycle: Step[];
}

export interface BadTransition {
  /** 不可控变迁下标 */
  t: number;
  /** 该变迁触发后的标记 */
  to: number[];
  /** 沿失败区域继续推演的后果见证 */
  continuation: Continuation;
}

export type WitnessKind = 'forbidden' | 'deadlock' | 'uncontrollable' | 'trapped';

export interface InterlockWitness {
  kind: WitnessKind;
  /** 初始标记 → 最早无法受控化解标记的最短轨迹 */
  trace: Step[];
  /** 最早无法受控化解的标记 */
  marking: number[];
  /** kind === 'uncontrollable'：该标记下必然发生且会离开获胜区的不可控变迁及其后果 */
  badTransitions: BadTransition[];
  /** kind === 'trapped'：该标记下没有任何可放行的可控变迁时，沿失败区域的后果 */
  continuation: Continuation | null;
  /**
   * kind === 'trapped' 时，沿失败区域最早遇到的“危险不可控变迁”（如有）：
   * 受困本身源于放行任何可控变迁都无法保证安全，而沿失败区域推演，
   * 故障最终由该不可控变迁触发；leadSteps 为最早失败标记 → 故障所在标记的步骤。
   */
  rootCause: (BadTransition & { leadSteps: Step[] }) | null;
}

export interface InterlockStats {
  states: number;
  edges: number;
  winningStates: number;
  losingStates: number;
  forbiddenStates: number;
  maxRank: number;
  timeMs: number;
}

export type InterlockResult =
  | { kind: 'secured'; stats: InterlockStats; policy: Map<number, PolicyEntry>; initKey: number; initRank: number }
  | { kind: 'failure'; stats: InterlockStats; policy: Map<number, PolicyEntry>; initKey: number; witness: InterlockWitness }
  | { kind: 'error'; message: string; stats?: InterlockStats };

export const INTERLOCK_VERDICT_TEXT: Record<string, string> = {
  secured: '联锁可保证：被放行的任意执行均在有限步到达验收且不进入禁态',
  failure: '联锁无法保证：存在无法受控化解的标记',
  error: '联锁综合中止',
};

/** 二叉最小堆，按 (深度, 变迁编号序列字典序) 排序（与审计引擎同一决胜规则）。 */
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
  seq: string;
  parentKey: number;
  parentT: number;
}

const pad2 = (x: number) => String(x).padStart(2, '0');

function cmpEntry(a: QueueEntry, b: QueueEntry): number {
  if (a.depth !== b.depth) return a.depth - b.depth;
  if (a.seq < b.seq) return -1;
  if (a.seq > b.seq) return 1;
  return 0;
}

interface Edge {
  t: number;
  to: number;
}

interface NodeInfo {
  key: number;
  badU: number; // 尚未进入获胜区的不可控出边数（含通向禁态的边）
  uCount: number; // 可用不可控变迁总数
  goodC: boolean; // 是否存在进入获胜区的可控出边
  queued: boolean;
}

export function synthesizeInterlock(model: PetriModel, maxStates = 200_000): InterlockResult {
  const started = Date.now();
  const P = model.places.length;
  const T = model.transitions.length;
  const cap = model.places.map((p) => p.capacity);
  const acc = model.places.map((p) => p.acceptance);
  const pre = model.transitions.map((t) => t.pre);
  const post = model.transitions.map((t) => t.post);
  const controllable = model.transitions.map((t) => t.controllable === true);

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
  const delta = model.transitions.map((tr) => {
    let d = 0;
    for (let i = 0; i < P; i++) d += (tr.post[i] - tr.pre[i]) * pow4[i];
    return d;
  });

  const isAcceptanceM = (m: number[]): boolean => {
    for (let i = 0; i < P; i++) if (m[i] !== acc[i]) return false;
    return true;
  };
  const isForbiddenM = (m: number[]): boolean =>
    model.forbidden.some(
      (group) => group.length > 0 && group.every((c) => applyCmp(m[c.place], c.op, c.value)),
    );

  /** 计算标记 key 下所有可用变迁（与审计引擎同一触发语义）。 */
  const enabledAt = (key: number): Edge[] => {
    const edges: Edge[] = [];
    for (let t = 0; t < T; t++) {
      let ok = true;
      for (let i = 0; i < P; i++) {
        const mi = Math.floor(key / pow4[i]) % 4;
        if (mi < pre[t][i] || mi - pre[t][i] + post[t][i] > cap[i]) {
          ok = false;
          break;
        }
      }
      if (ok) edges.push({ t, to: key + delta[t] });
    }
    return edges;
  };

  const stats: InterlockStats = {
    states: 0,
    edges: 0,
    winningStates: 0,
    losingStates: 0,
    forbiddenStates: 0,
    maxRank: 0,
    timeMs: 0,
  };
  const finish = <R extends InterlockResult>(r: R): R => {
    stats.timeMs = Date.now() - started;
    return r;
  };

  // ---------- 阶段一：完整可达性探索（按 (深度, 序列) 均匀代价搜索） ----------
  const adj = new Map<number, Edge[]>();
  const pred = new Map<number, Edge[]>(); // 逆邻接（前驱变迁）
  const parent = new Map<number, { p: number; t: number }>();
  const depthMap = new Map<number, number>();
  const forbiddenKeys = new Set<number>();
  const acceptKeys = new Set<number>();
  const visited = new Set<number>();
  /** 按搜索出队顺序排列的所有可达标记（禁态也包含在内） */
  const order: number[] = [];

  const initKey = encode(model.places.map((p) => p.initial));
  const heap = new MinHeap<QueueEntry>(cmpEntry);
  heap.push({ key: initKey, depth: 0, seq: '', parentKey: -1, parentT: -1 });

  while (heap.size > 0) {
    const e = heap.pop();
    if (visited.has(e.key)) continue;
    visited.add(e.key);
    order.push(e.key);
    parent.set(e.key, { p: e.parentKey, t: e.parentT });
    depthMap.set(e.key, e.depth);
    stats.states++;

    const mk = decode(e.key);
    if (isForbiddenM(mk)) {
      forbiddenKeys.add(e.key);
      continue; // 禁态：失败终点，不展开
    }
    if (isAcceptanceM(mk)) {
      acceptKeys.add(e.key);
      continue; // 验收态：吸收态，不展开
    }
    if (stats.states > maxStates) {
      return finish({
        kind: 'error',
        message: `状态空间超过上限（>${maxStates} 个状态），联锁综合中止。请缩小模型规模或提高上限后重试。`,
      });
    }

    const edges = enabledAt(e.key);
    adj.set(e.key, edges);
    stats.edges += edges.length;
    for (const { t, to } of edges) {
      let pl = pred.get(to);
      if (!pl) {
        pl = [];
        pred.set(to, pl);
      }
      pl.push({ t, to: e.key });
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
  }

  // ---------- 阶段二：吸引子不动点，计算收敛层数（获胜区） ----------
  const rank = new Map<number, number>();
  for (const k of acceptKeys) rank.set(k, 0);

  const info = new Map<number, NodeInfo>();
  for (const [k, edges] of adj) {
    let uCount = 0;
    let badU = 0;
    let goodC = false;
    for (const { t, to } of edges) {
      if (controllable[t]) {
        if (rank.has(to)) goodC = true;
      } else {
        uCount++;
        if (!rank.has(to)) badU++;
      }
    }
    info.set(k, { key: k, badU, uCount, goodC, queued: false });
  }

  const eligible = (n: NodeInfo): boolean =>
    n.badU === 0 && (n.uCount > 0 || n.goodC);

  let layer: number[] = [];
  for (const n of info.values()) {
    if (eligible(n)) {
      n.queued = true;
      layer.push(n.key);
    }
  }
  let r = 0;
  while (layer.length > 0) {
    r++;
    const next: number[] = [];
    const promote = (k: number) => {
      const n = info.get(k)!;
      if (n.queued || rank.has(k)) return;
      n.queued = true;
      next.push(k);
    };
    for (const k of layer) {
      rank.set(k, r);
      // 通知所有前驱：本标记已进入获胜区第 r 层
      for (const pe of pred.get(k) ?? []) {
        if (rank.has(pe.to)) continue;
        const pn = info.get(pe.to);
        if (!pn || pn.queued) continue;
        if (controllable[pe.t]) {
          pn.goodC = true;
        } else {
          pn.badU = Math.max(0, pn.badU - 1);
        }
        if (eligible(pn)) promote(pe.to);
      }
    }
    layer = next;
  }

  // 组装策略表
  const policy = new Map<number, PolicyEntry>();
  for (const k of order) {
    const isF = forbiddenKeys.has(k);
    const rk = rank.has(k) ? rank.get(k)! : -1;
    const depth = depthMap.get(k) ?? 0;
    policy.set(k, { rank: rk, depth, forbidden: isF });
    if (isF) stats.forbiddenStates++;
    else if (rk >= 0) stats.winningStates++;
    else stats.losingStates++;
    if (rk > stats.maxRank) stats.maxRank = rk;
  }

  /** 沿父指针回溯从初始状态到 key 的最短（字典序最小）轨迹。 */
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
    let prev = cur;
    for (const { key: k2, t } of chain) {
      steps.push({ t, before: decode(prev), after: decode(k2) });
      prev = k2;
    }
    return steps;
  };

  // ---------- 阶段三：失败见证（初始标记不在获胜区） ----------
  if (!rank.has(initKey)) {
    const witness = buildWitness();
    return finish({ kind: 'failure', stats, policy, initKey, witness });
  }

  return finish({ kind: 'secured', stats, policy, initKey, initRank: rank.get(initKey)! });

  // ================= 失败见证相关 =================

  /** 在失败区域（非获胜、非禁态标记）内，从 root 出发推演最坏后果。 */
  function continuationFrom(root: number): Continuation {
    if (forbiddenKeys.has(root)) {
      return { type: 'forbidden', steps: [], cycle: [] };
    }
    // 仅限失败区域内的边：BFS 找最短的禁态 / 非验收死锁；找不到则必存在环
    const bfsHeap = new MinHeap<QueueEntry>(cmpEntry);
    const bfsParent = new Map<number, { p: number; t: number }>();
    const seen = new Set<number>([root]);
    bfsHeap.push({ key: root, depth: 0, seq: '', parentKey: -1, parentT: -1 });

    const toSteps = (target: number): Step[] => {
      const chain: { key: number; t: number }[] = [];
      let cur = target;
      for (;;) {
        const par = bfsParent.get(cur);
        if (!par || par.p < 0) break;
        chain.push({ key: cur, t: par.t });
        cur = par.p;
      }
      chain.reverse();
      const out: Step[] = [];
      let prev = cur;
      for (const { key: k2, t } of chain) {
        out.push({ t, before: decode(prev), after: decode(k2) });
        prev = k2;
      }
      return out;
    };

    while (bfsHeap.size > 0) {
      const e = bfsHeap.pop();
      if (forbiddenKeys.has(e.key)) {
        return { type: 'forbidden', steps: toSteps(e.key), cycle: [] };
      }
      const edges = adj.get(e.key) ?? [];
      if (edges.length === 0) {
        return { type: 'deadlock', steps: toSteps(e.key), cycle: [] };
      }
      for (const { t, to } of edges) {
        if (rank.has(to)) continue; // 只沿失败区域推演
        if (!seen.has(to)) {
          seen.add(to);
          bfsParent.set(to, { p: e.key, t });
          bfsHeap.push({ key: to, depth: e.depth + 1, seq: e.seq + pad2(t), parentKey: e.key, parentT: t });
        }
      }
    }

    // 失败区域有限且每个标记都有失败区域出边 ⇒ 必存在环。用迭代 DFS 找第一条回边。
    const dfs = findCycleDfs(root, seen);
    if (dfs) {
      const { ancestor, tail } = dfs;
      const prefixSteps = toSteps(ancestor);
      const cycleSteps: Step[] = [];
      let prev = ancestor;
      for (const { key: k2, t } of tail) {
        cycleSteps.push({ t, before: decode(prev), after: decode(k2) });
        prev = k2;
      }
      return { type: 'cycle', steps: prefixSteps, cycle: cycleSteps };
    }
    // 理论不可达（上面已证明必存在环）；稳妥退化为空死锁见证。
    return { type: 'deadlock', steps: [], cycle: [] };
  }

  /** 迭代 DFS：在失败区域子图中找一条回边 v→w（w 为 v 的栈上祖先），返回祖先与环尾路径。 */
  function findCycleDfs(
    root: number,
    region: Set<number>,
  ): { ancestor: number; tail: { key: number; t: number }[] } | null {
    const color = new Map<number, 0 | 1 | 2>(); // 0 未访问 1 在栈 2 完成
    const stack: { v: number; edges: Edge[]; i: number; enterT: number }[] = [];
    const start = (v: number, enterT: number) => {
      color.set(v, 1);
      stack.push({ v, edges: adj.get(v) ?? [], i: 0, enterT });
    };
    start(root, -1);
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top.i >= top.edges.length) {
        color.set(top.v, 2);
        stack.pop();
        continue;
      }
      const { t, to } = top.edges[top.i++];
      if (rank.has(to) || !region.has(to)) continue;
      const c = color.get(to) ?? 0;
      if (c === 0) {
        start(to, t);
      } else if (c === 1) {
        // 回边：to 是栈上祖先；环 = 从 to 沿 DFS 树到 top.v，再走 t 回到 to
        const idx = stack.findIndex((s) => s.v === to);
        const tail: { key: number; t: number }[] = [];
        for (let k = idx + 1; k < stack.length; k++) {
          tail.push({ key: stack[k].v, t: stack[k].enterT });
        }
        tail.push({ key: to, t }); // 回到祖先
        return { ancestor: to, tail };
      }
    }
    return null;
  }

  /**
   * 在失败区域中，从 root 出发按 (深度, 序列) 最早找到一个“危险不可控变迁”：
   * 所在标记不可控且其目标仍在失败区/禁态。找不到（纯可控死循环/死锁）返回 null。
   * pathSteps 为 root → node 的最短步骤（node === root 时为空）。
   */
  function findRootCause(root: number): { node: number; edge: Edge; pathSteps: Step[] } | null {
    const heap = new MinHeap<QueueEntry>(cmpEntry);
    const seen = new Set<number>([root]);
    const bfsParent = new Map<number, { p: number; t: number }>();
    heap.push({ key: root, depth: 0, seq: '', parentKey: -1, parentT: -1 });

    const toSteps = (target: number): Step[] => {
      const chain: { key: number; t: number }[] = [];
      let cur = target;
      for (;;) {
        const par = bfsParent.get(cur);
        if (!par) break;
        chain.push({ key: cur, t: par.t });
        cur = par.p;
      }
      chain.reverse();
      const out: Step[] = [];
      let prev = root;
      for (const { key: k2, t } of chain) {
        out.push({ t, before: decode(prev), after: decode(k2) });
        prev = k2;
      }
      return out;
    };

    while (heap.size > 0) {
      const e = heap.pop();
      // adj 中边已按变迁编号升序；BFS 出堆按 (深度, 序列)，首个命中即最早见证。
      for (const ed of adj.get(e.key) ?? []) {
        if (!controllable[ed.t] && !rank.has(ed.to)) {
          return { node: e.key, edge: ed, pathSteps: toSteps(e.key) };
        }
      }
      for (const ed of adj.get(e.key) ?? []) {
        if (rank.has(ed.to)) continue; // 只沿失败区域推演
        if (!seen.has(ed.to)) {
          seen.add(ed.to);
          bfsParent.set(ed.to, { p: e.key, t: ed.t });
          heap.push({ key: ed.to, depth: e.depth + 1, seq: e.seq + pad2(ed.t), parentKey: e.key, parentT: ed.t });
        }
      }
    }
    return null;
  }

  function buildWitness(): InterlockWitness {
    // 初始标记本身即禁态（禁态优先）
    if (forbiddenKeys.has(initKey)) {
      return {
        kind: 'forbidden',
        trace: [],
        marking: decode(initKey),
        badTransitions: [],
        continuation: null,
        rootCause: null,
      };
    }

    // 最早（按搜索序 = 深度、变迁编号序列字典序）无法受控化解的标记：
    // 任一非禁态且不在获胜区的可达标记。
    let first = -1;
    for (const k of order) {
      if (!forbiddenKeys.has(k) && !rank.has(k)) {
        first = k;
        break;
      }
    }
    if (first < 0) first = initKey;
    const k = first;
    const edges = adj.get(k) ?? [];

    // 该标记下必然发生（不可控）且无法纳入保证的变迁——这是最严重、最明确的失证原因。
    const bad: Edge[] = edges.filter((e) => !controllable[e.t] && !rank.has(e.to));
    if (bad.length > 0) {
      return {
        kind: 'uncontrollable',
        trace: buildTrace(k),
        marking: decode(k),
        badTransitions: bad.map((e) => ({
          t: e.t,
          to: decode(e.to),
          continuation: continuationFrom(e.to),
        })),
        continuation: null,
        rootCause: null,
      };
    }

    if (edges.length === 0) {
      return {
        kind: 'deadlock',
        trace: buildTrace(k),
        marking: decode(k),
        badTransitions: [],
        continuation: null,
        rootCause: null,
      };
    }

    // 无危险不可控变迁，但该标记不在获胜区：没有任何可放行的可控变迁能严格推进至验收。
    const rc = findRootCause(k);
    return {
      kind: 'trapped',
      trace: buildTrace(k),
      marking: decode(k),
      badTransitions: [],
      continuation: continuationFrom(k),
      rootCause: rc
        ? {
            t: rc.edge.t,
            to: decode(rc.edge.to),
            continuation: continuationFrom(rc.edge.to),
            leadSteps: rc.pathSteps,
          }
        : null,
    };
  }
}

// ================= 策略查询（供结果区回放 / 外部钩子使用） =================

export type DecisionStatus = 'granted' | 'denied' | 'mandatory-safe' | 'mandatory-bad' | 'disabled';

export interface Decision {
  status: DecisionStatus;
  enabled: boolean;
  controllable: boolean;
  target: number[];
  targetRank: number; // -1 = 失败区/禁态
  reason: string;
}

/**
 * 查询标记 key 下变迁 t 的联锁决定与解释。
 * 直接依据模型与策略表现场计算，触发/容量语义与审计引擎一致。
 */
export function getDecision(
  model: PetriModel,
  policy: Map<number, PolicyEntry>,
  key: number,
  t: number,
): Decision {
  const P = model.places.length;
  const cap = model.places.map((p) => p.capacity);
  const tr = model.transitions[t];
  const isC = tr.controllable === true;

  let enabled = true;
  const m: number[] = [];
  let isAcceptance = true;
  for (let i = 0; i < P; i++) {
    const mi = Math.floor(key / 4 ** i) % 4;
    m.push(mi);
    if (mi !== model.places[i].acceptance) isAcceptance = false;
    if (mi < tr.pre[i] || mi - tr.pre[i] + tr.post[i] > cap[i]) enabled = false;
  }

  // 禁态优先：当前标记即禁态时，执行已经违规，不再有放行决定。
  if (policy.get(key)?.forbidden) {
    return {
      status: 'disabled',
      enabled: false,
      controllable: isC,
      target: m.slice(),
      targetRank: -1,
      reason: '当前标记为禁态：执行已经违规，联锁策略不覆盖禁态之后的动作。',
    };
  }

  // 验收态为吸收态：到达即结束，其上的变迁不再触发（即使令牌形式上可用）。
  if (isAcceptance) {
    return {
      status: 'disabled',
      enabled: false,
      controllable: isC,
      target: m.slice(),
      targetRank: 0,
      reason: '已到达验收标记，执行为吸收结束态，不再触发任何变迁。',
    };
  }

  let toKey = key;
  for (let i = 0; i < P; i++) toKey += (tr.post[i] - tr.pre[i]) * 4 ** i;
  const target = m.map((mi, i) => mi - tr.pre[i] + tr.post[i]);
  const here = policy.get(key);
  const there = policy.get(toKey);
  const hereRank = here?.rank ?? -1;
  const targetRank = there?.rank ?? -1;

  if (!enabled) {
    return {
      status: 'disabled',
      enabled: false,
      controllable: isC,
      target,
      targetRank,
      reason: '当前标记下不可用：令牌不足，或触发后会超过库所容量。',
    };
  }

  if (!isC) {
    if (hereRank >= 0 && targetRank >= 0 && targetRank < hereRank) {
      return {
        status: 'mandatory-safe',
        enabled: true,
        controllable: false,
        target,
        targetRank,
        reason: `不可控变迁，现场一旦可用即必然发生，联锁不得拦截；其目标标记在获胜区第 ${targetRank} 层（严格推进，至多 ${targetRank} 步必达验收），已纳入保证。`,
      };
    }
    return {
      status: 'mandatory-bad',
      enabled: true,
      controllable: false,
      target,
      targetRank,
      reason:
        hereRank < 0 && targetRank >= 0
          ? '该不可控变迁本身进入获胜区，但当前标记还存在其他不可控变迁无法全部纳入保证（联锁无法选择让哪一个发生），故此标记仍无法受控化解。'
          : targetRank < 0
            ? '不可控变迁且其触发后的标记不在获胜区（可能进入禁态、非验收死锁或无限循环），联锁无法拒绝——此标记无法受控化解。'
            : '不可控变迁的目标标记未严格向验收推进，放行后存在无限执行空间，联锁无法拒绝——此标记无法受控化解。',
    };
  }

  if (hereRank < 0) {
    return {
      status: 'denied',
      enabled: true,
      controllable: true,
      target,
      targetRank,
      reason: '当前标记已在获胜区之外，联锁不能放行任何可控变迁。',
    };
  }
  if (targetRank < 0) {
    return {
      status: 'denied',
      enabled: true,
      controllable: true,
      target,
      targetRank,
      reason:
        there?.forbidden
          ? '拦截：该变迁直接进入禁态。'
          : '拦截：目标标记在获胜区之外（存在非验收死锁或无限执行），放行后无法保证到达验收。',
    };
  }
  if (targetRank >= hereRank) {
    return {
      status: 'denied',
      enabled: true,
      controllable: true,
      target,
      targetRank,
      reason: `拦截：目标标记收敛层数为 ${targetRank}，未严格小于当前层 ${hereRank}，放行不能保证严格推进至验收（存在滞留或循环空间）。`,
    };
  }
  return {
    status: 'granted',
    enabled: true,
    controllable: true,
    target,
    targetRank,
    reason: `放行：目标标记在获胜区第 ${targetRank} 层，严格低于当前层 ${hereRank}；沿放行策略每步收敛层数递减，至多 ${targetRank} 步必达验收，且不会进入禁态。`,
  };
}

/** 由标记向量求状态编码（容量 ≤ 3，每库所 2 bit；供界面在变迁间导航）。 */
export function markingKey(marking: number[]): number {
  let k = 0;
  for (let i = 0; i < marking.length; i++) k += marking[i] * 4 ** i;
  return k;
}
