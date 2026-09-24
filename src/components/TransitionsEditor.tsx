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
            >
              <span className="dim">T{i + 1}</span> {t.name}
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
