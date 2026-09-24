import { useEffect, useMemo, useState } from 'react';
import { Step } from '../petri/audit';
import {
  Decision,
  DecisionStatus,
  getDecision,
  InterlockResult,
  InterlockWitness,
  markingKey,
  PolicyEntry,
} from '../petri/interlock';
import { PetriModel } from '../petri/types';
import { NetView } from './NetView';

interface Props {
  result: InterlockResult;
  running: boolean;
  model: PetriModel;
  stale: boolean;
}

/* ---------------- 通用辅助 ---------------- */

function decode(model: PetriModel, key: number): number[] {
  const P = model.places.length;
  const m: number[] = [];
  for (let i = 0; i < P; i++) m.push(Math.floor(key / 4 ** i) % 4);
  return m;
}

const STATUS_LABEL: Record<DecisionStatus, string> = {
  granted: '✅ 放行',
  denied: '⛔ 拦截',
  'mandatory-safe': '🟢 不可控 · 必发生',
  'mandatory-bad': '🔴 不可控 · 无法拦截',
  disabled: '⚪ 不可用',
};

const STATUS_TESTID: Record<DecisionStatus, string> = {
  granted: 'granted',
  denied: 'denied',
  'mandatory-safe': 'mandatory-safe',
  'mandatory-bad': 'mandatory-bad',
  disabled: 'disabled',
};

function rankLabel(e: PolicyEntry | undefined): string {
  if (!e) return '？';
  if (e.forbidden) return '禁态';
  if (e.rank === 0) return '验收';
  if (e.rank > 0) return `获胜区 · ${e.rank} 层`;
  return '失败区';
}

function fireKey(model: PetriModel, key: number, t: number): number {
  const m = decode(model, key);
  const tr = model.transitions[t];
  return markingKey(m.map((v, i) => v - tr.pre[i] + tr.post[i]));
}

/* ---------------- 变迁决定表 ---------------- */

function DecisionsTable({
  model,
  result,
  stateKey,
  onFire,
  testidPrefix,
}: {
  model: PetriModel;
  result: ConcreteInterlock;
  stateKey: number;
  onFire?: (t: number) => void;
  testidPrefix: string;
}) {
  const decisions: (Decision & { t: number })[] = model.transitions.map((_tr, t) => ({
    t,
    ...getDecision(model, result.policy, stateKey, t),
  }));
  const counts = {
    granted: decisions.filter((d) => d.status === 'granted').length,
    denied: decisions.filter((d) => d.status === 'denied').length,
    mandatorySafe: decisions.filter((d) => d.status === 'mandatory-safe').length,
    mandatoryBad: decisions.filter((d) => d.status === 'mandatory-bad').length,
  };

  return (
    <div>
      <div className="row policy-summary" data-testid={`${testidPrefix}-summary`}>
        <span className="badge policy-badge granted">放行 {counts.granted}</span>
        <span className="badge policy-badge denied">拦截 {counts.denied}</span>
        <span className="badge policy-badge mandatory-safe">不可控·安全 {counts.mandatorySafe}</span>
        {counts.mandatoryBad > 0 && (
          <span className="badge policy-badge mandatory-bad">不可控·危险 {counts.mandatoryBad}</span>
        )}
      </div>
      <table className="grid-table policy-table" data-testid={`${testidPrefix}-table`}>
        <thead>
          <tr>
            <th>变迁</th>
            <th>决定</th>
            <th>触发后标记 / 层数</th>
            <th>策略理由</th>
            {onFire && <th></th>}
          </tr>
        </thead>
        <tbody>
          {decisions.map((d) => {
            const canFire =
              !!onFire && (d.status === 'granted' || d.status === 'mandatory-safe');
            return (
              <tr key={d.t} data-testid={`${testidPrefix}-row-${d.t}`} data-status={STATUS_TESTID[d.status]}>
                <td className="mono">
                  T{d.t + 1} {model.transitions[d.t].name}
                  <span className="dim">（{d.controllable ? '可控' : '不可控'}）</span>
                </td>
                <td>
                  <span className={`policy-status status-${STATUS_TESTID[d.status]}`}>
                    {STATUS_LABEL[d.status]}
                  </span>
                </td>
                <td className="mono">
                  ({d.target.join(', ')})
                  <br />
                  <span className="dim">
                    {d.targetRank === 0
                      ? '验收'
                      : d.targetRank > 0
                        ? `第 ${d.targetRank} 层`
                        : d.enabled
                          ? '失败区 / 禁态'
                          : '—'}
                  </span>
                </td>
                <td className="policy-reason">{d.reason}</td>
                {onFire && (
                  <td>
                    {canFire && (
                      <button
                        className="secondary small"
                        data-testid={`${testidPrefix}-fire-${d.t}`}
                        onClick={() => onFire(d.t)}
                      >
                        触发 →
                      </button>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ---------------- 标记浏览器（按标记查看允许/拦截） ---------------- */

type ConcreteInterlock = Extract<InterlockResult, { kind: 'secured' | 'failure' }>;

function MarkingBrowser({
  model,
  result,
  walkKey,
}: {
  model: PetriModel;
  result: ConcreteInterlock;
  walkKey: number;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const [depthFilter, setDepthFilter] = useState('');
  const selKey = selected ?? result.initKey;

  useEffect(() => {
    setSelected(null);
    setDepthFilter('');
  }, [result]);

  const { rows, total } = useMemo(() => {
    const all = [...result.policy.entries()].map(([key, e]) => ({ key, e }));
    all.sort((a, b) => a.e.depth - b.e.depth || a.key - b.key);
    const df = depthFilter === '' ? null : Number(depthFilter);
    const filtered = df === null || Number.isNaN(df) ? all : all.filter((r) => r.e.depth === df);
    return { rows: filtered.slice(0, 500), total: filtered.length };
  }, [result, depthFilter]);

  return (
    <div className="card" data-testid="marking-browser">
      <h2>
        按标记查看放行策略
        <span className="badge">{result.policy.size} 个可达标记</span>
      </h2>
      <div className="marking-browser-body">
        <div className="marking-list-col">
          <div className="row">
            <label className="dim">
              按深度筛选
              <input
                data-testid="marking-depth-filter"
                type="number"
                min={0}
                value={depthFilter}
                onChange={(e) => setDepthFilter(e.target.value)}
                placeholder="全部"
              />
            </label>
            <button className="secondary small" data-testid="marking-jump-walk" onClick={() => setSelected(walkKey)}>
              定位到回放标记
            </button>
          </div>
          <table className="grid-table marking-table" data-testid="marking-table">
            <thead>
              <tr>
                <th>深度</th>
                <th>分类</th>
                <th>标记</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ key, e }, i) => (
                <tr
                  key={key}
                  data-testid={`marking-row-${i}`}
                  data-key={key}
                  className={`${key === selKey ? 'current' : ''} rank-${e.forbidden ? 'forbidden' : e.rank}`}
                  onClick={() => setSelected(key)}
                >
                  <td>{e.depth}</td>
                  <td>{rankLabel(e)}</td>
                  <td className="mono">({decode(model, key).join(', ')})</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && <p className="hint">没有匹配的标记。</p>}
          {total > rows.length && <p className="hint">仅展示前 500 个标记，可按深度筛选缩小范围。</p>}
        </div>
        <div className="marking-detail-col">
          <div className="row" data-testid="marking-selected">
            <strong>当前查看标记</strong>
            <span className="mono">({decode(model, selKey).join(', ')})</span>
            <span className="badge">{rankLabel(result.policy.get(selKey))}</span>
          </div>
          <DecisionsTable model={model} result={result} stateKey={selKey} testidPrefix="browser" />
        </div>
      </div>
    </div>
  );
}

/* ---------------- 策略逐步回放 ---------------- */

interface WalkNode {
  key: number;
  /** 从上一节点到本节点触发的变迁；首节点为 null */
  viaT: number | null;
}

function PolicyWalk({
  model,
  result,
  onCurrentKey,
}: {
  model: PetriModel;
  result: ConcreteInterlock;
  onCurrentKey: (key: number) => void;
}) {
  const [path, setPath] = useState<WalkNode[]>([{ key: result.initKey, viaT: null }]);
  const [auto, setAuto] = useState(false);

  useEffect(() => {
    setPath([{ key: result.initKey, viaT: null }]);
    setAuto(false);
  }, [result]);

  const cur = path[path.length - 1];
  const prev = path.length > 1 ? path[path.length - 2] : null;

  useEffect(() => {
    onCurrentKey(cur.key);
  }, [cur.key, onCurrentKey]);

  const fire = (t: number) => {
    setAuto(false);
    setPath((p) => [...p, { key: fireKey(model, p[p.length - 1].key, t), viaT: t }]);
  };
  const back = () => {
    setAuto(false);
    setPath((p) => (p.length > 1 ? p.slice(0, -1) : p));
  };
  const reset = () => {
    setAuto(false);
    setPath([{ key: result.initKey, viaT: null }]);
  };

  // 自动演示：每步自动选择编号最小的“被允许执行”（放行的可控 / 必发生的不可控）变迁。
  // 获胜区内收敛层数严格递减，必然在有限步到达验收；到验收后无可用变迁，自动停止。
  useEffect(() => {
    if (!auto) return;
    const timer = setInterval(() => {
      setPath((p) => {
        const key = p[p.length - 1].key;
        let pick = -1;
        for (let t = 0; t < model.transitions.length; t++) {
          const d = getDecision(model, result.policy, key, t);
          if (d.status === 'granted' || d.status === 'mandatory-safe') {
            pick = t;
            break;
          }
        }
        if (pick < 0) {
          setAuto(false);
          return p;
        }
        return [...p, { key: fireKey(model, key, pick), viaT: pick }];
      });
    }, 900);
    return () => clearInterval(timer);
  }, [auto, model, result]);

  const marking = decode(model, cur.key);
  const prevMarking = prev ? decode(model, prev.key) : null;
  const firedT = cur.viaT;
  const entry = result.policy.get(cur.key);
  const atAcceptance = entry?.rank === 0;
  const steps: Step[] = [];
  for (let i = 1; i < path.length; i++) {
    steps.push({
      t: path[i].viaT!,
      before: decode(model, path[i - 1].key),
      after: decode(model, path[i].key),
    });
  }

  return (
    <div className="card" data-testid="policy-walk">
      <h2>策略回放：逐步解释为何放行 / 拒绝</h2>
      <p className="hint">
        从初始标记出发，仅能触发「✅ 放行」的可控变迁与「🟢 不可控 · 必发生」的变迁；
        每一步收敛层数严格递减，{result.kind === 'secured'
          ? `至多 ${result.initRank} 步必达验收标记。`
          : '失败区标记不保证到达验收。'}
        点击变迁行的「触发 →」可沿被允许的执行手工推演，或用自动演示观察最坏情况下的必然收敛。
      </p>
      <div className="row replay-controls">
        <button className="secondary" data-testid="walk-reset" onClick={reset} disabled={path.length === 1}>
          ⏮ 初始
        </button>
        <button className="secondary" data-testid="walk-prev" onClick={back} disabled={path.length === 1}>
          ◀ 上一步
        </button>
        <button
          className="secondary"
          data-testid="walk-auto"
          onClick={() => setAuto((a) => !a)}
          disabled={atAcceptance}
        >
          {auto ? '⏸ 暂停' : '▶ 自动推演'}
        </button>
        <span className="badge" data-testid="walk-position">
          第 {steps.length} 步
        </span>
        <span className="badge" data-testid="walk-rank">
          {rankLabel(entry)}
        </span>
      </div>
      <div className="row">
        <span className="fired-label" data-testid="walk-transition">
          {firedT === null
            ? '初始标记'
            : `上一步：T${firedT + 1} · ${model.transitions[firedT].name}`}
        </span>
        {atAcceptance && <span className="badge loop-badge" data-testid="walk-accepted" style={{ color: 'var(--green)', borderColor: 'var(--green)' }}>✓ 已到达验收标记</span>}
      </div>

      <NetView model={model} marking={marking} prevMarking={prevMarking} firedT={firedT} />

      <div className="chips">
        {model.places.map((pl, i) => {
          const d = prevMarking ? marking[i] - prevMarking[i] : 0;
          return (
            <span
              key={i}
              className={`chip ${d > 0 ? 'chip-up' : ''} ${d < 0 ? 'chip-down' : ''}`}
              data-testid={`walk-chip-${i}`}
            >
              {pl.name}
              <strong>{marking[i]}</strong>
              {d !== 0 && <em>{d > 0 ? `+${d}` : d}</em>}
            </span>
          );
        })}
      </div>

      <DecisionsTable
        model={model}
        result={result}
        stateKey={cur.key}
        onFire={atAcceptance ? undefined : fire}
        testidPrefix="walk"
      />

      {steps.length > 0 && (
        <table className="grid-table steps-table">
          <thead>
            <tr>
              <th>步骤</th>
              <th>触发变迁</th>
              <th>结果标记</th>
            </tr>
          </thead>
          <tbody>
            {steps.map((s, i) => (
              <tr key={i} data-testid={`walk-step-${i}`} className={i === steps.length - 1 ? 'current' : ''}>
                <td>{i + 1}</td>
                <td>T{s.t + 1} {model.transitions[s.t].name}</td>
                <td className="mono">({s.after.join(', ')})</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/* ---------------- 失败见证回放 ---------------- */

const CONTINUATION_TEXT: Record<string, string> = {
  forbidden: '进入禁态',
  deadlock: '非验收死锁',
  cycle: '在失败区域内无限循环（永不到达验收）',
};

interface BuiltWalk {
  steps: Step[];
  cycleStart: number;
}

function buildWitnessWalk(w: InterlockWitness, branchIdx: number): BuiltWalk {
  const steps = w.trace.map((s) => ({ ...s }));
  let cycleStart = -1;
  if (w.kind === 'uncontrollable') {
    const b = w.badTransitions[branchIdx];
    if (!b) return { steps, cycleStart };
    steps.push({ t: b.t, before: w.marking.map((x) => x), after: b.to.map((x) => x) });
    const c = b.continuation;
    if (c.type === 'cycle') {
      cycleStart = steps.length + c.steps.length;
    }
    steps.push(...c.steps.map((s) => ({ ...s })));
    steps.push(...c.cycle.map((s) => ({ ...s })));
  } else if (w.kind === 'trapped') {
    // 优先回放“受困 → 沿失败区域 → 危险不可控变迁 → 后果”的完整链条；
    // 无危险不可控变迁（纯可控死循环/死锁）时回退到受困后果推演。
    const rc = w.rootCause;
    const c = rc ? rc.continuation : w.continuation;
    if (rc) steps.push(...rc.leadSteps.map((s) => ({ ...s })));
    if (rc) {
      const before = steps.length > 0 ? steps[steps.length - 1].after : w.marking.map((x) => x);
      steps.push({ t: rc.t, before: before.map((x) => x), after: rc.to.map((x) => x) });
    }
    if (c) {
      if (c.type === 'cycle') {
        cycleStart = steps.length + c.steps.length;
      }
      steps.push(...c.steps.map((s) => ({ ...s })));
      steps.push(...c.cycle.map((s) => ({ ...s })));
    }
  }
  return { steps, cycleStart };
}

function WitnessReplay({ model, witness }: { model: PetriModel; witness: InterlockWitness }) {
  const [branchIdx, setBranchIdx] = useState(0);
  const built = useMemo(
    () => buildWitnessWalk(witness, branchIdx),
    [witness, branchIdx],
  );
  const steps = built.steps;
  const cycleStart = built.cycleStart;
  const [pos, setPos] = useState(steps.length);
  const [auto, setAuto] = useState(false);

  useEffect(() => {
    setBranchIdx(0);
  }, [witness]);
  useEffect(() => {
    setPos(steps.length);
    setAuto(false);
  }, [steps, branchIdx, witness]);

  useEffect(() => {
    if (!auto || steps.length === 0) return;
    const timer = setInterval(() => {
      setPos((p) => {
        if (p >= steps.length) {
          if (cycleStart >= 0) return cycleStart;
          setAuto(false);
          return p;
        }
        return p + 1;
      });
    }, 900);
    return () => clearInterval(timer);
  }, [auto, steps.length, cycleStart]);

  const initial = model.places.map((p) => p.initial);
  const marking = pos === 0 ? initial : steps[pos - 1].after;
  const prevMarking = pos === 0 ? null : steps[pos - 1].before;
  const firedT = pos === 0 ? null : steps[pos - 1].t;

  const kindText: Record<InterlockWitness['kind'], string> = {
    forbidden: '初始标记即禁态',
    deadlock: '最早的失败区标记为非验收死锁',
    uncontrollable: '该标记下存在必然发生且无法纳入保证的不可控变迁',
    trapped: '该标记下没有任何可放行的可控变迁，且现场不会自行推进到验收',
  };

  return (
    <div className="card witness-card" data-testid="interlock-witness">
      <h2>无法受控化解的见证（可回放）</h2>
      <p className="hint" data-testid="witness-kind">
        {kindText[witness.kind]}
      </p>
      <div className="row">
        <strong>最早无法受控化解的标记：</strong>
        <span className="mono" data-testid="witness-marking">
          ({witness.marking.join(', ')})
        </span>
        <span className="badge" data-testid="witness-depth">
          距初始标记 {witness.trace.length} 步
        </span>
      </div>

      {witness.kind === 'uncontrollable' && (
        <div className="bad-transitions" data-testid="witness-bad-list">
          <p className="hint">必然发生的不可控变迁及其后果：</p>
          {witness.badTransitions.map((b, i) => (
            <button
              key={i}
              className={`secondary small bad-t-btn ${i === branchIdx ? 'active' : ''}`}
              data-testid={`witness-bad-${i}`}
              onClick={() => setBranchIdx(i)}
            >
              T{b.t + 1} {model.transitions[b.t].name} → ({b.to.join(', ')})：
              {CONTINUATION_TEXT[b.continuation.type]}
              {b.continuation.type === 'cycle' &&
                `（${b.continuation.steps.length} 步入环，环长 ${b.continuation.cycle.length}）`}
            </button>
          ))}
        </div>
      )}
      {witness.kind === 'trapped' && witness.rootCause && (
        <p className="hint" data-testid="witness-rootcause">
          沿失败区域最早在 {witness.rootCause.leadSteps.length} 步后遇到危险的不可控变迁
          T{witness.rootCause.t + 1} {model.transitions[witness.rootCause.t].name}
          （联锁无法拒绝）→ ({witness.rootCause.to.join(', ')})，后果：
          {CONTINUATION_TEXT[witness.rootCause.continuation.type]}
          {witness.rootCause.continuation.type === 'cycle' &&
            `（环长 ${witness.rootCause.continuation.cycle.length}）`}
          。
        </p>
      )}
      {witness.kind === 'trapped' && !witness.rootCause && witness.continuation && (
        <p className="hint" data-testid="witness-continuation">
          后果：{CONTINUATION_TEXT[witness.continuation.type]}
          {witness.continuation.type === 'cycle' &&
            `（${witness.continuation.steps.length} 步入环，环长 ${witness.continuation.cycle.length}）`}
        </p>
      )}

      {steps.length > 0 && (
        <>
          <div className="row replay-controls">
            <button className="secondary" data-testid="witness-reset" onClick={() => setPos(0)} disabled={pos === 0}>
              ⏮ 初始
            </button>
            <button
              className="secondary"
              data-testid="witness-prev"
              onClick={() => setPos((p) => Math.max(0, p - 1))}
              disabled={pos === 0}
            >
              ◀ 上一步
            </button>
            <button
              className="secondary"
              data-testid="witness-next"
              onClick={() => setPos((p) => Math.min(steps.length, p + 1))}
              disabled={pos >= steps.length}
            >
              下一步 ▶
            </button>
            <button className="secondary" data-testid="witness-auto" onClick={() => setAuto((a) => !a)}>
              {auto ? '⏸ 暂停' : '▶ 自动'}
            </button>
            <input
              type="range"
              data-testid="witness-slider"
              min={0}
              max={steps.length}
              value={pos}
              onChange={(e) => setPos(Number(e.target.value))}
            />
            <span className="badge" data-testid="witness-position">
              {pos} / {steps.length}
            </span>
          </div>
          <div className="row">
            <span className="fired-label">
              {firedT === null ? '初始标记' : `第 ${pos} 步：T${firedT + 1} · ${model.transitions[firedT].name}`}
            </span>
            {cycleStart >= 0 && pos > cycleStart && (
              <span className="badge loop-badge">↻ 后果循环段（无限重复）</span>
            )}
          </div>
          <NetView model={model} marking={marking} prevMarking={prevMarking} firedT={firedT} />
          <div className="chips">
            {model.places.map((pl, i) => {
              const d = prevMarking ? marking[i] - prevMarking[i] : 0;
              return (
                <span
                  key={i}
                  className={`chip ${d > 0 ? 'chip-up' : ''} ${d < 0 ? 'chip-down' : ''}`}
                  data-testid={`witness-chip-${i}`}
                >
                  {pl.name}
                  <strong>{marking[i]}</strong>
                  {d !== 0 && <em>{d > 0 ? `+${d}` : d}</em>}
                </span>
              );
            })}
          </div>
          <table className="grid-table steps-table">
            <thead>
              <tr>
                <th>步骤</th>
                <th>变迁</th>
                <th>结果标记</th>
              </tr>
            </thead>
            <tbody>
              {steps.map((s, i) => (
                <tr
                  key={i}
                  data-testid={`witness-step-${i}`}
                  className={`${i === pos - 1 ? 'current' : ''} ${i === cycleStart ? 'cycle-start' : ''}`}
                  onClick={() => setPos(i + 1)}
                >
                  <td>{i === cycleStart && '↻ '}{i + 1}</td>
                  <td>T{s.t + 1} {model.transitions[s.t].name}</td>
                  <td className="mono">({s.after.join(', ')})</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

/* ---------------- 主面板 ---------------- */

const VERDICT = {
  secured: { cls: 'verdict-verified', icon: '✅ ', text: '联锁可保证：被放行的任意执行均在有限步到达验收且不进入禁态' },
  failure: { cls: 'verdict-forbidden', icon: '⛔ ', text: '联锁无法保证：存在无法受控化解的标记' },
  error: { cls: 'verdict-error', icon: '⚠️ ', text: '联锁综合中止' },
} as const;

export function InterlockPanel({ result, model, stale }: Props) {
  const [walkKey, setWalkKey] = useState<number>(result.kind === 'error' ? 0 : result.initKey);

  if (result.kind === 'error') {
    return (
      <div className="result-panel">
        <div className={`verdict ${VERDICT.error.cls}`} data-testid="interlock-verdict">
          {VERDICT.error.icon}
          {VERDICT.error.text}
        </div>
        <div className="card">
          <p data-testid="interlock-error-message">{result.message}</p>
        </div>
      </div>
    );
  }

  const v = VERDICT[result.kind];
  return (
    <div className="result-panel">
      <div className={`verdict ${v.cls}`} data-testid="interlock-verdict">
        {v.icon}
        {v.text}
        {result.kind === 'secured'
          ? `（初始标记位于获胜区第 ${result.initRank} 层：最坏情况下至多 ${result.initRank} 步必达验收）`
          : ''}
      </div>
      {stale && <div className="stale-hint">模型已在综合后修改，结果可能过期，请重新运行。</div>}

      <div className="card stats" data-testid="interlock-stats">
        <div>
          <span className="stat-value" data-testid="il-stat-states">{result.stats.states}</span>
          <span className="stat-label">可达状态</span>
        </div>
        <div>
          <span className="stat-value">{result.stats.edges}</span>
          <span className="stat-label">变迁边</span>
        </div>
        <div>
          <span className="stat-value" data-testid="il-stat-winning">{result.stats.winningStates}</span>
          <span className="stat-label">获胜区状态</span>
        </div>
        <div>
          <span className="stat-value" data-testid="il-stat-losing">{result.stats.losingStates}</span>
          <span className="stat-label">失败区状态</span>
        </div>
        <div>
          <span className="stat-value">{result.stats.forbiddenStates}</span>
          <span className="stat-label">禁态</span>
        </div>
        <div>
          <span className="stat-value" data-testid="il-stat-maxrank">{result.stats.maxRank}</span>
          <span className="stat-label">最大收敛层数</span>
        </div>
        <div>
          <span className="stat-value">{result.stats.timeMs} ms</span>
          <span className="stat-label">耗时</span>
        </div>
      </div>

      {result.kind === 'failure' && <WitnessReplay model={model} witness={result.witness} />}

      <PolicyWalk model={model} result={result} onCurrentKey={setWalkKey} />
      <MarkingBrowser model={model} result={result} walkKey={walkKey} />
    </div>
  );
}
