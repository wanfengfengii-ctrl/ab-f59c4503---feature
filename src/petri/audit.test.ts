import { describe, expect, it } from 'vitest';
import { runAudit } from './audit';
import { SAMPLES } from './samples';
import { validateModel } from './validate';
import { PetriModel } from './types';

const sample = (key: string) => SAMPLES.find((s) => s.key === key)!.model;

const p = (name: string, capacity: number, initial: number, acceptance: number) => ({
  name,
  capacity,
  initial,
  acceptance,
});
const t = (name: string, pre: number[], post: number[]) => ({ name, pre, post });

describe('内置示例', () => {
  it('双阀顺序灌装：验证通过', () => {
    const r = runAudit(sample('sequential'));
    expect(r.kind).toBe('verified');
    if (r.kind !== 'verified') return;
    expect(r.stats.states).toBe(4);
    expect(r.stats.edges).toBe(3);
    expect(r.stats.maxDepth).toBe(3);
  });

  it('泵空转分支：非验收死锁，最短轨迹 [T3]', () => {
    const r = runAudit(sample('deadlock'));
    expect(r.kind).toBe('deadlock');
    if (r.kind !== 'deadlock') return;
    expect(r.trace.map((s) => s.t)).toEqual([2]);
    expect(r.trace[0].before).toEqual([1, 0, 0, 0]);
    expect(r.trace[0].after).toEqual([0, 0, 0, 1]);
  });

  it('双阀同开：禁态反例，最短轨迹 [T1,T2]', () => {
    const r = runAudit(sample('forbidden'));
    expect(r.kind).toBe('forbidden');
    if (r.kind !== 'forbidden') return;
    expect(r.trace.map((s) => s.t)).toEqual([0, 1]);
    expect(r.trace[1].after).toEqual([0, 1, 1, 0]);
  });

  it('清洗循环：套索，空前缀 + 循环 [T1,T2]', () => {
    const r = runAudit(sample('lasso'));
    expect(r.kind).toBe('lasso');
    if (r.kind !== 'lasso') return;
    expect(r.prefix).toEqual([]);
    expect(r.cycle.map((s) => s.t)).toEqual([0, 1]);
    expect(r.cycle[0].before).toEqual([1, 0, 0]);
    expect(r.cycle[1].after).toEqual([1, 0, 0]); // 回到循环入口
  });

  it('双批次配料产线：验证通过，30 状态', () => {
    const r = runAudit(sample('pipeline'));
    expect(r.kind).toBe('verified');
    if (r.kind !== 'verified') return;
    expect(r.stats.states).toBe(30);
    expect(r.stats.maxDepth).toBe(14);
  });
});

describe('反例的最短性与字典序', () => {
  const tieModel = (withShortcut: boolean): PetriModel => ({
    places: [
      p('s', 1, 1, 0),
      p('a', 1, 0, 0),
      p('b', 1, 0, 0),
      p('c', 1, 0, 0),
      p('d', 1, 0, 0),
      p('e', 1, 0, 0),
    ],
    transitions: [
      t('T0', [1, 0, 0, 0, 0, 0], [0, 1, 0, 0, 0, 0]),
      t('T1', [1, 0, 0, 0, 0, 0], [0, 0, 1, 0, 0, 0]),
      t('T2', [0, 1, 0, 0, 0, 0], [0, 0, 0, 1, 0, 0]),
      t('T3', [0, 0, 1, 0, 0, 0], [0, 0, 0, 0, 1, 0]),
      ...(withShortcut ? [t('T4', [1, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 1])] : []),
    ],
    forbidden: [],
  });

  it('等长死锁取字典序最小序列 [T1,T3]', () => {
    const r = runAudit(tieModel(false));
    expect(r.kind).toBe('deadlock');
    if (r.kind !== 'deadlock') return;
    expect(r.trace.map((s) => s.t)).toEqual([0, 2]);
  });

  it('更短的死锁优先于字典序 [T5]', () => {
    const r = runAudit(tieModel(true));
    expect(r.kind === 'deadlock' && r.trace.map((s) => s.t)).toEqual([4]);
  });

  it('禁态与死锁并存时按同一规则取整体最优', () => {
    // T0 一步进禁态；T1 两步进死锁 —— 禁态更短，胜出
    const m: PetriModel = {
      places: [p('s', 1, 1, 0), p('x', 1, 0, 0), p('y', 1, 0, 0)],
      transitions: [
        t('bad', [1, 0, 0], [0, 1, 0]),
        t('d1', [1, 0, 0], [0, 0, 1]),
      ],
      forbidden: [[{ place: 1, op: 'ge', value: 1 }]],
    };
    const r = runAudit(m);
    expect(r.kind).toBe('forbidden');
    if (r.kind === 'forbidden') expect(r.trace.map((s) => s.t)).toEqual([0]);
  });
});

describe('语义细节', () => {
  it('容量上限会阻塞变迁，可能引发死锁', () => {
    const m: PetriModel = {
      places: [p('源', 2, 2, 0), p('汇', 1, 0, 1)],
      transitions: [t('移', [1, 0], [0, 1])],
      forbidden: [],
    };
    const r = runAudit(m);
    // (2,0) -> (1,1) 后“汇”已满，变迁被容量阻塞，(1,1) 为非验收死锁
    expect(r.kind).toBe('deadlock');
    if (r.kind === 'deadlock') {
      expect(r.trace.map((s) => s.t)).toEqual([0]);
      expect(r.trace[0].after).toEqual([1, 1]);
    }
  });

  it('初始标记即验收：直接验证通过', () => {
    const m: PetriModel = {
      places: [p('a', 1, 1, 1), p('b', 1, 0, 0)],
      transitions: [t('noop', [1, 0], [0, 1])],
      forbidden: [],
    };
    const r = runAudit(m);
    expect(r.kind).toBe('verified');
    if (r.kind !== 'verified') return;
    expect(r.stats.states).toBe(1);
  });

  it('初始标记即禁态：零步反例', () => {
    const m: PetriModel = {
      places: [p('a', 1, 1, 0), p('b', 1, 0, 1)],
      transitions: [t('go', [1, 0], [0, 1])],
      forbidden: [[{ place: 0, op: 'ge', value: 1 }]],
    };
    const r = runAudit(m);
    expect(r.kind === 'forbidden' && r.trace).toEqual([]);
  });

  it('验收态是吸收态：其上的自环不构成无限执行', () => {
    const m: PetriModel = {
      places: [p('a', 1, 1, 0), p('b', 1, 0, 1)],
      transitions: [
        t('go', [1, 0], [0, 1]),
        t('loop', [0, 1], [0, 1]),
      ],
      forbidden: [],
    };
    expect(runAudit(m).kind).toBe('verified');
  });

  it('非验收态自环：长度为 1 的套索循环', () => {
    const m: PetriModel = {
      places: [p('a', 1, 1, 0), p('b', 1, 0, 1)],
      transitions: [
        t('loop', [1, 0], [1, 0]),
        t('finish', [1, 0], [0, 1]),
      ],
      forbidden: [],
    };
    const r = runAudit(m);
    expect(r.kind).toBe('lasso');
    if (r.kind === 'lasso') {
      expect(r.prefix).toEqual([]);
      expect(r.cycle.map((s) => s.t)).toEqual([0]);
    }
  });

  it('禁态判定优先于验收判定', () => {
    const m: PetriModel = {
      places: [p('a', 1, 1, 1), p('b', 1, 0, 0)],
      transitions: [t('go', [1, 0], [0, 1])],
      forbidden: [[{ place: 0, op: 'eq', value: 1 }]],
    };
    expect(runAudit(m).kind).toBe('forbidden');
  });

  it('套索前缀最短优先于循环最短', () => {
    // 初始态在长度为 3 的环上，状态 x 在长度为 1 的自环上但需 2 步到达：
    // 应选择前缀 0 + 长循环，而非前缀 2 + 短循环。
    const m: PetriModel = {
      places: [
        p('s', 1, 1, 0),
        p('u', 1, 0, 0),
        p('v', 1, 0, 0),
        p('w', 1, 0, 0),
        p('x', 1, 0, 0),
        p('ok', 1, 0, 1),
      ],
      transitions: [
        t('c0', [1, 0, 0, 0, 0, 0], [0, 1, 0, 0, 0, 0]), // s->u
        t('c1', [0, 1, 0, 0, 0, 0], [0, 0, 1, 0, 0, 0]), // u->v
        t('c2', [0, 0, 1, 0, 0, 0], [1, 0, 0, 0, 0, 0]), // v->s （环 s,u,v）
        t('d0', [0, 1, 0, 0, 0, 0], [0, 0, 0, 1, 0, 0]), // u->w
        t('d1', [0, 0, 0, 1, 0, 0], [0, 0, 0, 0, 1, 0]), // w->x
        t('dl', [0, 0, 0, 0, 1, 0], [0, 0, 0, 0, 1, 0]), // x 自环
      ],
      forbidden: [],
    };
    const r = runAudit(m);
    expect(r.kind).toBe('lasso');
    if (r.kind === 'lasso') {
      expect(r.prefix).toEqual([]);
      expect(r.cycle.map((s) => s.t)).toEqual([0, 1, 2]);
    }
  });
});

describe('模型校验', () => {
  const base: PetriModel = {
    places: [p('a', 1, 1, 0), p('b', 1, 0, 1)],
    transitions: [t('go', [1, 0], [0, 1])],
    forbidden: [],
  };

  it('合法模型通过校验', () => {
    const { errors, model } = validateModel(base);
    expect(errors).toEqual([]);
    expect(model).not.toBeNull();
  });

  it('库所数量越界被拒绝', () => {
    expect(validateModel({ ...base, places: [base.places[0]] }).errors[0]).toContain('库所数量');
    expect(
      validateModel({ ...base, places: Array(19).fill(base.places[0]) }).errors[0],
    ).toContain('库所数量');
  });

  it('容量 / 初始 / 验收越界被拒绝', () => {
    expect(validateModel({ ...base, places: [p('a', 4, 0, 0), p('b', 1, 0, 1)] }).errors.length).toBeGreaterThan(0);
    expect(validateModel({ ...base, places: [p('a', 1, 2, 0), p('b', 1, 0, 1)] }).errors.length).toBeGreaterThan(0);
    expect(validateModel({ ...base, places: [p('a', 1, 0, 2), p('b', 1, 0, 1)] }).errors.length).toBeGreaterThan(0);
  });

  it('变迁数量与弧权越界被拒绝', () => {
    expect(validateModel({ ...base, transitions: [] }).errors[0]).toContain('变迁数量');
    expect(
      validateModel({ ...base, transitions: [t('bad', [-1, 0], [0, 1])] }).errors.length,
    ).toBeGreaterThan(0);
  });

  it('禁态子句越界被拒绝', () => {
    expect(
      validateModel({ ...base, forbidden: [[{ place: 9, op: 'eq', value: 1 }]] }).errors.length,
    ).toBeGreaterThan(0);
    expect(
      validateModel({ ...base, forbidden: [[{ place: 0, op: '??', value: 1 }]] }).errors.length,
    ).toBeGreaterThan(0);
  });

  it('弧向量短于库所数时自动补零', () => {
    const { errors, model } = validateModel({
      ...base,
      transitions: [{ name: 'go', pre: [1], post: [0, 1] }],
    });
    expect(errors).toEqual([]);
    expect(model!.transitions[0].pre).toEqual([1, 0]);
  });
});
