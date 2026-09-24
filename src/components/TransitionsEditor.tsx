import { useEffect, useState } from 'react';
import { LIMITS, PlaceSpec, TransitionSpec } from '../petri/types';

interface Props {
  places: PlaceSpec[];
  transitions: TransitionSpec[];
  onChange: (transitions: TransitionSpec[]) => void;
}

const clampWeight = (v: string): number => {
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(LIMITS.maxArcWeight, n));
};

export function TransitionsEditor({ places, transitions, onChange }: Props) {
  const [selected, setSelected] = useState(0);
  useEffect(() => {
    if (selected >= transitions.length) setSelected(transitions.length - 1);
  }, [transitions.length, selected]);

  const cur = transitions[selected];

  const update = (i: number, patch: Partial<TransitionSpec>) => {
    onChange(transitions.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  };

  const setArc = (kind: 'pre' | 'post', placeIdx: number, weight: number) => {
    const arr = cur[kind].slice();
    arr[placeIdx] = weight;
    update(selected, { [kind]: arr } as Partial<TransitionSpec>);
  };

  const addTransition = () => {
    if (transitions.length >= LIMITS.maxTransitions) return;
    onChange([
      ...transitions,
      {
        name: `T${transitions.length + 1}`,
        pre: places.map(() => 0),
        post: places.map(() => 0),
      },
    ]);
    setSelected(transitions.length);
  };

  const removeTransition = (i: number) => {
    if (transitions.length <= LIMITS.minTransitions) return;
    onChange(transitions.filter((_, j) => j !== i));
  };

  return (
    <div className="card">
      <h2>
        变迁 <span className="badge">{transitions.length} / {LIMITS.maxTransitions}</span>
      </h2>
      <div className="transition-editor">
        <div className="transition-list">
          {transitions.map((t, i) => (
            <button
              key={i}
              data-testid={`transition-item-${i}`}
              className={`transition-item ${i === selected ? 'active' : ''}`}
              onClick={() => setSelected(i)}
              title={t.controlled === false ? '不可控变迁：现场必然发生，联锁必须放行' : '可控变迁：联锁可拦截'}
            >
              <span className="dim">T{i + 1}</span> {t.name}
              <span className={`ctrl-tag ${t.controlled === false ? 'uncontrolled' : ''}`}>
                {t.controlled === false ? '不可控' : '可控'}
              </span>
            </button>
          ))}
          <button
            data-testid="add-transition"
            className="secondary"
            disabled={transitions.length >= LIMITS.maxTransitions}
            onClick={addTransition}
          >
            + 添加变迁
          </button>
        </div>
        {cur && (
          <div className="transition-detail">
            <div className="row">
              <label>
                名称
                <input
                  data-testid="transition-name"
                  value={cur.name}
                  onChange={(e) => update(selected, { name: e.target.value })}
                />
              </label>
              <label className="controlled-toggle" title="可控变迁可被联锁拒绝；不可控变迁表示现场必然发生的动作 / 自发事件，一旦可用联锁必须放行">
                <input
                  data-testid={`transition-controlled-${selected}`}
                  type="checkbox"
                  checked={cur.controlled !== false}
                  onChange={(e) => update(selected, { controlled: e.target.checked })}
                />
                可控（联锁可拦截）；取消勾选＝不可控（现场必然发生）
              </label>
              <button
                data-testid="delete-transition"
                className="danger"
                disabled={transitions.length <= LIMITS.minTransitions}
                onClick={() => removeTransition(selected)}
              >
                删除变迁
              </button>
            </div>
            <table className="grid-table">
              <thead>
                <tr>
                  <th>库所</th>
                  <th>前置弧</th>
                  <th>后置弧</th>
                </tr>
              </thead>
              <tbody>
                {places.map((pl, pi) => (
                  <tr key={pi}>
                    <td>
                      <span className="dim">P{pi + 1}</span> {pl.name}
                    </td>
                    <td>
                      <input
                        data-testid={`arc-pre-${pi}`}
                        type="number"
                        min={0}
                        max={LIMITS.maxArcWeight}
                        value={cur.pre[pi] ?? 0}
                        onChange={(e) => setArc('pre', pi, clampWeight(e.target.value))}
                      />
                    </td>
                    <td>
                      <input
                        data-testid={`arc-post-${pi}`}
                        type="number"
                        min={0}
                        max={LIMITS.maxArcWeight}
                        value={cur.post[pi] ?? 0}
                        onChange={(e) => setArc('post', pi, clampWeight(e.target.value))}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="hint">
              触发条件：所有库所令牌 ≥ 前置弧，且触发后不超过库所容量；触发是原子的。
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
