import { describe, expect, it } from 'vitest';
import { runInterlock } from './interlock';
import { SAMPLES } from './samples';
import { validateModel } from './validate';
import type { PetriModel } from './types';

const p = (name: string, capacity: number, initial: number, acceptance: number) => ({
  name,
  capacity,
  initial,
  acceptance,
});
const t = (name: string, pre: number[], post: number[], controlled = true) => ({
  name,
  pre,
  post,
  controlled,
});

const findState = (r: ReturnType<typeof runInterlock>, marking: number[]) =>
  r.kind === 'error' ? undefined : r.states.find((s) => s.marking.every((v, i) => v === marking[i]));

describe('联锁综合：旧模型兼容性', () => {
  it('全部可控（缺省）的顺序模型综合成功且初始保证界等于审计深度', () => {
    const r = runInterlock(SAMPLES.find((s) => s.key === 'sequential')!.model);
    expect(r.kind).toBe('safe');
    if (r.kind !== 'safe') return;
    expect(r.stats.initRank).toBe(3);
    // 安全标记 = 3 个非验收标记（验收态单列，不在 safeStates 内）
    expect(r.stats.safeStates).toBe(3);
  });

  it('全部可控的双批次产线：非验收状态全部安全，无拦截边', () => {
    const r = runInterlock(SAMPLES.find((s) => s.key === 'pipeline')!.model);
    expect(r.kind).toBe('safe');
    if (r.kind !== 'safe') return;
    expect(r.stats.safeStates).toBe(29); // 30 个可达状态中 1 个为验收态
    expect(r.stats.blockedEdges).toBe(0);
  });

  it('controlled 缺省 / true 不改变可达图与综合结论', () => {
    const base = SAMPLES.find((s) => s.key === 'sequential')!.model;
    const r1 = runInterlock(base);
    const r2 = runInterlock({
      ...base,
      transitions: base.transitions.map((x) => ({ ...x, controlled: true })),
    });
    expect(r1.kind).toBe('safe');
    expect(r2.kind).toBe('safe');
    if (r1.kind === 'safe' && r2.kind === 'safe') {
      expect(r1.stats.states).toBe(r2.stats.states);
      expect(r1.stats.edges).toBe(r2.stats.edges);
      expect(r1.stats.initRank).toBe(r2.stats.initRank);
    }
  });
});

describe('联锁综合：成功策略', () => {
  it('泵冷却示例综合成功：违章启动拦截，冷却路径放行；失控态的可控停机也被锁闭', () => {
    const r = runInterlock(SAMPLES.find((s) => s.key === 'interlock-safe')!.model);
    expect(r.kind).toBe('safe');
    if (r.kind !== 'safe') return;
    // 初始 (1,0,0,0,0,0)：T1 投冷却放行，T3 违章启动拦截
    const init = findState(r, [1, 0, 0, 0, 0, 0])!;
    const byT = (st: typeof init, i: number) => st.enabled.find((e) => e.t === i)!;
    expect(byT(init, 0).decision).toBe('allowed');
    expect(byT(init, 2).decision).toBe('blocked');
    // 危险运行 (0,0,0,1,0,0) 因不可控过热而 losing：T5 过热必放，T4 紧急停机同样锁闭
    // （联锁无法抢在不可控自发事件前保证停机成功）
    const danger = findState(r, [0, 0, 0, 1, 0, 0])!;
    expect(byT(danger, 5).decision).toBe('forced');
    expect(byT(danger, 4).decision).toBe('blocked');
    // 禁态仍被完整保留在可达图中，但策略永不导向它
    const banned = findState(r, [0, 0, 0, 0, 1, 0]);
    expect(banned?.status).toBe('forbidden');
    expect(banned?.onPolicy).toBe(false);
    // 安全运行态 (0,0,1,0,0,0) 只有安全停机：放行
    const run = findState(r, [0, 0, 1, 0, 0, 0])!;
    expect(byT(run, 3).decision).toBe('allowed');
  });

  it('策略不变式：每条放行边严格减小保证界，安全状态必有放行出路', () => {
    const r = runInterlock(SAMPLES.find((s) => s.key === 'interlock-safe')!.model);
    if (r.kind !== 'safe') throw new Error('expected safe');
    for (const s of r.states) {
      if (s.status !== 'safe') continue;
      const permitted = s.enabled.filter((e) => e.decision !== 'blocked');
      expect(permitted.length).toBeGreaterThan(0);
      for (const e of permitted) {
        const next = r.states.find((x) => x.key === e.to)!;
        expect(next.rank).not.toBeNull();
        expect(next.rank!).toBeLessThan(s.rank!);
      }
    }
  });

  it('不可控自发振动与停机竞争：联锁无法保证，综合失败（竞态语义）', () => {
    // 运行态有不可控自发波动，波动态又不可控自发恢复：环境可一直抢先于可控停机，
    // 任何策略都不能保证停机成功。
    const m: PetriModel = {
      places: [p('运行', 1, 1, 0), p('波动', 1, 0, 0), p('完成', 1, 0, 1)],
      transitions: [
        t('停机', [1, 0, 0], [0, 0, 1]),
        t('自发波动', [1, 0, 0], [0, 1, 0], false),
        t('自发恢复', [0, 1, 0], [1, 0, 0], false),
        t('波动中停机', [0, 1, 0], [0, 0, 1]),
      ],
      forbidden: [],
    };
    const r = runInterlock(m);
    expect(r.kind).toBe('unsafe');
    if (r.kind !== 'unsafe') return;
    const run = findState(r, [1, 0, 0])!;
    const wave = findState(r, [0, 1, 0])!;
    expect(run.status).toBe('losing');
    expect(wave.status).toBe('losing');
    // 不可控变迁必放（losing 态也如实标注），可控停机锁闭
    expect(run.enabled.find((e) => e.t === 1)!.decision).toBe('forced');
    expect(run.enabled.find((e) => e.t === 0)!.decision).toBe('blocked');
    expect(wave.enabled.find((e) => e.t === 2)!.decision).toBe('forced');
    // 后果为永久循环（两条不可控边构成环）
    expect(r.failure.outcome).toBe('cycle');
    expect(r.failure.cycle.map((s) => s.t).sort()).toEqual([1, 2]);
  });

  it('纯不可控但必然收敛的链：无需任何可控操作也能综合成功', () => {
    // 启动（可控）后，两步不可控自发事件必然把系统带到验收；环境分支唯一且安全。
    const m: PetriModel = {
      places: [p('就绪', 1, 1, 0), p('阶段1', 1, 0, 0), p('阶段2', 1, 0, 0), p('验收', 1, 0, 1)],
      transitions: [
        t('启动', [1, 0, 0, 0], [0, 1, 0, 0]),
        t('自发推进', [0, 1, 0, 0], [0, 0, 1, 0], false),
        t('自发完成', [0, 0, 1, 0], [0, 0, 0, 1], false),
      ],
      forbidden: [],
    };
    const r = runInterlock(m);
    expect(r.kind).toBe('safe');
    if (r.kind !== 'safe') return;
    expect(r.stats.initRank).toBe(3);
    const s1 = findState(r, [0, 1, 0, 0])!;
    const s2 = findState(r, [0, 0, 1, 0])!;
    expect(s1.rank).toBe(2);
    expect(s2.rank).toBe(1);
    expect(s1.enabled.find((e) => e.t === 1)!.decision).toBe('forced');
    expect(s2.enabled.find((e) => e.t === 2)!.decision).toBe('forced');
  });

  it('等长可控出路只放行严格推进者：自环绕行被拦截', () => {
    const m: PetriModel = {
      places: [p('s', 1, 1, 0), p('ok', 1, 0, 1)],
      transitions: [
        t('完成', [1, 0], [0, 1]),
        t('空转自环', [1, 0], [1, 0]),
      ],
      forbidden: [],
    };
    const r = runInterlock(m);
    expect(r.kind).toBe('safe');
    if (r.kind !== 'safe') return;
    const s0 = findState(r, [1, 0])!;
    expect(s0.enabled.find((e) => e.t === 0)!.decision).toBe('allowed');
    expect(s0.enabled.find((e) => e.t === 1)!.decision).toBe('blocked');
  });

  it('纯可控死锁分支：联锁拦截坏分支即可综合成功（原审计“死锁”不影响策略可行）', () => {
    const r = runInterlock(SAMPLES.find((s) => s.key === 'deadlock')!.model);
    expect(r.kind).toBe('safe');
    if (r.kind !== 'safe') return;
    const init = findState(r, [1, 0, 0, 0])!;
    expect(init.enabled.find((e) => e.t === 0)!.decision).toBe('allowed'); // 启动泵→正常停机
    expect(init.enabled.find((e) => e.t === 2)!.decision).toBe('blocked'); // 空转
    // 空转过热态仍为 losing 且策略不可达
    const stuck = findState(r, [0, 0, 0, 1])!;
    expect(stuck.status).toBe('losing');
    expect(stuck.onPolicy).toBe(false);
  });
});

describe('联锁综合：无法保证时的根因', () => {
  it('泵过热不可控示例：最早失控标记为泵运行，不可控过热 1 步进禁态', () => {
    const r = runInterlock(SAMPLES.find((s) => s.key === 'interlock-unsafe')!.model);
    expect(r.kind).toBe('unsafe');
    if (r.kind !== 'unsafe') return;
    expect(r.failure.terminalMarking).toEqual([0, 1, 0, 0]);
    expect(r.failure.outcome).toBe('forbidden');
    expect(r.failure.trace.map((s) => s.t)).toEqual([0]);
    expect(r.failure.consequence.map((s) => s.t)).toEqual([2]);
    expect(r.failure.endMarking).toEqual([0, 0, 1, 0]);
    const run = findState(r, [0, 1, 0, 0])!;
    expect(run.status).toBe('losing');
    expect(run.enabled.find((e) => e.t === 2)!.decision).toBe('forced');
    // 初始标记的“启动泵”被拦截，初始标记 losing 且策略外标记
    const init = findState(r, [1, 0, 0, 0])!;
    expect(init.status).toBe('losing');
    expect(init.enabled.find((e) => e.t === 0)!.decision).toBe('blocked');
  });

  it('初始标记即禁态：零步失败', () => {
    const m: PetriModel = {
      places: [p('a', 1, 1, 0), p('b', 1, 0, 1)],
      transitions: [t('go', [1, 0], [0, 1])],
      forbidden: [[{ place: 0, op: 'ge', value: 1 }]],
    };
    const r = runInterlock(m);
    expect(r.kind).toBe('unsafe');
    if (r.kind !== 'unsafe') return;
    expect(r.failure.outcome).toBe('forbidden');
    expect(r.failure.trace).toEqual([]);
    expect(r.failure.consequence).toEqual([]);
  });

  it('可控开始 + 不可控回料：后果为被迫停滞，被拦截选项说明交替永久循环', () => {
    const m: PetriModel = {
      places: [p('就绪', 1, 1, 0), p('清洗中', 1, 0, 0), p('完成', 1, 0, 1)],
      transitions: [
        t('开始', [1, 0, 0], [0, 1, 0]),
        t('自发回料', [0, 1, 0], [1, 0, 0], false),
        t('结束', [0, 1, 0], [0, 0, 1]),
      ],
      forbidden: [],
    };
    const r = runInterlock(m);
    expect(r.kind).toBe('unsafe');
    if (r.kind !== 'unsafe') return;
    // 最早失控点 = 清洗态（有不可控坏边）；不可控回料把系统强制带回就绪后停滞
    expect(r.failure.terminalMarking).toEqual([0, 1, 0]);
    expect(r.failure.outcome).toBe('deadlock');
    expect(r.failure.trace.map((s) => s.t)).toEqual([0]);
    expect(r.failure.consequence.map((s) => s.t)).toEqual([1]);
    expect(r.failure.endMarking).toEqual([1, 0, 0]);
    // 就绪处被拦截的“开始”选项：放行后与不可控回料交替永久循环
    const opt = r.failure.blockedOptions.find((o) => o.t === 0)!;
    expect(opt.summary).toContain('永久循环');
    // 清洗态 losing，不可控回料必放，可控“结束”锁闭
    const wash = findState(r, [0, 1, 0])!;
    expect(wash.status).toBe('losing');
    expect(wash.enabled.find((e) => e.t === 1)!.decision).toBe('forced');
    expect(wash.enabled.find((e) => e.t === 2)!.decision).toBe('blocked');
  });

  it('纯不可控环（初始即在环上）：cycle 后果且循环自初始开始', () => {
    const m: PetriModel = {
      places: [p('a', 1, 1, 0), p('b', 1, 0, 0), p('ok', 1, 0, 1)],
      transitions: [
        t('a→b', [1, 0, 0], [0, 1, 0], false),
        t('b→a', [0, 1, 0], [1, 0, 0], false),
      ],
      forbidden: [],
    };
    const r = runInterlock(m);
    expect(r.kind).toBe('unsafe');
    if (r.kind !== 'unsafe') return;
    expect(r.failure.outcome).toBe('cycle');
    expect(r.failure.terminalMarking).toEqual([1, 0, 0]);
    expect(r.failure.cycle.map((s) => s.t)).toEqual([0, 1]);
    expect(r.failure.trace).toEqual([]);
  });
});

describe('联锁综合：模型校验', () => {
  it('controlled 缺省补 true，非布尔值报错', () => {
    const base: PetriModel = {
      places: [p('a', 1, 1, 0), p('b', 1, 0, 1)],
      transitions: [
        { name: 'g1', pre: [1, 0], post: [0, 1] },
        { name: 'g2', pre: [1, 0], post: [0, 1], controlled: false },
      ],
      forbidden: [],
    };
    const ok = validateModel(base);
    expect(ok.errors).toEqual([]);
    expect(ok.model!.transitions[0].controlled).toBe(true);
    expect(ok.model!.transitions[1].controlled).toBe(false);
    const bad = validateModel({
      ...base,
      transitions: [{ name: 'g', pre: [1, 0], post: [0, 1], controlled: 'no' }],
    });
    expect(bad.errors.some((e) => e.includes('controlled'))).toBe(true);
  });
});
