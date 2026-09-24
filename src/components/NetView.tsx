import { useMemo } from 'react';
import { PetriModel } from '../petri/types';

interface Props {
  model: PetriModel;
  /** 当前回放位置的标记 */
  marking: number[];
  /** 上一步之前的标记（用于计算令牌变化），初始位置为 null */
  prevMarking: number[] | null;
  /** 上一步触发的变迁下标，初始位置为 null */
  firedT: number | null;
}

const W = 640;
const H = 640;
const CX = W / 2;
const CY = H / 2;
const R_PLACE = 236;
const R_TRANS = 128;

function angleOf(i: number, n: number): number {
  return -Math.PI / 2 + (i * 2 * Math.PI) / n;
}

/** 圆形布局的 Petri 网可视化：外圈库所、内圈变迁，支持令牌变化高亮。 */
export function NetView({ model, marking, prevMarking, firedT }: Props) {
  const P = model.places.length;
  const T = model.transitions.length;

  const placePos = useMemo(
    () =>
      model.places.map((_, i) => ({
        x: CX + R_PLACE * Math.cos(angleOf(i, P)),
        y: CY + R_PLACE * Math.sin(angleOf(i, P)),
      })),
    [model.places, P],
  );
  const transPos = useMemo(
    () =>
      model.transitions.map((_, j) => {
        const a = angleOf(j, T) + Math.PI / T; // 错开半格，减少与库所连线重叠
        return { x: CX + R_TRANS * Math.cos(a), y: CY + R_TRANS * Math.sin(a), a };
      }),
    [model.transitions, T],
  );

  const enabled = useMemo(() => {
    const set = new Set<number>();
    model.transitions.forEach((t, j) => {
      let ok = true;
      for (let i = 0; i < P; i++) {
        const m = marking[i];
        if (m < t.pre[i] || m - t.pre[i] + t.post[i] > model.places[i].capacity) {
          ok = false;
          break;
        }
      }
      if (ok) set.add(j);
    });
    return set;
  }, [model, marking, P]);

  const delta = (i: number): number => (prevMarking ? marking[i] - prevMarking[i] : 0);

  return (
    <svg
      className="net-view"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label="Petri 网结构图"
      data-testid="net-view"
    >
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 1 L 9 5 L 0 9 z" fill="#7d8aa5" />
        </marker>
        <marker id="arrow-hot" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 1 L 9 5 L 0 9 z" fill="#f59e0b" />
        </marker>
      </defs>

      {/* 弧 */}
      {model.transitions.map((t, j) => {
        const tp = transPos[j];
        const hot = j === firedT;
        const segs: React.ReactNode[] = [];
        t.pre.forEach((w, i) => {
          if (w <= 0) return;
          const pp = placePos[i];
          segs.push(
            <line
              key={`pre-${j}-${i}`}
              x1={pp.x}
              y1={pp.y}
              x2={tp.x}
              y2={tp.y}
              className={`arc ${hot ? 'hot' : ''}`}
              markerEnd={`url(#arrow${hot ? '-hot' : ''})`}
            />,
          );
          if (w > 1) {
            segs.push(
              <text key={`prew-${j}-${i}`} x={(pp.x + tp.x) / 2} y={(pp.y + tp.y) / 2 - 4} className="arc-weight">
                {w}
              </text>,
            );
          }
        });
        t.post.forEach((w, i) => {
          if (w <= 0) return;
          const pp = placePos[i];
          segs.push(
            <line
              key={`post-${j}-${i}`}
              x1={tp.x}
              y1={tp.y}
              x2={pp.x}
              y2={pp.y}
              className={`arc ${hot ? 'hot' : ''}`}
              markerEnd={`url(#arrow${hot ? '-hot' : ''})`}
            />,
          );
          if (w > 1) {
            segs.push(
              <text key={`postw-${j}-${i}`} x={(pp.x + tp.x) / 2 + 6} y={(pp.y + tp.y) / 2 + 10} className="arc-weight">
                {w}
              </text>,
            );
          }
        });
        return segs;
      })}

      {/* 变迁 */}
      {model.transitions.map((_t, j) => {
        const tp = transPos[j];
        const deg = (tp.a * 180) / Math.PI + 90;
        const cls = `transition-bar ${j === firedT ? 'fired' : ''} ${enabled.has(j) ? 'enabled' : ''}`;
        return (
          <g key={j} data-testid={`net-transition-${j}`}>
            <rect
              x={-16}
              y={-5}
              width={32}
              height={10}
              rx={2}
              transform={`translate(${tp.x} ${tp.y}) rotate(${deg})`}
              className={cls}
            />
            <text x={tp.x} y={tp.y - 12} className="trans-label">
              T{j + 1}
            </text>
          </g>
        );
      })}

      {/* 库所 */}
      {model.places.map((pl, i) => {
        const pp = placePos[i];
        const d = delta(i);
        const tokens = marking[i];
        return (
          <g key={i} data-testid={`net-place-${i}`}>
            <circle cx={pp.x} cy={pp.y} r={27} className={`place-circle ${d !== 0 ? 'changed' : ''}`} />
            {/* 验收标记：绿色双圈 */}
            <circle cx={pp.x} cy={pp.y} r={33} className="acceptance-ring" />
            {/* 令牌点 */}
            {Array.from({ length: tokens }).map((_, k) => {
              const a = angleOf(k, Math.max(tokens, 1)) - Math.PI / 2;
              const rr = tokens === 1 ? 0 : 11;
              return (
                <circle
                  key={k}
                  cx={pp.x + rr * Math.cos(a)}
                  cy={pp.y + rr * Math.sin(a)}
                  r={5.5}
                  className="token-dot"
                />
              );
            })}
            <text x={pp.x} y={pp.y + 44} className="place-label">
              P{i + 1} {pl.name}
            </text>
            <text x={pp.x} y={pp.y + 58} className="place-sub">
              容量{pl.capacity} · 验收{pl.acceptance}
            </text>
            {/* 令牌变化角标 */}
            {d !== 0 && (
              <g data-testid={`delta-badge-${i}`}>
                <circle cx={pp.x + 24} cy={pp.y - 24} r={12} className={`delta-badge ${d > 0 ? 'up' : 'down'}`} />
                <text x={pp.x + 24} y={pp.y - 19.5} className="delta-text">
                  {d > 0 ? `+${d}` : d}
                </text>
              </g>
            )}
          </g>
        );
      })}
    </svg>
  );
}
