import {
  CmpOp,
  LIMITS,
  PetriModel,
} from './types';

const CMP_OPS: CmpOp[] = ['eq', 'ne', 'lt', 'le', 'gt', 'ge'];

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

/**
 * 校验并规范化外部输入（导入的 JSON 或编辑器状态）。
 * 返回错误信息列表；为空表示模型合法，可直接交给审计引擎。
 */
export function validateModel(raw: unknown): { errors: string[]; model: PetriModel | null } {
  const errors: string[] = [];
  if (typeof raw !== 'object' || raw === null) {
    return { errors: ['模型必须是 JSON 对象'], model: null };
  }
  const m = raw as Record<string, unknown>;

  // ---- 库所 ----
  if (!Array.isArray(m.places)) {
    return { errors: ['缺少 places 数组'], model: null };
  }
  const places = m.places as unknown[];
  if (places.length < LIMITS.minPlaces || places.length > LIMITS.maxPlaces) {
    errors.push(`库所数量必须在 ${LIMITS.minPlaces}..${LIMITS.maxPlaces} 之间（当前 ${places.length}）`);
  }
  const normPlaces = places.map((p, i) => {
    const o = (typeof p === 'object' && p !== null ? p : {}) as Record<string, unknown>;
    const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim() : `P${i + 1}`;
    const capacity = isInt(o.capacity) ? o.capacity : NaN;
    const initial = isInt(o.initial) ? o.initial : NaN;
    const acceptance = isInt(o.acceptance) ? o.acceptance : NaN;
    if (!isInt(o.capacity) || capacity < 0 || capacity > LIMITS.maxCapacity) {
      errors.push(`库所 ${name}：容量必须是 0..${LIMITS.maxCapacity} 的整数`);
    }
    if (!isInt(o.initial) || initial < 0 || initial > capacity) {
      errors.push(`库所 ${name}：初始令牌必须是 0..容量 的整数`);
    }
    if (!isInt(o.acceptance) || acceptance < 0 || acceptance > capacity) {
      errors.push(`库所 ${name}：验收令牌必须是 0..容量 的整数`);
    }
    return { name, capacity: capacity || 0, initial: initial || 0, acceptance: acceptance || 0 };
  });

  // ---- 变迁 ----
  if (!Array.isArray(m.transitions)) {
    return { errors: ['缺少 transitions 数组'], model: null };
  }
  const transitions = m.transitions as unknown[];
  if (transitions.length < LIMITS.minTransitions || transitions.length > LIMITS.maxTransitions) {
    errors.push(`变迁数量必须在 ${LIMITS.minTransitions}..${LIMITS.maxTransitions} 之间（当前 ${transitions.length}）`);
  }
  const normTransitions = transitions.map((t, i) => {
    const o = (typeof t === 'object' && t !== null ? t : {}) as Record<string, unknown>;
    const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim() : `T${i + 1}`;
    // 可控属性缺省视为可控；显式给出时必须为布尔值。
    const controlled = o.controlled === undefined ? true : o.controlled;
    if (o.controlled !== undefined && typeof o.controlled !== 'boolean') {
      errors.push(`变迁 ${name}：可控属性 controlled 必须是布尔值（true=可控 / false=不可控）`);
    }
    const readArcs = (key: 'pre' | 'post'): number[] => {
      const arr = Array.isArray(o[key]) ? (o[key] as unknown[]) : [];
      return normPlaces.map((_, pi) => {
        const v = arr[pi];
        if (v === undefined || v === null) return 0;
        if (!isInt(v) || v < 0 || v > LIMITS.maxArcWeight) {
          errors.push(`变迁 ${name}：${key === 'pre' ? '前置' : '后置'}弧[${pi}] 必须是 0..${LIMITS.maxArcWeight} 的整数`);
          return 0;
        }
        return v;
      });
    };
    return { name, controlled: controlled !== false, pre: readArcs('pre'), post: readArcs('post') };
  });

  // ---- 禁态条件（DNF）----
  const rawForbidden = Array.isArray(m.forbidden) ? (m.forbidden as unknown[]) : [];
  const normForbidden = rawForbidden.map((group, gi) => {
    const clauses = Array.isArray(group) ? (group as unknown[]) : [];
    if (clauses.length === 0) {
      errors.push(`禁态条件组 ${gi + 1}：至少需要一条子句`);
    }
    return clauses.map((c, ci) => {
      const o = (typeof c === 'object' && c !== null ? c : {}) as Record<string, unknown>;
      const place = isInt(o.place) ? o.place : -1;
      const op = CMP_OPS.includes(o.op as CmpOp) ? (o.op as CmpOp) : null;
      const value = isInt(o.value) ? o.value : NaN;
      if (place < 0 || place >= normPlaces.length) {
        errors.push(`禁态条件组 ${gi + 1} 子句 ${ci + 1}：库所下标无效`);
      }
      if (!op) {
        errors.push(`禁态条件组 ${gi + 1} 子句 ${ci + 1}：比较算子必须是 ${CMP_OPS.join('/')}`);
      }
      if (!isInt(o.value) || value < 0 || value > LIMITS.maxForbiddenValue) {
        errors.push(`禁态条件组 ${gi + 1} 子句 ${ci + 1}：取值必须是 0..${LIMITS.maxForbiddenValue} 的整数`);
      }
      return { place: Math.max(0, place), op: op ?? 'eq', value: value || 0 };
    });
  });

  if (errors.length > 0) {
    return { errors, model: null };
  }
  return {
    errors: [],
    model: { places: normPlaces, transitions: normTransitions, forbidden: normForbidden },
  };
}
