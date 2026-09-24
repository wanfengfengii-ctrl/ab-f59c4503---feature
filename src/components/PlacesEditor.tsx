import { LIMITS, PlaceSpec } from '../petri/types';

interface Props {
  places: PlaceSpec[];
  onChange: (places: PlaceSpec[]) => void;
}

const clampInt = (v: string, lo: number, hi: number): number => {
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
};

export function PlacesEditor({ places, onChange }: Props) {
  const update = (i: number, patch: Partial<PlaceSpec>) => {
    const next = places.map((pl, j) => (j === i ? { ...pl, ...patch } : pl));
    if (patch.capacity !== undefined) {
      next[i].initial = Math.min(next[i].initial, patch.capacity);
      next[i].acceptance = Math.min(next[i].acceptance, patch.capacity);
    }
    onChange(next);
  };

  const addPlace = () => {
    if (places.length >= LIMITS.maxPlaces) return;
    onChange([
      ...places,
      { name: `P${places.length + 1}`, capacity: 1, initial: 0, acceptance: 0 },
    ]);
  };

  const removePlace = (i: number) => {
    if (places.length <= LIMITS.minPlaces) return;
    onChange(places.filter((_, j) => j !== i));
  };

  return (
    <div className="card">
      <h2>
        库所 <span className="badge">{places.length} / {LIMITS.maxPlaces}</span>
      </h2>
      <table className="grid-table">
        <thead>
          <tr>
            <th>#</th>
            <th>名称</th>
            <th>容量(0-3)</th>
            <th>初始令牌</th>
            <th>验收令牌</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {places.map((pl, i) => (
            <tr key={i}>
              <td className="dim">P{i + 1}</td>
              <td>
                <input
                  data-testid={`place-name-${i}`}
                  value={pl.name}
                  onChange={(e) => update(i, { name: e.target.value })}
                />
              </td>
              <td>
                <select
                  data-testid={`place-capacity-${i}`}
                  value={pl.capacity}
                  onChange={(e) => update(i, { capacity: Number(e.target.value) })}
                >
                  {[0, 1, 2, 3].map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <input
                  data-testid={`place-initial-${i}`}
                  type="number"
                  min={0}
                  max={pl.capacity}
                  value={pl.initial}
                  onChange={(e) => update(i, { initial: clampInt(e.target.value, 0, pl.capacity) })}
                />
              </td>
              <td>
                <input
                  data-testid={`place-acceptance-${i}`}
                  type="number"
                  min={0}
                  max={pl.capacity}
                  value={pl.acceptance}
                  onChange={(e) =>
                    update(i, { acceptance: clampInt(e.target.value, 0, pl.capacity) })
                  }
                />
              </td>
              <td>
                <button
                  className="icon-btn"
                  data-testid={`place-delete-${i}`}
                  disabled={places.length <= LIMITS.minPlaces}
                  onClick={() => removePlace(i)}
                  title="删除库所"
                >
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button
        data-testid="add-place"
        className="secondary"
        disabled={places.length >= LIMITS.maxPlaces}
        onClick={addPlace}
      >
        + 添加库所
      </button>
    </div>
  );
}
