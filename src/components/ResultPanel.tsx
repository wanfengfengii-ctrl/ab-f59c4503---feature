import { useEffect, useMemo, useState } from 'react';
import { AuditResult, Step, VERDICT_TEXT } from '../petri/audit';
import { PetriModel } from '../petri/types';
import { NetView } from './NetView';

interface Props {
  result: AuditResult | null;
  running: boolean;
  model: PetriModel;
  stale: boolean;
}

function deltaText(model: PetriModel, s: Step): string {
  const parts: string[] = [];
  for (let i = 0; i < model.places.length; i++) {
    const d = s.after[i] - s.before[i];
    if (d !== 0) parts.push(`${model.places[i].name} ${s.before[i]}→${s.after[i]}`);
  }
  return parts.join('，') || '（无变化）';
}

export function ResultPanel({ result, running, model, stale }: Props) {
  const steps: Step[] = useMemo(() => {
    if (!result) return [];
    if (result.kind === 'forbidden' || result.kind === 'deadlock') return result.trace;
    if (result.kind === 'lasso') return [...result.prefix, ...result.cycle];
    return [];
  }, [result]);

  const cycleStart = result?.kind === 'lasso' ? result.prefix.length : -1;
  const [pos, setPos] = useState(0);
  const [auto, setAuto] = useState(false);

  // 新结果出来时跳到末态（反例现场），便于立即看到违规状态
  useEffect(() => {
    setAuto(false);
    setPos(steps.length);
  }, [result, steps.length]);

  // 自动播放：普通轨迹播到结尾停止；套索在循环段内无限回绕
  useEffect(() => {
    if (!auto || steps.length === 0) return;
    const timer = setInterval(() => {
      setPos((p) => {
        if (p >= steps.length) {
          if (cycleStart >= 0) return cycleStart; // 回到循环起点，演示无限执行
          setAuto(false);
          return p;
        }
        return p + 1;
      });
    }, 900);
    return () => clearInterval(timer);
  }, [auto, steps.length, cycleStart]);

  if (!result) {
    return (
      <div className="card result-panel" data-testid="result-empty">
        <h2>审计结果</h2>
        <p className="hint">{running ? '审计中……' : '编辑模型后点击「运行审计」'}</p>
      </div>
    );
  }

  const initial = model.places.map((p) => p.initial);
  const marking = pos === 0 ? initial : steps[pos - 1].after;
  const prevMarking = pos === 0 ? null : steps[pos - 1].before;
  const firedT = pos === 0 ? null : steps[pos - 1].t;

  return (
    <div className="result-panel">
      <div className={`verdict verdict-${result.kind}`} data-testid="verdict">
        {result.kind === 'verified' && '✅ '}
        {(result.kind === 'forbidden' || result.kind === 'deadlock') && '⛔ '}
        {result.kind === 'lasso' && '♾️ '}
        {result.kind === 'error' && '⚠️ '}
        {VERDICT_TEXT[result.kind]}
        {result.kind === 'forbidden' || result.kind === 'deadlock'
          ? `（最短 ${steps.length} 步）`
          : ''}
        {result.kind === 'lasso'
          ? `（前缀 ${result.prefix.length} 步 + 循环 ${result.cycle.length} 步）`
          : ''}
      </div>
      {stale && <div className="stale-hint">模型已在审计后修改，结果可能过期，请重新运行。</div>}
      {result.kind === 'error' && (
        <div className="card">
          <p data-testid="error-message">{result.message}</p>
        </div>
      )}
      {result.kind !== 'error' && (
        <div className="card stats" data-testid="stats">
          <div>
            <span className="stat-value" data-testid="stat-states">{result.stats.states}</span>
            <span className="stat-label">可达状态</span>
          </div>
          <div>
            <span className="stat-value" data-testid="stat-edges">{result.stats.edges}</span>
            <span className="stat-label">变迁边</span>
          </div>
          <div>
            <span className="stat-value">{result.stats.maxDepth}</span>
            <span className="stat-label">最大深度</span>
          </div>
          <div>
            <span className="stat-value">{result.stats.timeMs} ms</span>
            <span className="stat-label">耗时</span>
          </div>
        </div>
      )}

      {steps.length > 0 && (
        <div className="card">
          <h2>反例回放</h2>
          <div className="row replay-controls">
            <button
              className="secondary"
              data-testid="replay-reset"
              onClick={() => setPos(0)}
              disabled={pos === 0}
            >
              ⏮ 初始
            </button>
            <button
              className="secondary"
              data-testid="replay-prev"
              onClick={() => setPos((p) => Math.max(0, p - 1))}
              disabled={pos === 0}
            >
              ◀ 上一步
            </button>
            <button
              className="secondary"
              data-testid="replay-next"
              onClick={() => setPos((p) => Math.min(steps.length, p + 1))}
              disabled={pos >= steps.length}
            >
              下一步 ▶
            </button>
            <button
              className="secondary"
              data-testid="replay-auto"
              onClick={() => setAuto((a) => !a)}
            >
              {auto ? '⏸ 暂停' : '▶ 自动'}
            </button>
            <input
              type="range"
              data-testid="replay-slider"
              min={0}
              max={steps.length}
              value={pos}
              onChange={(e) => setPos(Number(e.target.value))}
            />
            <span className="badge" data-testid="replay-position">
              {pos} / {steps.length}
            </span>
          </div>
          <div className="row">
            <span data-testid="replay-transition" className="fired-label">
              {firedT === null
                ? '初始标记'
                : `第 ${pos} 步：T${firedT + 1} · ${model.transitions[firedT].name}`}
            </span>
            {cycleStart >= 0 && pos > cycleStart && (
              <span className="badge loop-badge">↻ 循环段（无限重复）</span>
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
                  data-testid={`marking-chip-${i}`}
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
                <th>令牌变化</th>
                <th>结果标记</th>
              </tr>
            </thead>
            <tbody>
              {steps.map((s, i) => (
                <tr
                  key={i}
                  data-testid={`trace-step-${i}`}
                  className={`${i === pos - 1 ? 'current' : ''} ${i === cycleStart ? 'cycle-start' : ''}`}
                  onClick={() => setPos(i + 1)}
                >
                  <td>
                    {i === cycleStart && (
                      <span className="badge loop-badge" data-testid="cycle-start">
                        ↻ 循环起点
                      </span>
                    )}{' '}
                    {i + 1}
                  </td>
                  <td>
                    T{s.t + 1} {model.transitions[s.t].name}
                  </td>
                  <td>{deltaText(model, s)}</td>
                  <td className="mono">({s.after.join(', ')})</td>
                </tr>
              ))}
            </tbody>
          </table>
          {cycleStart >= 0 && (
            <p className="hint">
              套索见证：前缀 {result?.kind === 'lasso' ? result.prefix.length : 0} 步进入循环，
              循环 {result?.kind === 'lasso' ? result.cycle.length : 0} 步可无限重复，永不到达验收标记。
            </p>
          )}
        </div>
      )}
      {(result.kind === 'forbidden' || result.kind === 'deadlock') && steps.length === 0 && (
        <div className="card">
          <p className="hint">初始标记即构成反例（0 步）。</p>
        </div>
      )}
    </div>
  );
}
