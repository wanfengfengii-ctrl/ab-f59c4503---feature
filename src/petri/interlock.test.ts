import { describe, expect, it } from 'vitest';
import { getDecision, markingKey, synthesizeInterlock } from './interlock';
import { SAMPLES } from './samples';
import { hasControllability, validateModel } from './validate';
import { PetriModel } from './types';

const p = (name: string, capacity: number, initial: number, acceptance: number) => ({
  name,
  capacity,
  initial,
  acceptance,
});
const t = (name: string, pre: number[], post: number[], controllable?: boolean) => ({
  name,
  pre,
  post,
  ...(controllable === undefined ? {} : { controllable }),
});

const sample = (key: string) => SAMPLES.find((s) => s.key === key)!.model;

/** 沿策略自动推演（每步选编号最小的允许变迁），返回经过的标记与变迁。 */
function simulate(model: PetriModel, res: ReturnType<typeof synthesizeInterlock>, maxSteps = 1000) {
  if (res.kind === 'error') throw new Error('engine error: ' + res.message);
  const keyOf = (m: number[]) => markingKey(m);
  let key = res.initKey;
  const fired: number[] = [];
  for (let i = 0; i < maxSteps; i++) {
    let pick = -1;
    for (let tt = 0; tt < model.transitions.length; tt++) {
      const d = getDecision(model, res.policy, key, tt);
      if (d.status === 'granted' || d.status === 'mandatory-safe') {
        pick = tt;
        break;
      }
    }
    if (pick < 0) return { key, fired, accepted: res.policy.get(key)?.rank === 0 };
    fired.push(pick);
    const d = getDecision(model, res.policy, key, pick);
    key = keyOf(d.target);
  }
  throw new Error('simulation did not terminate');
}

/** 暴力验证：从 m 出发，只走 granted/mandatory-safe 的边，所有最长路径都在有限步到验收、不进禁态。 */
function assertPolicySound(
  model: PetriModel,
  res: Extract<ReturnType<typeof synthesizeInterlock>, { kind: 'secured' }>,
) {
  const visit = (key: number, seen: Set<number>): void => {
    const e = res.policy.get(key)!;
    expect(e.forbidden).toBe(false);
    if (e.rank === 0) return;
    expect(seen.has(key)).toBe(false); // 无环 ⇒ 所有允许执行有限
    seen.add(key);
    for (let tt = 0; tt < model.transitions.length; tt++) {
      const d = getDecision(model, res.policy, key, tt);
      if (d.status === 'granted' || d.status === 'mandatory-safe') {
        expect(d.targetRank).toBeGreaterThanOrEqual(0);
        expect(d.targetRank).toBeLessThan(e.rank); // 严格推进
        visit(markingKey(d.target), seen);
      }
    }
    seen.delete(key);
  };
  visit(res.initKey, new Set());
}

describe('旧模型兼容：未填写可控属性时不改变校验结果', () => {
  for (const key of ['sequential', 'deadlock', 'forbidden', 'lasso', 'pipeline']) {
    it(`内置示例 ${key} 均未填写可控属性`, () => {
      expect(hasControllability(sample(key))).toBe(false);
    });
  }

  it('旧 JSON（无 controllable 字段）规范化后仍为 undefined', () => {
    const raw = {
      places: [
        { name: 'a', capacity: 1, initial: 1, acceptance: 0 },
        { name: 'b', capacity: 1, initial: 0, acceptance: 1 },
      ],
      transitions: [{ name: 'go', pre: [1, 0], post: [0, 1] }],
      forbidden: [],
    };
    const { errors, model } = validateModel(raw);
    expect(errors).toEqual([]);
    expect(model!.transitions[0].controllable).toBeUndefined();
    expect(hasControllability(model!)).toBe(false);
  });

  it('controllable 非布尔值被校验拒绝', () => {
    const { errors } = validateModel({
      places: [
        { name: 'a', capacity: 1, initial: 1, acceptance: 0 },
        { name: 'b', capacity: 1, initial: 0, acceptance: 1 },
      ],
      transitions: [{ name: 'go', pre: [1, 0], post: [0, 1], controllable: 'yes' }],
      forbidden: [],
    });
    expect(errors.some((e) => e.includes('controllable'))).toBe(true);
  });
});

describe('联锁综合：可保证', () => {
  it('自动完工（不可控）+ 手动排空（可控致死锁）：拦截排空，其余放行', () => {
    const m = sample('il-safe');
    const r = synthesizeInterlock(m);
    expect(r.kind).toBe('secured');
    if (r.kind !== 'secured') return;
    expect(r.initRank).toBe(2);

    const s = markingKey([1, 0, 0, 0]);
    const w = markingKey([0, 1, 0, 0]);
    expect(getDecision(m, r.policy, s, 0).status).toBe('granted'); // 开始加工
    expect(getDecision(m, r.policy, s, 2).status).toBe('denied'); // 手动排空 → 死锁
    expect(getDecision(m, r.policy, w, 1).status).toBe('mandatory-safe'); // 自动完工必发生

    const sim = simulate(m, r);
    expect(sim.accepted).toBe(true);
    assertPolicySound(m, r);
  });

  it('双工位选择：两条严格推进路径都放行（最大宽容），回退被拦截', () => {
    const m = sample('il-choice');
    const r = synthesizeInterlock(m);
    expect(r.kind).toBe('secured');
    if (r.kind !== 'secured') return;
    const s = markingKey([1, 0, 0, 0]);
    expect(getDecision(m, r.policy, s, 0).status).toBe('granted'); // 选A
    expect(getDecision(m, r.policy, s, 1).status).toBe('granted'); // 选B
    const a = markingKey([0, 1, 0, 0]);
    expect(getDecision(m, r.policy, a, 4).status).toBe('denied'); // 回退到更高层
    expect(getDecision(m, r.policy, a, 2).status).toBe('granted'); // A完工
    assertPolicySound(m, r);
  });

  it('纯可控但存在非验收死锁分支：策略只放行通向验收的变迁', () => {
    const m: PetriModel = {
      places: [p('s', 1, 1, 0), p('ok', 1, 0, 1), p('bad', 1, 0, 0)],
      transitions: [
        t('finish', [1, 0, 0], [0, 1, 0], true),
        t('spoil', [1, 0, 0], [0, 0, 1], true), // 非验收死锁
      ],
      forbidden: [],
    };
    const r = synthesizeInterlock(m);
    expect(r.kind).toBe('secured');
    if (r.kind !== 'secured') return;
    const s = markingKey([1, 0, 0]);
    expect(getDecision(m, r.policy, s, 0).status).toBe('granted');
    expect(getDecision(m, r.policy, s, 1).status).toBe('denied');
    assertPolicySound(m, r);
  });

  it('可控循环不进入获胜区：唯一循环路径被拦截，但不影响可保证性（从初始态）', () => {
    // s 可控 T0→f（验收），可控 T1→a；a 有自环 T2（可控）。s 可保证；a 为失败区（会无限循环）。
    const m: PetriModel = {
      places: [p('s', 1, 1, 0), p('f', 1, 0, 1), p('a', 1, 0, 0)],
      transitions: [
        t('finish', [1, 0, 0], [0, 1, 0], true),
        t('go-a', [1, 0, 0], [0, 0, 1], true),
        t('loop-a', [0, 0, 1], [0, 0, 1], true),
      ],
      forbidden: [],
    };
    const r = synthesizeInterlock(m);
    expect(r.kind).toBe('secured');
    if (r.kind !== 'secured') return;
    const s = markingKey([1, 0, 0]);
    expect(getDecision(m, r.policy, s, 0).status).toBe('granted');
    expect(getDecision(m, r.policy, s, 1).status).toBe('denied');
    assertPolicySound(m, r);
  });

  it('不可控变迁把标记带入可控循环区：策略仍可保证（不可控边严格降层）', () => {
    // s: 不可控 T0→w；w: 可控 T1→f、可控 T2→w（自环）。
    const m: PetriModel = {
      places: [p('s', 1, 1, 0), p('w', 1, 0, 0), p('f', 1, 0, 1)],
      transitions: [
        t('auto', [1, 0, 0], [0, 1, 0], false),
        t('finish', [0, 1, 0], [0, 0, 1], true),
        t('spin', [0, 1, 0], [0, 1, 0], true),
      ],
      forbidden: [],
    };
    const r = synthesizeInterlock(m);
    expect(r.kind).toBe('secured');
    if (r.kind !== 'secured') return;
    const w = markingKey([0, 1, 0]);
    expect(getDecision(m, r.policy, w, 1).status).toBe('granted');
    expect(getDecision(m, r.policy, w, 2).status).toBe('denied'); // 自环不严格推进
    assertPolicySound(m, r);
  });
});

describe('联锁综合：无法保证时的最早见证', () => {
  it('初始态即有不可控变迁进入禁态', () => {
    const m = sample('il-uncontrollable');
    const r = synthesizeInterlock(m);
    expect(r.kind).toBe('failure');
    if (r.kind !== 'failure') return;
    expect(r.witness.kind).toBe('uncontrollable');
    expect(r.witness.trace).toEqual([]); // 最早标记即初始标记
    expect(r.witness.marking).toEqual([1, 0, 0, 0]);
    const bad = r.witness.badTransitions;
    expect(bad.map((b) => b.t)).toContain(2); // 突发超压
    const sup = bad.find((b) => b.t === 2)!;
    expect(sup.to).toEqual([0, 0, 0, 1]);
    expect(sup.continuation.type).toBe('forbidden');
  });

  it('不可控分支经若干步进入非验收死锁：给出标记、变迁与后果轨迹', () => {
    // s 不可控 T0→a；a 不可控 T1→x（死锁）；另有可控 T2 s→f。
    const m: PetriModel = {
      places: [p('s', 1, 1, 0), p('a', 1, 0, 0), p('x', 1, 0, 0), p('f', 1, 0, 1)],
      transitions: [
        t('e1', [1, 0, 0, 0], [0, 1, 0, 0], false),
        t('e2', [0, 1, 0, 0], [0, 0, 1, 0], false),
        t('ok', [1, 0, 0, 0], [0, 0, 0, 1], true),
      ],
      forbidden: [],
    };
    const r = synthesizeInterlock(m);
    expect(r.kind).toBe('failure');
    if (r.kind !== 'failure') return;
    expect(r.witness.kind).toBe('uncontrollable');
    expect(r.witness.marking).toEqual([1, 0, 0, 0]);
    const b = r.witness.badTransitions.find((x) => x.t === 0)!;
    expect(b.continuation.type).toBe('deadlock');
    expect(b.continuation.steps.map((s) => s.t)).toEqual([1]);
  });

  it('不可控变迁进入无限循环：后果见证包含循环段', () => {
    // s 不可控 T0→a；a 不可控 T1→b；b 不可控 T2→a（环）。无验收可达。
    const m: PetriModel = {
      places: [
        p('s', 1, 1, 0),
        p('a', 1, 0, 0),
        p('b', 1, 0, 0),
        p('f', 1, 0, 1),
      ],
      transitions: [
        t('e0', [1, 0, 0, 0], [0, 1, 0, 0], false),
        t('e1', [0, 1, 0, 0], [0, 0, 1, 0], false),
        t('e2', [0, 0, 1, 0], [0, 1, 0, 0], false),
      ],
      forbidden: [],
    };
    const r = synthesizeInterlock(m);
    expect(r.kind).toBe('failure');
    if (r.kind !== 'failure') return;
    const b = r.witness.badTransitions.find((x) => x.t === 0)!;
    expect(b.continuation.type).toBe('cycle');
    expect(b.continuation.cycle.length).toBe(2);
  });

  it('纯不可控线性流程通向非验收死锁：标记即受困/不可控失败', () => {
    const m: PetriModel = {
      places: [p('s', 1, 1, 0), p('x', 1, 0, 0), p('f', 1, 0, 1)],
      transitions: [t('drift', [1, 0, 0], [0, 1, 0], false)],
      forbidden: [],
    };
    const r = synthesizeInterlock(m);
    expect(r.kind).toBe('failure');
    if (r.kind !== 'failure') return;
    expect(['uncontrollable', 'trapped']).toContain(r.witness.kind);
  });

  it('初始标记即禁态：0 步失败见证', () => {
    const m: PetriModel = {
      places: [p('a', 1, 1, 0), p('b', 1, 0, 1)],
      transitions: [t('go', [1, 0], [0, 1], true)],
      forbidden: [[{ place: 0, op: 'ge', value: 1 }]],
    };
    const r = synthesizeInterlock(m);
    expect(r.kind).toBe('failure');
    if (r.kind !== 'failure') return;
    expect(r.witness.kind).toBe('forbidden');
    expect(r.witness.trace).toEqual([]);
  });

  it('安全前缀之后出现不可控故障：最早失败标记取深度最小者', () => {
    // s 可控 T0→w；w 有不可控 T1→o（禁态）、可控 T2→f。
    const m: PetriModel = {
      places: [p('s', 1, 1, 0), p('w', 1, 0, 0), p('o', 1, 0, 0), p('f', 1, 0, 1)],
      transitions: [
        t('start', [1, 0, 0, 0], [0, 1, 0, 0], true),
        t('fault', [0, 1, 0, 0], [0, 0, 1, 0], false),
        t('done', [0, 1, 0, 0], [0, 0, 0, 1], true),
      ],
      forbidden: [[{ place: 2, op: 'ge', value: 1 }]],
    };
    const r = synthesizeInterlock(m);
    expect(r.kind).toBe('failure');
    if (r.kind !== 'failure') return;
    // s 本身可控边 T0 通向失败区 w，s 亦不在获胜区；最早失败标记为 s（深度 0，无坏不可控边，受困）
    expect(r.witness.marking).toEqual([1, 0, 0, 0]);
    expect(r.witness.trace.map((x) => x.t)).toEqual([]);
  });
});

describe('联锁综合：统计与策略表', () => {
  it('获胜/失败/禁态状态计数与层数', () => {
    const m: PetriModel = {
      places: [p('s', 1, 1, 0), p('f', 1, 0, 1), p('x', 1, 0, 0)],
      transitions: [
        t('finish', [1, 0, 0], [0, 1, 0], true),
        t('spoil', [1, 0, 0], [0, 0, 1], true),
      ],
      forbidden: [],
    };
    const r = synthesizeInterlock(m);
    if (r.kind === 'error') throw new Error(r.message);
    expect(r.stats.states).toBe(3);
    expect(r.stats.winningStates).toBe(2); // s, f
    expect(r.stats.losingStates).toBe(1); // x
    expect(r.stats.maxRank).toBe(1);
  });

  it('不可用变迁（令牌/容量不足）状态为 disabled', () => {
    const m: PetriModel = {
      places: [p('s', 1, 1, 0), p('f', 1, 0, 1)],
      transitions: [
        t('go', [1, 0], [0, 1], true),
        t('back', [0, 1], [1, 0], true),
      ],
      forbidden: [],
    };
    const r = synthesizeInterlock(m);
    if (r.kind !== 'secured') throw new Error('not secured');
    const s = markingKey([1, 0]);
    expect(getDecision(m, r.policy, s, 1).status).toBe('disabled');
  });
});

describe('联锁综合：随机模型与朴素不动点差分', () => {
  /** 可复现的伪随机数生成。 */
  function mulberry32(seed: number) {
    let a = seed >>> 0;
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let x = Math.imul(a ^ (a >>> 15), 1 | a);
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** 朴素参考实现：单调外扩获胜区，波次号即收敛层数。 */
  function reference(model: PetriModel) {
    const P = model.places.length;
    const T = model.transitions.length;
    const pow4 = Array.from({ length: P }, (_, i) => 4 ** i);
    const enc = (m: number[]) => m.reduce((k, v, i) => k + v * pow4[i], 0);
    const dec = (k: number) => pow4.map((q) => Math.floor(k / q) % 4);
    const cmp = (l: number, op: string, r: number) =>
      op === 'ge' ? l >= r : op === 'eq' ? l === r : l !== r;
    const isF = (m: number[]) =>
      model.forbidden.some((g) => g.length > 0 && g.every((c) => cmp(m[c.place], c.op, c.value)));
    const isA = (m: number[]) => m.every((v, i) => v === model.places[i].acceptance);
    const enabled = (m: number[], ti: number) => {
      const tr = model.transitions[ti];
      return model.places.every(
        (pl, i) => m[i] >= tr.pre[i] && m[i] - tr.pre[i] + tr.post[i] <= pl.capacity,
      );
    };

    const init = enc(model.places.map((pl) => pl.initial));
    const adj = new Map<number, { t: number; to: number }[]>();
    const forb = new Set<number>();
    const queue = [init];
    const seen = new Set<number>([init]);
    while (queue.length) {
      const k = queue.shift()!;
      const m = dec(k);
      if (isF(m)) {
        forb.add(k);
        continue;
      }
      if (isA(m)) continue;
      const es: { t: number; to: number }[] = [];
      for (let ti = 0; ti < T; ti++) {
        if (!enabled(m, ti)) continue;
        const tr = model.transitions[ti];
        const to = enc(m.map((v, i) => v - tr.pre[i] + tr.post[i]));
        es.push({ t: ti, to });
        if (!seen.has(to)) {
          seen.add(to);
          queue.push(to);
        }
      }
      adj.set(k, es);
    }

    const win = new Map<number, number>(); // key -> rank
    for (const k of seen) {
      const m = dec(k);
      if (!forb.has(k) && isA(m)) win.set(k, 0);
    }
    let wave = 0;
    for (;;) {
      wave++;
      const add: number[] = [];
      for (const k of seen) {
        if (win.has(k) || forb.has(k)) continue;
        const es = adj.get(k) ?? [];
        const uEs = es.filter((e) => model.transitions[e.t].controllable === false);
        const cEs = es.filter((e) => model.transitions[e.t].controllable === true);
        const allUIn = uEs.every((e) => win.has(e.to));
        const progress = uEs.length > 0 || cEs.some((e) => win.has(e.to));
        if (allUIn && progress) add.push(k);
      }
      if (add.length === 0) break;
      for (const k of add) win.set(k, wave);
    }
    return { init, win, forb, seen };
  }

  it('200 个随机有界网：获胜区、层数与可保证结论与朴素实现一致', () => {
    const rnd = mulberry32(20260924);
    const ops: Array<'ge' | 'eq' | 'ne'> = ['ge', 'eq', 'ne'];
    for (let it = 0; it < 200; it++) {
      const P = 2 + Math.floor(rnd() * 4); // 2..5
      const T = 1 + Math.floor(rnd() * 7); // 1..7
      const places = Array.from({ length: P }, () => {
        const capacity = Math.floor(rnd() * 3); // 0..2
        const initial = Math.floor(rnd() * (capacity + 1));
        const acceptance = Math.floor(rnd() * (capacity + 1));
        return { name: `p${it}`, capacity, initial, acceptance };
      });
      const transitions = Array.from({ length: T }, () => {
        const pre = places.map((pl) => Math.floor(rnd() * (pl.capacity + 2)) - 1);
        const post = places.map((pl) => Math.floor(rnd() * (pl.capacity + 2)) - 1);
        return {
          name: 't',
          pre: pre.map((v) => Math.max(0, v)),
          post: post.map((v) => Math.max(0, v)),
          controllable: rnd() < 0.5,
        };
      });
      const forbidden: { place: number; op: 'ge' | 'eq' | 'ne'; value: number }[][] = [];
      if (rnd() < 0.4) {
        const gSize = 1 + Math.floor(rnd() * 2);
        const g = new Set<number>();
        while (g.size < gSize) g.add(Math.floor(rnd() * P));
        forbidden.push([...g].map((pl) => ({ place: pl, op: ops[Math.floor(rnd() * 3)], value: Math.floor(rnd() * 3) })));
      }
      const model: PetriModel = { places, transitions, forbidden };
      const r = synthesizeInterlock(model, 50_000);
      if (r.kind === 'error') throw new Error(`engine error on iter ${it}: ${r.message}`);
      const ref = reference(model);
      // 逐状态比较获胜区成员与层数
      for (const k of ref.seen) {
        const got = r.policy.get(k);
        if (!got) throw new Error(`iter ${it}: missing state ${k}`);
        const wantRank = ref.win.has(k) ? ref.win.get(k)! : -1;
        if (got.rank !== wantRank) {
          throw new Error(`iter ${it}: key=${k} rank got=${got.rank} want=${wantRank}`);
        }
        expect(got.forbidden).toBe(ref.forb.has(k));
      }
      // 结论一致
      if (ref.win.has(ref.init)) expect(r.kind).toBe('secured');
      else expect(r.kind).toBe('failure');
    }
  });
});
