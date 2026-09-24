/**
 * 联锁综合（监督控制综合）。
 *
 * 在保持既有令牌、容量、验收（吸收态）与禁态（优先判定）语义不变的前提下，
 * 从初始标记出发，计算一份**状态相关的放行策略**：
 *
 * - 变迁分为两类（TransitionSpec.controlled，缺省 true）：
 *   - 不可控变迁：现场必然发生的动作 / 自发事件，一旦可用，联锁必须放行并纳入保证；
 *   - 可控变迁：联锁可以拒绝（拦截）的操作。
 * - 为每个可达标记计算“保证界” rank（受控执行到达验收所需步数的极小化极大上界）：
 *   - 验收标记 rank = 0；
 *   - 禁态、非验收死锁 rank = ∞（永远无法受控化解）；
 *   - 若存在可用的不可控变迁，则它们**全部**必须有限，rank = 1 + max(后继 rank)；
 *   - 否则（仅可控变迁可用）至少需一条有限后继，rank = 1 + min(后继 rank)。
 *   值迭代从验收态反向松弛，求得最小固定点。
 * - 放行策略（仅对有限 rank 的安全标记）：
 *   - 不可控且可用 ⇒ 强制放行（forced）；
 *   - 可控且可用 ⇒ 当且仅当 rank(后继) < rank(当前) 时放行，即“严格推进至验收”，
 *     否则拦截（绕行不缩短保证界，放行将破坏“任意被允许执行都有限步到验收”的保证）。
 *
 * 由于每条放行边都严格减小 rank，任何被允许的执行至多 rank(初始) 步到达验收，
 * 且永远不会进入禁态；安全非验收标记也至少存在一条放行边（不会被联锁锁死）。
 * 该策略在上述保证意义下极大：所有能严格推进的可控变迁都被保留。
 *
 * 无法保证（初始标记 rank = ∞）时，沿“不可控坏边”给出最早无法受控化解的标记、
 * 该处的不可控变迁及其后果（进入禁态 / 非验收死锁 / 永久循环）。
 */
import { applyCmp, PetriModel } from './types';
import type { Step } from './audit';

export type InterlockStateStatus = 'acceptance' | 'forbidden' | 'safe' | 'losing';
export type EdgeDecision = 'forced' | 'allowed' | 'blocked';
export type FailureOutcome = 'forbidden' | 'deadlock' | 'cycle';

export interface InterlockEdgeInfo {
  /** 变迁下标 */
  t: number;
  /** 后继标记 key */
  to: number;
  uncontrolled: boolean;
  decision: EdgeDecision;
  /** 逐步解释：为什么放行 / 必放 / 拦截 */
  reason: string;
}

export interface InterlockStateInfo {
  /** BFS 可达序下标，结果区按标记查看时使用 */
  index: number;
  key: number;
  marking: number[];
  status: InterlockStateStatus;
  /** 保证界（到验收的受控步数上界）；∞ 用 null 表示 */
  rank: number | null;
  /** 该标记下所有可用变迁的联锁决策 */
  enabled: InterlockEdgeInfo[];
  /** 最短收敛见证：沿放行边到验收的变迁下标序列（验收态为空） */
  witness: number[];
  /** 在策略下（仅沿放行边）是否可从初始标记到达 */
  onPolicy: boolean;
}

export interface InterlockStats {
  states: number;
  edges: number;
  safeStates: number;
  /** 放行边数（含不可控强制放行） */
  allowedEdges: number;
  /** 其中不可控强制放行边数 */
  forcedEdges: number;
  /** 拦截边数 */
  blockedEdges: number;
  /** 初始标记的保证界：任意放行执行至多该步数到达验收 */
  initRank: number | null;
  timeMs: number;
}

export interface BlockedOption {
  t: number;
  to: number;
  summary: string;
}

export interface InterlockFailure {
  /** 后果类型：不可控事件链最终进入禁态 / 停滞为非验收死锁 / 形成永久循环 */
  outcome: FailureOutcome;
  /** 从初始标记到最早无法受控化解标记的最短、字典序最小见证（可能含被拦截的可控边） */
  trace: Step[];
  /** 最早无法受控化解的标记：此处有不可控变迁一旦可用就必然把系统带向坏后果 */
  terminalMarking: number[];
  /** 从失控标记沿不可控坏边到坏终局（禁态 / 死锁）的后果链；cycle 时为空 */
  consequence: Step[];
  /** 坏终局标记（禁态或非验收死锁标记）；cycle 时为环入口 */
  endMarking: number[];
  /** cycle 后果时的循环段（从环入口回到入口） */
  cycle: Step[];
  /** 死锁后果处被拦截的可控选项及其下游后果说明 */
  blockedOptions: BlockedOption[];
}

export type InterlockResult =
  | { kind: 'safe'; message: string; states: InterlockStateInfo[]; failure: null; stats: InterlockStats }
  | { kind: 'unsafe'; message: string; states: InterlockStateInfo[]; failure: InterlockFailure; stats: InterlockStats }
  | { kind: 'error'; message: string; states: []; failure: null; stats?: InterlockStats };

export const INTERLOCK_VERDICT_TEXT = {
  safe: '联锁综合成功：已得状态相关放行策略，任意放行执行必有限步到达验收且不进入禁态',
  unsafe: '联锁综合失败：不存在能保证安全收敛的放行策略',
  error: '联锁综合中止',
} as const;

export const STATUS_TEXT: Record<InterlockStateStatus, string> = {
  safe: '安全（策略可受控收敛）',
  acceptance: '验收标记',
  forbidden: '禁态',
  losing: '无法受控化解',
};

interface Edge {
  t: number;
  to: number;
  uncontrolled: boolean;
}

/** FIFO 队列（数组 + 游标，避免频繁 shift）。 */
class Queue<T> {
  private a: T[] = [];
  private i = 0;
  push(v: T): void {
    this.a.push(v);
  }
  pop(): T | undefined {
    if (this.i >= this.a.length) return undefined;
    const v = this.a[this.i++];
    if (this.i > 4096 && this.i * 2 >= this.a.length) {
      this.a = this.a.slice(this.i);
      this.i = 0;
    }
    return v;
  }
}

interface GreedyChain {
  outcome: FailureOutcome;
  /** 变迁下标序列（沿不可控坏边） */
  ts: number[];
  /** 途经标记 key */
  keys: number[];
  cycleStart: number;
}

export function runInterlock(model: PetriModel, maxStates = 200_000): InterlockResult {
  const started = Date.now();
  const P = model.places.length;
  const T = model.transitions.length;
  const cap = model.places.map((p) => p.capacity);
  const acc = model.places.map((p) => p.acceptance);
  const tNames = model.transitions.map((x) => x.name);
  const uncontrolled = model.transitions.map((x) => x.controlled === false);

  // 容量 ≤ 3，每个库所 2 bit，18 个库所共 36 bit，安全编码为 number。
  const pow4: number[] = [];
  for (let i = 0; i < P; i++) pow4.push(4 ** i);
  const encode = (m: number[]): number => {
    let k = 0;
    for (let i = 0; i < P; i++) k += m[i] * pow4[i];
    return k;
  };
  const decode = (k: number): number[] => {
    const arr = new Array<number>(P);
    for (let i = 0; i < P; i++) arr[i] = Math.floor(k / pow4[i]) % 4;
    return arr;
  };
  const delta = model.transitions.map((x) => {
    let d = 0;
    for (let i = 0; i < P; i++) d += (x.post[i] - x.pre[i]) * pow4[i];
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
  const fmt = (m: number[]): string => `(${m.join(', ')})`;

  // ---------- 阶段一：完整可达性（BFS：最短、同深度按变迁编号字典序） ----------
  const initMarking = model.places.map((p) => p.initial);
  const initKey = encode(initMarking);
  const order: number[] = [];
  const adj = new Map<number, Edge[]>();
  const seenReach = new Set<number>([initKey]);

  const reachQ = new Queue<number>();
  reachQ.push(initKey);
  let states = 0;
  let edgeCount = 0;
  let overLimit = false;
  const mm = new Array<number>(P);
  for (;;) {
    const key = reachQ.pop();
    if (key === undefined) break;
    order.push(key);
    states++;
    if (states > maxStates) {
      overLimit = true;
      break;
    }
    for (let i = 0; i < P; i++) mm[i] = Math.floor(key / pow4[i]) % 4;
    const forbiddenHere = isForbidden(mm);
    const acceptanceHere = !forbiddenHere && isAcceptance(mm);
    const edges: Edge[] = [];
    // 禁态（违规）与验收态（成功）都是终态，不再展开，与既有审计语义一致。
    if (!forbiddenHere && !acceptanceHere) {
      for (let t = 0; t < T; t++) {
        const tp = model.transitions[t].pre;
        const tq = model.transitions[t].post;
        let ok = true;
        for (let i = 0; i < P; i++) {
          if (mm[i] < tp[i] || mm[i] - tp[i] + tq[i] > cap[i]) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        const to = key + delta[t];
        edges.push({ t, to, uncontrolled: uncontrolled[t] });
        edgeCount++;
        if (!seenReach.has(to)) {
          seenReach.add(to);
          reachQ.push(to);
        }
      }
    }
    adj.set(key, edges);
  }

  const buildStats = (extra: Partial<InterlockStats>): InterlockStats => ({
    states,
    edges: edgeCount,
    safeStates: 0,
    allowedEdges: 0,
    forcedEdges: 0,
    blockedEdges: 0,
    initRank: null,
    timeMs: Date.now() - started,
    ...extra,
  });

  if (overLimit) {
    return {
      kind: 'error',
      message: `状态空间超过上限（>${maxStates} 个状态），联锁综合中止。请缩小模型规模或提高上限后重试。`,
      states: [],
      failure: null,
      stats: buildStats({}),
    };
  }

  const markingCache = new Map<number, number[]>();
  const markingOf = (k: number): number[] => {
    let v = markingCache.get(k);
    if (!v) {
      v = decode(k);
      markingCache.set(k, v);
    }
    return v;
  };
  const forbiddenKeys = new Set<number>();
  const acceptanceKeys = new Set<number>();
  for (const k of order) {
    const m = markingOf(k);
    if (isForbidden(m)) forbiddenKeys.add(k);
    else if (isAcceptance(m)) acceptanceKeys.add(k);
  }

  // ---------- 阶段二：保证界 rank 的反向松弛（极小化极大值迭代） ----------
  const rank = new Map<number, number>();
  const relaxQ = new Queue<number>();
  const inQueue = new Set<number>();
  for (const k of acceptanceKeys) {
    rank.set(k, 0);
    relaxQ.push(k);
    inQueue.add(k);
  }
  const enqueue = (k: number): void => {
    if (!inQueue.has(k)) {
      inQueue.add(k);
      relaxQ.push(k);
    }
  };

  // 逆邻接（仅含可达边）。
  const pred = new Map<number, number[]>();
  for (const k of order) {
    for (const e of adj.get(k) ?? []) {
      let l = pred.get(e.to);
      if (!l) {
        l = [];
        pred.set(e.to, l);
      }
      l.push(k);
    }
  }

  const candidate = (s: number): number => {
    let forcedMax = -1;
    let forcedCount = 0;
    let forcedBad = false;
    let ctrlMin = Infinity;
    for (const e of adj.get(s) ?? []) {
      const r = rank.has(e.to) ? rank.get(e.to)! : Infinity;
      if (e.uncontrolled) {
        forcedCount++;
        if (r === Infinity) forcedBad = true;
        else if (r > forcedMax) forcedMax = r;
      } else if (r < ctrlMin) {
        ctrlMin = r;
      }
    }
    if (forcedCount > 0) {
      // 不可控变迁一旦可用就必然发生：必须全部有限，界取最长的那条
      return forcedBad ? Infinity : 1 + forcedMax;
    }
    // 没有不可控变迁时，联锁保留至少一条严格推进的可控出路即可
    return ctrlMin === Infinity ? Infinity : 1 + ctrlMin;
  };

  for (;;) {
    const w = relaxQ.pop();
    if (w === undefined) break;
    inQueue.delete(w);
    for (const s of pred.get(w) ?? []) {
      if (forbiddenKeys.has(s) || acceptanceKeys.has(s)) continue;
      const v = candidate(s);
      if (v !== Infinity && (!rank.has(s) || v < rank.get(s)!)) {
        rank.set(s, v);
        enqueue(s);
      }
    }
  }

  // ---------- 失败根因辅助 ----------
  const inLosingRegion = (k: number): boolean => forbiddenKeys.has(k) || !rank.has(k);
  /** 坏边：失败状态上后继同样无有限保证界的不可控可用边。 */
  const badEdges = (k: number): Edge[] =>
    (adj.get(k) ?? []).filter((e) => e.uncontrolled && inLosingRegion(e.to));
  /**
   * 失控图边：失控状态（rank∞）上落入失控区域 / 禁态的全部边。
   * 不可控边是环境可强制的；可控边虽会被联锁拦截，但用于还原
   * “联锁拦截 → 停滞 / 与不可控事件交替成环”的完整后果。
   */
  const losingEdges = (k: number): Edge[] =>
    (adj.get(k) ?? []).filter((e) => inLosingRegion(e.to));

  /** 贪心沿最坏边下滑（不可控优先、编号最小，带循环检测），用于选项级后果说明。 */
  const greedyCache = new Map<number, GreedyChain>();
  const greedy = (start: number): GreedyChain => {
    const cached = greedyCache.get(start);
    if (cached) return cached;
    const keys = [start];
    const ts: number[] = [];
    const pos = new Map<number, number>([[start, 0]]);
    let outcome: FailureOutcome;
    let cycleStart = -1;
    let cur = start;
    for (;;) {
      if (forbiddenKeys.has(cur)) {
        outcome = 'forbidden';
        break;
      }
      const edges = losingEdges(cur).sort((a, b) =>
        a.uncontrolled === b.uncontrolled ? a.t - b.t : a.uncontrolled ? -1 : 1,
      );
      if (edges.length === 0) {
        outcome = 'deadlock';
        break;
      }
      const e = edges[0];
      const at = pos.get(e.to);
      if (at !== undefined) {
        outcome = 'cycle';
        cycleStart = at;
        ts.push(e.t);
        keys.push(e.to);
        break;
      }
      pos.set(e.to, keys.length);
      keys.push(e.to);
      ts.push(e.t);
      cur = e.to;
    }
    const chain: GreedyChain = { outcome, ts, keys, cycleStart };
    greedyCache.set(start, chain);
    return chain;
  };

  const chainSummary = (start: number): string => {
    const g = greedy(start);
    const termKey = g.keys[g.keys.length - 1];
    const labelT = (x: number): string =>
      `T${x + 1}「${tNames[x]}」${uncontrolled[x] ? '（不可控）' : ''}`;
    const prefix =
      g.ts.length > 0
        ? `${g.ts.map(labelT).join(' → ')} 依次发生，`
        : '';
    if (g.outcome === 'forbidden') {
      return `${prefix}${g.ts.length} 步后进入禁态 ${fmt(markingOf(termKey))}`;
    }
    if (g.outcome === 'deadlock') {
      return `${prefix}联锁只能拦截可控变迁，停滞为非验收死锁 ${fmt(markingOf(termKey))}`;
    }
    const cyc = g.ts.slice(g.cycleStart);
    return `${cyc.map(labelT).join(' → ')} 与不可控事件交替反复触发形成永久循环，永不到达验收`;
  };

  const toSteps = (keys: number[], ts: number[]): Step[] => {
    const out: Step[] = [];
    for (let i = 0; i < ts.length; i++) {
      out.push({ t: ts[i], before: markingOf(keys[i]), after: markingOf(keys[i + 1]) });
    }
    return out;
  };

  /**
   * 失败根因（两级搜索）：
   * 1. 在失控区域（禁态 / rank∞）内沿全部边 BFS，找最早的“危险标记”：
   *    禁态、或带有不可控坏边的标记、或无路可走的死路；
   * 2. 从危险标记沿不可控坏边分析必然后果：禁态 / 非验收死锁 / 永久循环。
   */
  const buildFailure = (rootKey: number): InterlockFailure => {
    const inLosingRegion = (k: number): boolean => forbiddenKeys.has(k) || !rank.has(k);
    const parent = new Map<number, { p: number; t: number }>();
    const dist = new Map<number, number>([[rootKey, 0]]);
    const seen = new Set<number>([rootKey]);
    const q = new Queue<number>();
    q.push(rootKey);

    // 完整遍历失控区域，记录各严重度最早（距离最短、同级按 BFS 字典序）候选
    let firstForbidden: number | null = null;
    let firstBad: number | null = null;
    let firstDead: number | null = null;
    for (;;) {
      const k = q.pop();
      if (k === undefined) break;
      const edges = adj.get(k) ?? [];
      if (forbiddenKeys.has(k)) {
        if (firstForbidden === null) firstForbidden = k;
        continue; // 禁态是终态，不再展开
      }
      if (badEdges(k).length > 0) {
        if (firstBad === null) firstBad = k;
      } else if (edges.length === 0) {
        if (firstDead === null) firstDead = k;
      }
      // 失控状态沿同样落入失控区域的边继续（可控边会被联锁拦截，但用于定位危险点）
      for (const e of edges.sort((a, b) => a.t - b.t)) {
        if (inLosingRegion(e.to) && !seen.has(e.to)) {
          seen.add(e.to);
          dist.set(e.to, dist.get(k)! + 1);
          parent.set(e.to, { p: k, t: e.t });
          q.push(e.to);
        }
      }
    }

    // 严重度优先：禁态（直接违规）＞ 不可控坏边危险点 ＞ 纯死路；同级取距离最短
    type DangerKind = 'forbidden' | 'badedge' | 'deadend';
    let danger: number;
    let dangerKind: DangerKind;
    if (
      firstForbidden !== null &&
      (firstBad === null || dist.get(firstForbidden)! <= dist.get(firstBad)!) &&
      (firstDead === null || dist.get(firstForbidden)! <= dist.get(firstDead)!)
    ) {
      danger = firstForbidden;
      dangerKind = 'forbidden';
    } else if (firstBad !== null && (firstDead === null || dist.get(firstBad)! <= dist.get(firstDead)!)) {
      danger = firstBad;
      dangerKind = 'badedge';
    } else {
      danger = firstDead!;
      dangerKind = 'deadend';
    }

    const prefixSteps = (target: number): Step[] => {
      const rev: Step[] = [];
      let cur = target;
      while (cur !== rootKey) {
        const par = parent.get(cur)!;
        rev.push({ t: par.t, before: markingOf(par.p), after: markingOf(cur) });
        cur = par.p;
      }
      rev.reverse();
      return rev;
    };

    // 初始 / 最早标记即禁态，或直接就是无出路死锁
    if (dangerKind === 'forbidden') {
      return {
        outcome: 'forbidden',
        trace: prefixSteps(danger!),
        consequence: [],
        cycle: [],
        terminalMarking: markingOf(danger!),
        endMarking: markingOf(danger!),
        blockedOptions: [],
      };
    }
    if (dangerKind === 'deadend') {
      return {
        outcome: 'deadlock',
        trace: prefixSteps(danger!),
        consequence: [],
        cycle: [],
        terminalMarking: markingOf(danger!),
        endMarking: markingOf(danger!),
        blockedOptions: [],
      };
    }

    // dangerKind === 'badedge'：沿不可控坏边求必然后果
    const dangerKey = danger!;
    const trace = prefixSteps(dangerKey);
    const bParent = new Map<number, { p: number; t: number }>();
    const bDist = new Map<number, number>([[dangerKey, 0]]);
    const bq = new Queue<number>();
    bq.push(dangerKey);
    let terminal: number | null = null;
    for (;;) {
      const k = bq.pop();
      if (k === undefined) break;
      const bad = badEdges(k);
      if (forbiddenKeys.has(k) && k !== dangerKey) {
        terminal = k;
        break;
      }
      if (bad.length === 0) {
        if (k !== dangerKey) {
          terminal = k;
          break;
        }
      }
      for (const e of bad.sort((a, b) => a.t - b.t)) {
        if (!bDist.has(e.to)) {
          bDist.set(e.to, bDist.get(k)! + 1);
          bParent.set(e.to, { p: k, t: e.t });
          bq.push(e.to);
        }
      }
    }

    const consSteps = (target: number): Step[] => {
      const rev: Step[] = [];
      let cur = target;
      while (cur !== dangerKey) {
        const par = bParent.get(cur)!;
        rev.push({ t: par.t, before: markingOf(par.p), after: markingOf(cur) });
        cur = par.p;
      }
      rev.reverse();
      return rev;
    };

    if (terminal !== null) {
      const outcome: FailureOutcome = forbiddenKeys.has(terminal) ? 'forbidden' : 'deadlock';
      // 死锁后果处：不可控链结束，只剩会被联锁拦截的可控出路
      const blockedOptions: BlockedOption[] =
        outcome === 'deadlock'
          ? (adj.get(terminal) ?? [])
              .filter((e) => !e.uncontrolled && inLosingRegion(e.to))
              .sort((a, b) => a.t - b.t)
              .map((e) => ({ t: e.t, to: e.to, summary: chainSummary(e.to) }))
          : [];
      return {
        outcome,
        trace,
        consequence: consSteps(terminal),
        cycle: [],
        terminalMarking: markingOf(dangerKey),
        endMarking: markingOf(terminal),
        blockedOptions,
      };
    }

    // 坏边图无终局：有限图必有环 —— 前缀最短、循环最短、字典序最优套索
    const reach = new Set(bDist.keys());
    const onCycle = cycleStates(reach, badEdges);
    let best: { entry: number; cyc: { ts: number[]; keys: number[] } } | null = null;
    for (const entry of [...onCycle].sort((a, b) => bDist.get(a)! - bDist.get(b)!)) {
      if (best && bDist.get(entry)! > bDist.get(best.entry)!) break;
      const cyc = shortestCycleBack(entry, badEdges);
      if (!cyc) continue;
      if (
        !best ||
        cyc.ts.length < best.cyc.ts.length ||
        (cyc.ts.length === best.cyc.ts.length &&
          cyc.ts.map((x) => String(x).padStart(2, '0')).join('') <
            best.cyc.ts.map((x) => String(x).padStart(2, '0')).join(''))
      ) {
        best = { entry, cyc };
      }
    }
    const b = best!;
    return {
      outcome: 'cycle',
      trace,
      consequence: consSteps(b.entry),
      cycle: toSteps([b.entry, ...b.cyc.keys], b.cyc.ts),
      terminalMarking: markingOf(dangerKey),
      endMarking: markingOf(b.entry),
      blockedOptions: [],
    };
  };

  // ---------- 阶段三：组装逐标记策略 ----------
  const stateInfos: InterlockStateInfo[] = order.map(
    () => null as unknown as InterlockStateInfo,
  );
  const indexByKey = new Map<number, number>();
  order.forEach((k, i) => indexByKey.set(k, i));

  let safeStates = 0;
  let allowedEdges = 0;
  let forcedEdges = 0;
  let blockedEdges = 0;

  for (const k of order) {
    const i = indexByKey.get(k)!;
    const mk = markingOf(k);
    const isF = forbiddenKeys.has(k);
    const isA = acceptanceKeys.has(k);
    const r = rank.has(k) ? rank.get(k)! : null;
    const status: InterlockStateStatus = isF
      ? 'forbidden'
      : isA
        ? 'acceptance'
        : r === null
          ? 'losing'
          : 'safe';
    if (status === 'safe') safeStates++;

    const enabled: InterlockEdgeInfo[] = [];
    if (!isF && !isA) {
      for (const e of adj.get(k) ?? []) {
        const rt = rank.has(e.to) ? rank.get(e.to)! : null;
        let decision: EdgeDecision;
        let reason: string;
        if (e.uncontrolled) {
          decision = 'forced';
          forcedEdges++;
          if (r !== null && rt !== null && rt < r) {
            reason = `不可控变迁（现场必然发生），可用即必须放行；后继保证界 ${rt} < 当前 ${r}，放行后仍严格推进至验收`;
          } else {
            reason = `不可控变迁（现场必然发生），联锁无法拦截；${chainSummary(e.to)}`;
          }
        } else if (r !== null && rt !== null && rt < r) {
          decision = 'allowed';
          allowedEdges++;
          reason = `可控且后继保证界 ${rt} < 当前 ${r}：放行后仍可在 ${rt} 步内受控到达验收，严格推进`;
        } else {
          decision = 'blocked';
          blockedEdges++;
          if (r === null) {
            reason =
              rt === null
                ? `可控但后继标记 ${fmt(markingOf(e.to))} 无法受控化解（${chainSummary(e.to)}）；当前标记本身已无收敛保证，联锁锁闭，放行将破坏保证`
                : `当前标记已无法受控化解（不可控事件可能先发生），即便该可控变迁可达验收也不能放行，联锁拦截`;
          } else {
            reason = `可控但后继保证界 ${rt} ≥ 当前 ${r}，不能严格推进（放行会留下不收敛的绕行 / 循环），联锁拦截`;
          }
        }
        enabled.push({ t: e.t, to: e.to, uncontrolled: e.uncontrolled, decision, reason });
      }
    }

    // 最短收敛见证：沿“后继界最小、变迁编号最小”的放行边下行
    const witness: number[] = [];
    if (status === 'safe') {
      let cur = k;
      const guard = new Set<number>();
      while (!acceptanceKeys.has(cur) && !guard.has(cur)) {
        guard.add(cur);
        let bestE: Edge | null = null;
        let bestR = Infinity;
        for (const e of adj.get(cur) ?? []) {
          const er = rank.get(e.to);
          if (er === undefined || er >= rank.get(cur)!) continue; // 仅放行边
          if (bestE === null || er < bestR || (er === bestR && e.t < bestE.t)) {
            bestE = e;
            bestR = er;
          }
        }
        if (!bestE) break;
        witness.push(bestE.t);
        cur = bestE.to;
      }
    }

    stateInfos[i] = {
      index: i,
      key: k,
      marking: mk,
      status,
      rank: r,
      enabled,
      witness,
      onPolicy: false,
    };
  }

  // 策略可达性：从初始标记仅沿放行边传播
  if (rank.has(initKey) && !forbiddenKeys.has(initKey)) {
    const polQ = new Queue<number>();
    polQ.push(initKey);
    const polSeen = new Set<number>([initKey]);
    for (;;) {
      const k = polQ.pop();
      if (k === undefined) break;
      const info = stateInfos[indexByKey.get(k)!];
      info.onPolicy = true;
      for (const e of info.enabled) {
        if (e.decision === 'blocked' || polSeen.has(e.to)) continue;
        polSeen.add(e.to);
        polQ.push(e.to);
      }
    }
  }

  const stats = buildStats({
    safeStates,
    allowedEdges,
    forcedEdges,
    blockedEdges,
    initRank: rank.has(initKey) ? rank.get(initKey)! : null,
  });

  // ---------- 初始标记无法保证：根因报告 ----------
  if (forbiddenKeys.has(initKey) || !rank.has(initKey)) {
    const failure = buildFailure(initKey);
    const head =
      failure.consequence.length === 0 && failure.trace.length === 0
        ? failure.outcome === 'forbidden'
          ? `初始标记 ${fmt(initMarking)} 本身即禁态，任何策略都无法消除违规。`
          : `初始标记 ${fmt(initMarking)} 即是非验收死路，任何放行策略都无法到达验收。`
        : failure.outcome === 'forbidden'
          ? `最早无法受控化解的标记 ${fmt(failure.terminalMarking)}：此处的不可控变迁一旦可用必然触发（${failure.consequence.map((s) => `T${s.t + 1}`).join(' → ') || '直接进入'}），${failure.consequence.length} 步后进入禁态 ${fmt(failure.endMarking)}，联锁无法拒绝。`
          : failure.outcome === 'cycle'
            ? `最早无法受控化解的标记 ${fmt(failure.terminalMarking)}：不可控变迁可反复触发形成永久循环，永不到达验收，联锁无法拒绝。`
            : `最早无法受控化解的标记 ${fmt(failure.terminalMarking)}：联锁只能拦截全部可控出路，形成非验收死锁。`;
    return { kind: 'unsafe', message: head, states: stateInfos, failure, stats };
  }

  return {
    kind: 'safe',
    message: `初始标记 ${fmt(initMarking)} 的保证界为 ${rank.get(initKey)!}：策略下任意放行执行至多 ${rank.get(initKey)!} 步到达验收 ${fmt(acc)}，且全程不进入禁态。`,
    states: stateInfos,
    failure: null,
    stats,
  };
}

/** 迭代 Kosaraju：返回坏边图中位于环上的状态集合（含自环）。 */
function cycleStates(nodes: Set<number>, edgesOf: (k: number) => Edge[]): Set<number> {
  const done = new Set<number>();
  const order: number[] = [];
  for (const s of nodes) {
    if (done.has(s)) continue;
    const stack: { v: number; i: number }[] = [{ v: s, i: 0 }];
    done.add(s);
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const es = edgesOf(top.v);
      if (top.i < es.length) {
        const nxt = es[top.i++].to;
        if (nodes.has(nxt) && !done.has(nxt)) {
          done.add(nxt);
          stack.push({ v: nxt, i: 0 });
        }
      } else {
        order.push(top.v);
        stack.pop();
      }
    }
  }
  const rev = new Map<number, number[]>();
  for (const u of nodes) {
    for (const e of edgesOf(u)) {
      if (!nodes.has(e.to)) continue;
      let l = rev.get(e.to);
      if (!l) {
        l = [];
        rev.set(e.to, l);
      }
      l.push(u);
    }
  }
  const result = new Set<number>();
  const seen = new Set<number>();
  for (let oi = order.length - 1; oi >= 0; oi--) {
    const s = order[oi];
    if (seen.has(s)) continue;
    const comp: number[] = [];
    const st = [s];
    seen.add(s);
    while (st.length > 0) {
      const v = st.pop()!;
      comp.push(v);
      for (const w of rev.get(v) ?? []) {
        if (!seen.has(w)) {
          seen.add(w);
          st.push(w);
        }
      }
    }
    if (comp.length > 1) {
      for (const v of comp) result.add(v);
    } else if (edgesOf(comp[0]).some((e) => e.to === comp[0])) {
      result.add(comp[0]);
    }
  }
  return result;
}

/** 从 s 出发沿坏边回到 s 的最短环（等长取变迁编号字典序最小），返回环上变迁与途经 key（不含 s）。 */
function shortestCycleBack(
  s: number,
  edgesOf: (k: number) => Edge[],
): { ts: number[]; keys: number[] } | null {
  interface E {
    key: number;
    depth: number;
    seq: string;
    parentKey: number;
    parentT: number;
  }
  const q: E[] = [];
  let head = 0;
  const seen = new Set<number>();
  const parent = new Map<number, { p: number; t: number }>();
  for (const e of edgesOf(s)) {
    q.push({ key: e.to, depth: 1, seq: String(e.t).padStart(2, '0'), parentKey: s, parentT: e.t });
  }
  let best: E | null = null;
  while (head < q.length) {
    const e = q[head++];
    if (best && e.depth > best.depth) break;
    if (e.key !== s) {
      if (seen.has(e.key)) continue;
      seen.add(e.key);
    } else if (parent.has(s)) {
      continue; // 回到 s 的命中按（深度、序列）有序，首个即最优，其父子链不可被覆盖
    }
    parent.set(e.key, { p: e.parentKey, t: e.parentT });
    if (e.key === s) {
      best = e;
      continue;
    }
    for (const nx of edgesOf(e.key).sort((a, b) => a.t - b.t)) {
      if (!seen.has(nx.to)) {
        q.push({
          key: nx.to,
          depth: e.depth + 1,
          seq: e.seq + String(nx.t).padStart(2, '0'),
          parentKey: e.key,
          parentT: nx.t,
        });
      }
    }
  }
  if (!best) return null;
  const tsRev: number[] = [];
  const keysRev: number[] = [];
  let cur = s;
  for (;;) {
    const par = parent.get(cur)!;
    tsRev.push(par.t);
    keysRev.push(cur);
    if (par.p === s) break;
    cur = par.p;
  }
  tsRev.reverse();
  keysRev.reverse();
  return { ts: tsRev, keys: keysRev };
}
