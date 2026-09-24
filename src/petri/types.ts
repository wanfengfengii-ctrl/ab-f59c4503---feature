/**
 * 有界 Petri 网模型定义。
 *
 * 语义约定：
 * - 每个库所 p 有容量 capacity ∈ [0,3]，令牌数恒满足 0 ≤ m[p] ≤ capacity。
 * - 变迁按前置弧 pre / 后置弧 post（非负整数）原子触发：
 *   当且仅当对所有库所 m[p] ≥ pre[p] 且 m[p] - pre[p] + post[p] ≤ capacity[p] 时可用，
 *   触发后 m'[p] = m[p] - pre[p] + post[p]。
 * - 验收标记为一个完整的目标令牌向量，到达即结束该次执行（吸收态，不再触发变迁）。
 * - 禁态条件为子句组的析取范式（DNF）：组内所有子句同时成立（且），任一组成立（或）即为禁态。
 */

export type CmpOp = 'eq' | 'ne' | 'lt' | 'le' | 'gt' | 'ge';

export const CMP_OP_LABEL: Record<CmpOp, string> = {
  eq: '=',
  ne: '≠',
  lt: '<',
  le: '≤',
  gt: '>',
  ge: '≥',
};

export interface ForbiddenClause {
  /** 库所下标 */
  place: number;
  op: CmpOp;
  value: number;
}

export interface PlaceSpec {
  name: string;
  /** 容量 0..3 */
  capacity: number;
  /** 初始令牌 0..capacity */
  initial: number;
  /** 验收标记中该库所应有的令牌数 0..capacity */
  acceptance: number;
}

export interface TransitionSpec {
  name: string;
  /** 前置弧权，长度 = 库所数 */
  pre: number[];
  /** 后置弧权，长度 = 库所数 */
  post: number[];
  /**
   * 联锁可控性（仅供联锁综合使用，不影响既有审计语义）：
   * - true（或缺省）：可控变迁，联锁可以拒绝（拦截）其触发；
   * - false：不可控变迁（现场必然发生的动作 / 自发事件），一旦可用联锁必须放行并纳入保证。
   * 旧模型未填写该属性时按可控处理，且原审计结果完全不变。
   */
  controlled?: boolean;
}

export interface PetriModel {
  places: PlaceSpec[];
  transitions: TransitionSpec[];
  /** 禁态条件：DNF，外层数组为“或”，内层数组为“且”。空数组表示无禁态。 */
  forbidden: ForbiddenClause[][];
}

export const LIMITS = {
  minPlaces: 2,
  maxPlaces: 18,
  minTransitions: 1,
  maxTransitions: 40,
  maxCapacity: 3,
  maxArcWeight: 9,
  maxForbiddenValue: 3,
} as const;

export function applyCmp(lhs: number, op: CmpOp, rhs: number): boolean {
  switch (op) {
    case 'eq': return lhs === rhs;
    case 'ne': return lhs !== rhs;
    case 'lt': return lhs < rhs;
    case 'le': return lhs <= rhs;
    case 'gt': return lhs > rhs;
    case 'ge': return lhs >= rhs;
  }
}
