import {
  CMP_OP_LABEL,
  CmpOp,
  ForbiddenClause,
  LIMITS,
  PlaceSpec,
} from '../petri/types';

interface Props {
  places: PlaceSpec[];
  groups: ForbiddenClause[][];
  onChange: (groups: ForbiddenClause[][]) => void;
}

const OPS = Object.keys(CMP_OP_LABEL) as CmpOp[];

export function ForbiddenEditor({ places, groups, onChange }: Props) {
  const updateClause = (g: number, c: number, patch: Partial<ForbiddenClause>) => {
    onChange(
      groups.map((grp, gi) =>
        gi === g ? grp.map((cl, ci) => (ci === c ? { ...cl, ...patch } : cl)) : grp,
      ),
    );
  };

  return (
    <div className="card">
      <h2>
        禁态条件 <span className="badge">{groups.length} 组</span>
      </h2>
      <p className="hint">组内子句为“且”，组与组之间为“或”；任一条件组命中即为禁态。</p>
      {groups.map((grp, gi) => (
        <div className="forbidden-group" key={gi} data-testid={`forbidden-group-${gi}`}>
          <div className="row space-between">
            <strong>条件组 {gi + 1}</strong>
            <button
              className="icon-btn"
              data-testid={`forbidden-delete-group-${gi}`}
              onClick={() => onChange(groups.filter((_, j) => j !== gi))}
              title="删除条件组"
            >
              ✕
            </button>
          </div>
          {grp.map((cl, ci) => (
            <div className="row clause" key={ci}>
              <select
                data-testid={`forbidden-place-${gi}-${ci}`}
                value={cl.place}
                onChange={(e) => updateClause(gi, ci, { place: Number(e.target.value) })}
              >
                {places.map((pl, pi) => (
                  <option key={pi} value={pi}>
                    P{pi + 1} {pl.name}
                  </option>
                ))}
              </select>
              <select
                data-testid={`forbidden-op-${gi}-${ci}`}
                value={cl.op}
                onChange={(e) => updateClause(gi, ci, { op: e.target.value as CmpOp })}
              >
                {OPS.map((op) => (
                  <option key={op} value={op}>
                    {CMP_OP_LABEL[op]}
                  </option>
                ))}
              </select>
              <input
                data-testid={`forbidden-value-${gi}-${ci}`}
                type="number"
                min={0}
                max={LIMITS.maxForbiddenValue}
                value={cl.value}
                onChange={(e) => {
                  const n = Number.parseInt(e.target.value, 10);
                  updateClause(gi, ci, {
                    value: Number.isNaN(n)
                      ? 0
                      : Math.max(0, Math.min(LIMITS.maxForbiddenValue, n)),
                  });
                }}
              />
              <button
                className="icon-btn"
                data-testid={`forbidden-delete-clause-${gi}-${ci}`}
                onClick={() =>
                  onChange(
                    groups
                      .map((g2, gj) => (gj === gi ? g2.filter((_, cj) => cj !== ci) : g2))
                      .filter((g2) => g2.length > 0),
                  )
                }
                title="删除子句"
              >
                ✕
              </button>
            </div>
          ))}
          <button
            className="secondary small"
            data-testid={`forbidden-add-clause-${gi}`}
            onClick={() =>
              onChange(
                groups.map((g2, gj) =>
                  gj === gi ? [...g2, { place: 0, op: 'ge', value: 1 }] : g2,
                ),
              )
            }
          >
            + 子句
          </button>
        </div>
      ))}
      <button
        className="secondary"
        data-testid="forbidden-add-group"
        onClick={() => onChange([...groups, [{ place: 0, op: 'ge', value: 1 }]])}
      >
        + 添加条件组
      </button>
    </div>
  );
}
