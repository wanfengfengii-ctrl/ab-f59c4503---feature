import { useEffect, useMemo, useState } from 'react';
import type { Step } from '../petri/audit';
import type { InterlockResult, InterlockStateInfo } from '../petri/interlock';
import { INTERLOCK_VERDICT_TEXT, STATUS_TEXT } from '../petri/interlock';
import type { PetriModel } from '../petri/types';
import { NetView } from './NetView';

interface Props {
  result: InterlockResult | null;
  running: boolean;
  model: PetriModel;
  stale: boolean;
}

const DECISION_TEXT = {
  forced: '不可控 · 必须放行',
  allowed: '放行（严格推进）',
  blocked: '拦截',
} as const;

/** 与引擎一致的 2-bit 编码，用于在回放中按标记反查策略解释。 */
const keyOf = (m: number[]): number => m.reduce((k, v, i) => k + v * 4 ** i, 0);

/** 从某个标记的收敛见证变迁序列还原逐步轨迹。 */
function witnessSteps(model: PetriModel, start: number[], ts: number[]): Step[] {
  const steps: Step[] = [];
  let m = start.slice();
  for (const t of ts) {
    const tr = model.transitions[t];
    const after = m.map((v, i) => v - tr.pre[i] + tr.post[i]);
    steps.push({ t, before: m, after });
    m = after;
  }
  return steps;
}

function deltaText(model: PetriModel, s: Step): string {
  const parts: string[] = [];
  for (let i = 0; i < model.places.length; i++) {
    const d = s.after[i] - s.before[i];
    if (d !== 0) parts.push(`${model.places[i].name} ${s.before[i]}→${s.after[i]}`);
  }
  return parts.join('，') || '（无变化）';
}

export function InterlockPanel({ result, running, model, stale }: Props) {
  const [selIdx, setSelIdx] = useState(0);
  const [pos, setPos] = useState(0);
  const [auto, setAuto] = useState(false);

  const infoByKey = useMemo(() => {
    const map = new Map<number, InterlockStateInfo>();
    if (result && result.kind !== 'error') result.states.forEach((s) => map.set(s.key, s));
    return map;
  }, [result]);

  const states = result && result.kind !== 'error' ? result.states : [];
  const sel: InterlockStateInfo | null = states[selIdx] ?? states[0] ?? null;

  // 选中标记的收敛见证（unsafe 的失败根因回放另用 failure 轨迹）
  const witness: Step[] = useMemo(() => {
    if (!sel || !result || result.kind !== 'safe') return [];
    return witnessSteps(model, sel.marking, sel.witness);
  }, [sel, result, model]);

  // unsafe：失败见证（到失控标记的前缀 + 不可控后果链 + 循环）
  const failureSteps: Step[] = useMemo(() => {
    if (!result || result.kind !== 'unsafe') return [];
    return [...result.failure.trace, ...result.failure.consequence, ...result.failure.cycle];
  }, [result]);
  const prefixLen = result?.kind === 'unsafe' ? result.failure.trace.length : -1;
  const consLen =
    result?.kind === 'unsafe'
      ? result.failure.trace.length + result.failure.consequence.length
      : -1;
  const cycleStart = result?.kind === 'unsafe' ? consLen : -1;

  const replaySteps = result?.kind === 'unsafe' ? failureSteps : witness;

  // 新结果 / 切换查看标记时重置回放
  useEffect(() => {
    setSelIdx(0);
    setPos(0);
    setAuto(false);
  }, [result]);
  useEffect(() => {
    setPos(0);
    setAuto(false);
  }, [selIdx]);

  // 自动播放：见证播到结尾停止；失败循环段内回绕
  useEffect(() => {
    if (!auto || replaySteps.length === 0) return;
    const timer = setInterval(() => {
      setPos((p) => {
        if (p >= replaySteps.length) {
          if (cycleStart >= 0 && result?.kind === 'unsafe') return cycleStart;
          setAuto(false);
          return p;
        }
        return p + 1;
      });
    }, 900);
    return () => clearInterval(timer);
  }, [auto, replaySteps.length, cycleStart, result]);

  if (!result) {
    return (
      <div className="card result-panel" data-testid="il-empty">
        <h2>联锁综合</h2>
        <p className="hint">
          {running
            ? '联锁综合中……'
            : '在变迁编辑器勾选“可控”，运行后从初始标记合成状态相关放行策略（旧模型不填可控属性时仍只做原审计）。'}
        </p>
      </div>
    );
  }

  if (result.kind === 'error') {
    return (
      <div className="result-panel">
        <div className="verdict verdict-error" data-testid="il-verdict">
          ⚠️ {INTERLOCK_VERDICT_TEXT.error}
        </div>
        <div className="card">
          <p data-testid="il-error-message">{result.message}</p>
        </div>
      </div>
    );
  }

  // 回放当前位置的标记与解释
  const baseMarking = sel?.marking ?? model.places.map((p) => p.initial);
  const replayBase = result.kind === 'unsafe' ? model.places.map((p) => p.initial) : baseMarking;
  const marking = pos === 0 ? replayBase : replaySteps[pos - 1].after;
  const prevMarking = pos === 0 ? null : replaySteps[pos - 1].before;
  const firedT = pos === 0 ? null : replaySteps[pos - 1].t;
  const firedReason =
    firedT === null
      ? null
      : (infoByKey.get(keyOf(replaySteps[pos - 1].before))?.enabled.find((e) => e.t === firedT)
          ?.reason ?? null);

  return (
    <div className="result-panel">
      <div className={`verdict verdict-il-${result.kind}`} data-testid="il-verdict">
        {result.kind === 'safe' ? '🛡 ' : '⛔ '}
        {INTERLOCK_VERDICT_TEXT[result.kind]}
      </div>
      <div className="card il-summary">
        <p data-testid="il-message">{result.message}</p>
        <div className="stats">
          <div>
            <span className="stat-value" data-testid="il-stat-states">{result.stats.states}</span>
            <span className="stat-label">可达状态</span>
          </div>
          <div>
            <span className="stat-value" data-testid="il-stat-safe">{result.stats.safeStates}</span>
            <span className="stat-label">安全标记</span>
          </div>
          <div>
            <span className="stat-value" data-testid="il-stat-allowed">{result.stats.allowedEdges}</span>
            <span className="stat-label">放行可控边</span>
          </div>
          <div>
            <span className="stat-value" data-testid="il-stat-forced">{result.stats.forcedEdges}</span>
            <span className="stat-label">不可控必放边</span>
          </div>
          <div>
            <span className="stat-value" data-testid="il-stat-blocked">{result.stats.blockedEdges}</span>
            <span className="stat-label">拦截边</span>
          </div>
          <div>
            <span className="stat-value" data-testid="il-rank">
              {result.stats.initRank === null ? '∞' : result.stats.initRank}
            </span>
            <span className="stat-label">初始保证界（步）</span>
          </div>
        </div>
      </div>
      {stale && <div className="stale-hint">模型已在综合后修改，策略可能过期，请重新运行。</div>}

      {result.kind === 'unsafe' && (
        <FailureCard result={result} model={model} />
      )}

      {/* 按标记查看放行 / 拦截 */}
      <div className="card" data-testid="il-state-browser">
        <h2>按标记查看放行策略</h2>
        <div className="row">
          <label>
            标记
            <select
              data-testid="il-state-select"
              value={sel?.index ?? 0}
              onChange={(e) => setSelIdx(Number(e.target.value))}
            >
              {states.map((s) => (
                <option key={s.key} value={s.index}>
                  #{s.index} ({s.marking.join(', ')}) · {STATUS_TEXT[s.status]} · 界{s.rank === null ? '∞' : s.rank}
                  {s.onPolicy ? '' : '（策略外）'}
                </option>
              ))}
            </select>
          </label>
          <span className={`badge il-status il-status-${sel?.status}`} data-testid="il-state-status">
            {sel ? STATUS_TEXT[sel.status] : ''}
          </span>
          <span className="badge">
            保证界 <strong data-testid="il-state-rank">{sel?.rank === null || sel === undefined ? '∞' : sel.rank}</strong>
          </span>
          {sel?.onPolicy && <span className="badge loop-badge">策略可达</span>}
        </div>

        <div className="chips">
          {model.places.map((pl, i) => (
            <span key={i} className="chip" data-testid={`il-marking-chip-${i}`}>
              {pl.name}
              <strong>{sel?.marking[i] ?? 0}</strong>
            </span>
          ))}
        </div>

        {sel && sel.status !== 'acceptance' && sel.status !== 'forbidden' && sel.enabled.length === 0 && (
          <p className="hint">该标记下无任何可用变迁（非验收死锁）。</p>
        )}
        {sel && sel.status === 'acceptance' && (
          <p className="hint">验收标记为吸收态：执行成功结束，无需联锁决策。</p>
        )}
        {sel && sel.status === 'forbidden' && (
          <p className="hint">禁态：任何执行到达此处即违规，联锁必须在其上游切断所有来路。</p>
        )}

        <table className="grid-table il-edge-table">
          <thead>
            <tr>
              <th>变迁</th>
              <th>类型</th>
              <th>联锁决策</th>
              <th>逐步解释</th>
            </tr>
          </thead>
          <tbody>
            {sel?.enabled.map((e) => (
              <tr key={e.t} data-testid={`il-edge-${e.t}`} data-decision={e.decision}>
                <td>T{e.t + 1} {model.transitions[e.t].name}</td>
                <td className="dim">{e.uncontrolled ? '不可控（必然发生）' : '可控'}</td>
                <td>
                  <span className={`badge il-dec il-dec-${e.decision}`}>{DECISION_TEXT[e.decision]}</span>
                </td>
                <td className="il-reason">{e.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 回放：逐步解释策略为何放行 / 拦截 */}
      {replaySteps.length > 0 && (
        <div className="card" data-testid="il-replay">
          <h2>
            {result.kind === 'unsafe' ? '失控见证回放' : '收敛见证回放'}
            {result.kind === 'safe' && sel && sel.index > 0 && (
              <span className="badge">从标记 #{sel.index} 到验收</span>
            )}
          </h2>
          <div className="row replay-controls">
            <button className="secondary" data-testid="il-replay-reset" onClick={() => setPos(0)} disabled={pos === 0}>
              ⏮ 起点
            </button>
            <button
              className="secondary"
              data-testid="il-replay-prev"
              onClick={() => setPos((p) => Math.max(0, p - 1))}
              disabled={pos === 0}
            >
              ◀ 上一步
            </button>
            <button
              className="secondary"
              data-testid="il-replay-next"
              onClick={() => setPos((p) => Math.min(replaySteps.length, p + 1))}
              disabled={pos >= replaySteps.length}
            >
              下一步 ▶
            </button>
            <button className="secondary" data-testid="il-replay-auto" onClick={() => setAuto((a) => !a)}>
              {auto ? '⏸ 暂停' : '▶ 自动'}
            </button>
            <input
              type="range"
              data-testid="il-replay-slider"
              min={0}
              max={replaySteps.length}
              value={pos}
              onChange={(e) => setPos(Number(e.target.value))}
            />
            <span className="badge" data-testid="il-replay-position">
              {pos} / {replaySteps.length}
            </span>
          </div>
          <div className="row">
            <span data-testid="il-replay-transition" className="fired-label">
              {firedT === null
                ? result.kind === 'unsafe'
                  ? '初始标记'
                  : `标记 #${sel?.index ?? 0}`
                : `第 ${pos} 步：T${firedT + 1} · ${model.transitions[firedT].name}`}
            </span>
            {cycleStart >= 0 && pos > cycleStart && (
              <span className="badge loop-badge">↻ 不可控循环段（无限重复）</span>
            )}
            {result.kind === 'unsafe' && pos > prefixLen && pos <= cycleStart && (
              <span className="badge il-dec il-dec-forced">不可控后果链（联锁无法拒绝）</span>
            )}
            {result.kind === 'unsafe' && pos > 0 && pos <= prefixLen && (
              <span className="badge il-dec il-dec-blocked">前缀为被联锁拦截的可控操作（放行即埋下失控）</span>
            )}
          </div>
          {firedReason && (
            <p className="il-reason-box" data-testid="il-replay-reason">
              <span className="dim">策略解释：</span>
              {firedReason}
            </p>
          )}

          <NetView model={model} marking={marking} prevMarking={prevMarking} firedT={firedT} />

          <table className="grid-table steps-table">
            <thead>
              <tr>
                <th>步骤</th>
                <th>变迁</th>
                <th>决策</th>
                <th>令牌变化</th>
                <th>结果标记</th>
              </tr>
            </thead>
            <tbody>
              {replaySteps.map((s, i) => {
                const reason =
                  infoByKey
                    .get(keyOf(s.before))
                    ?.enabled.find((e) => e.t === s.t)?.reason ?? '';
                const dec = infoByKey.get(keyOf(s.before))?.enabled.find((e) => e.t === s.t)?.decision;
                return (
                  <tr
                    key={i}
                    data-testid={`il-trace-step-${i}`}
                    className={`${i === pos - 1 ? 'current' : ''} ${
                      result.kind === 'unsafe' && i === prefixLen ? 'consequence-start' : ''
                    } ${i === cycleStart ? 'cycle-start' : ''}`}
                    onClick={() => setPos(i + 1)}
                  >
                    <td>{i + 1}</td>
                    <td>T{s.t + 1} {model.transitions[s.t].name}</td>
                    <td>
                      {dec && <span className={`badge il-dec il-dec-${dec}`}>{DECISION_TEXT[dec]}</span>}
                    </td>
                    <td title={reason}>{deltaText(model, s)}</td>
                    <td className="mono">({s.after.join(', ')})</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="hint">
            {result.kind === 'unsafe'
              ? '失控见证：沿不可控坏边（最短、编号字典序最小）到达最早无法受控化解的标记；表中“决策”列说明该变迁为何无法被联锁拒绝。'
              : '收敛见证：每一步都严格减小保证界，故任意放行执行必在有限步内到达验收，且全程不进入禁态；鼠标悬停令牌变化列可看逐边解释。'}
          </p>
        </div>
      )}
    </div>
  );
}

function FailureCard({
  result,
  model,
}: {
  result: Extract<InterlockResult, { kind: 'unsafe' }>;
  model: PetriModel;
}) {
  const { failure } = result;
  const outcomeText =
    failure.outcome === 'forbidden'
      ? '不可控变迁强制执行进入禁态'
      : failure.outcome === 'cycle'
        ? '不可控变迁永久循环，永不到达验收'
        : '联锁拦截全部可控出路后形成非验收死锁';
  return (
    <div className="card il-failure" data-testid="il-failure">
      <h2>最早无法受控化解的标记与不可控后果</h2>
      <p>
        <span className="badge il-dec il-dec-blocked" data-testid="il-failure-outcome">
          {outcomeText}
        </span>
      </p>
      <table className="grid-table il-failure-table">
        <tbody>
          <tr>
            <th>最早失控标记</th>
            <td className="mono" data-testid="il-failure-marking">
              ({failure.terminalMarking.join(', ')})
            </td>
            <td className="il-reason">此处有不可控变迁一旦可用就必然发生，联锁无法拒绝</td>
          </tr>
          {failure.consequence.length > 0 && (
            <tr>
              <th>不可控后果链</th>
              <td>{failure.consequence.map((s) => `T${s.t + 1}`).join(' → ')}</td>
              <td className="il-reason">
                {failure.consequence
                  .map((s) => `T${s.t + 1}「${model.transitions[s.t].name}」`)
                  .join(' → ')}
              </td>
            </tr>
          )}
          <tr>
            <th>{failure.outcome === 'cycle' ? '循环入口标记' : '坏终局标记'}</th>
            <td className="mono" data-testid="il-failure-end">
              ({failure.endMarking.join(', ')})
            </td>
            <td className="il-reason">
              {failure.outcome === 'forbidden'
                ? '该标记满足禁态条件，执行到达即违规'
                : failure.outcome === 'cycle'
                  ? `循环（${failure.cycle.length} 步）：${failure.cycle.map((s) => `T${s.t + 1}`).join(' → ')}，可无限重复`
                  : '该标记无可用变迁或仅余会被拦截的可控出路，停滞为非验收死锁'}
            </td>
          </tr>
        </tbody>
      </table>
      {failure.trace.length > 0 && (
        <p className="hint" data-testid="il-failure-trace">
          从初始标记到最早失控标记的最短见证（{failure.trace.length} 步）：
          {failure.trace.map((s) => `T${s.t + 1}「${model.transitions[s.t].name}」`).join(' → ')}
        </p>
      )}
      {failure.blockedOptions.length > 0 && (
        <>
          <p className="hint">坏终局处被联锁拦截的可控选项，以及放行后不可控事件的必然后果：</p>
          <table className="grid-table">
            <thead>
              <tr>
                <th>被拦截的可控变迁</th>
                <th>放行后的不可控后果</th>
              </tr>
            </thead>
            <tbody>
              {failure.blockedOptions.map((o, i) => (
                <tr key={o.t} data-testid={`il-blocked-option-${i}`}>
                  <td>T{o.t + 1} {model.transitions[o.t].name}</td>
                  <td className="il-reason">{o.summary}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
