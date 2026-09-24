import { PetriModel } from './types';

export interface Sample {
  key: string;
  label: string;
  description: string;
  model: PetriModel;
}

const p = (name: string, capacity: number, initial: number, acceptance: number) => ({
  name,
  capacity,
  initial,
  acceptance,
});
const t = (name: string, pre: number[], post: number[], controllable?: boolean) => ({
  name,
  pre,
  post,
  ...(controllable === undefined ? {} : { controllable }),
});

export const SAMPLES: Sample[] = [
  {
    key: 'sequential',
    label: '双阀顺序灌装（应通过）',
    description: '阀A→阀B→完成，线性流程，所有执行终止于验收。',
    model: {
      places: [
        p('就绪', 1, 1, 0),
        p('阀A开启', 1, 0, 0),
        p('阀B开启', 1, 0, 0),
        p('灌装完成', 1, 0, 1),
      ],
      transitions: [
        t('开阀A', [1, 0, 0, 0], [0, 1, 0, 0]),
        t('开阀B', [0, 1, 0, 0], [0, 0, 1, 0]),
        t('完成灌装', [0, 0, 1, 0], [0, 0, 0, 1]),
      ],
      forbidden: [],
    },
  },
  {
    key: 'deadlock',
    label: '泵空转分支（非验收死锁）',
    description: '“空转”分支把令牌带入无出边的过热态，形成非验收死锁。',
    model: {
      places: [
        p('就绪', 1, 1, 0),
        p('泵运行', 1, 0, 0),
        p('完成', 1, 0, 1),
        p('空转过热', 1, 0, 0),
      ],
      transitions: [
        t('启动泵', [1, 0, 0, 0], [0, 1, 0, 0]),
        t('正常停机', [0, 1, 0, 0], [0, 0, 1, 0]),
        t('空转', [1, 0, 0, 0], [0, 0, 0, 1]),
      ],
      forbidden: [],
    },
  },
  {
    key: 'forbidden',
    label: '双阀同开（禁态）',
    description: '开B时未关A，两阀同时开启即进入禁态（组内“且”语义）。',
    model: {
      places: [
        p('空闲', 1, 1, 0),
        p('阀A开', 1, 0, 0),
        p('阀B开', 1, 0, 0),
        p('完成', 1, 0, 1),
      ],
      transitions: [
        t('开A', [1, 0, 0, 0], [0, 1, 0, 0]),
        t('开B保持A', [0, 1, 0, 0], [0, 1, 1, 0]),
        t('关B完成', [0, 0, 1, 0], [0, 0, 0, 1]),
      ],
      forbidden: [
        [
          { place: 1, op: 'ge', value: 1 },
          { place: 2, op: 'ge', value: 1 },
        ],
      ],
    },
  },
  {
    key: 'lasso',
    label: '清洗循环（套索 / 无限执行）',
    description: '“重新配料”把令牌带回就绪态，可永远循环而不到达验收。',
    model: {
      places: [
        p('就绪', 1, 1, 0),
        p('清洗中', 1, 0, 0),
        p('已完成', 1, 0, 1),
      ],
      transitions: [
        t('开始清洗', [1, 0, 0], [0, 1, 0]),
        t('重新配料', [0, 1, 0], [1, 0, 0]),
        t('结束清洗', [0, 1, 0], [0, 0, 1]),
      ],
      forbidden: [],
    },
  },
  {
    key: 'pipeline',
    label: '双批次配料产线（应通过）',
    description: '两枚批次令牌依次经过投料→搅拌→泵送→灌装→清洗→验收，容量为 1 的工位保证互斥。',
    model: {
      places: [
        p('批次令牌', 2, 2, 0),
        p('配料中', 1, 0, 0),
        p('搅拌中', 1, 0, 0),
        p('泵送中', 1, 0, 0),
        p('待灌装', 1, 0, 0),
        p('灌装中', 1, 0, 0),
        p('清洗中', 1, 0, 0),
        p('验收批次', 2, 0, 2),
      ],
      transitions: [
        t('投料', [1, 0, 0, 0, 0, 0, 0, 0], [0, 1, 0, 0, 0, 0, 0, 0]),
        t('搅拌', [0, 1, 0, 0, 0, 0, 0, 0], [0, 0, 1, 0, 0, 0, 0, 0]),
        t('泵送', [0, 0, 1, 0, 0, 0, 0, 0], [0, 0, 0, 1, 0, 0, 0, 0]),
        t('灌装准备', [0, 0, 0, 1, 0, 0, 0, 0], [0, 0, 0, 0, 1, 0, 0, 0]),
        t('灌装', [0, 0, 0, 0, 1, 0, 0, 0], [0, 0, 0, 0, 0, 1, 0, 0]),
        t('清洗', [0, 0, 0, 0, 0, 1, 0, 0], [0, 0, 0, 0, 0, 0, 1, 0]),
        t('批次验收', [0, 0, 0, 0, 0, 0, 1, 0], [0, 0, 0, 0, 0, 0, 0, 1]),
      ],
      forbidden: [],
    },
  },
  {
    key: 'il-safe',
    label: '【联锁】自动完工+可拦截排空（可保证）',
    description: '“自动完工”是不可控变迁（现场必然发生但必达验收，纳入保证）；“手动排空”是可控变迁，会进入非验收死锁，被联锁拦截。',
    model: {
      places: [
        p('就绪', 1, 1, 0),
        p('加工中', 1, 0, 0),
        p('废料', 1, 0, 0),
        p('完成', 1, 0, 1),
      ],
      transitions: [
        t('开始加工', [1, 0, 0, 0], [0, 1, 0, 0], true),
        t('自动完工', [0, 1, 0, 0], [0, 0, 0, 1], false),
        t('手动排空', [1, 0, 0, 0], [0, 0, 1, 0], true),
      ],
      forbidden: [],
    },
  },
  {
    key: 'il-uncontrollable',
    label: '【联锁】突发超压不可控（无法保证）',
    description: '就绪态存在不可控的“突发超压”变迁，联锁无法拒绝且其后果为禁态——最早无法受控化解的标记即初始标记。',
    model: {
      places: [
        p('就绪', 1, 1, 0),
        p('正常运行', 1, 0, 0),
        p('完成', 1, 0, 1),
        p('超压', 1, 0, 0),
      ],
      transitions: [
        t('启动', [1, 0, 0, 0], [0, 1, 0, 0], true),
        t('自动完工', [0, 1, 0, 0], [0, 0, 1, 0], false),
        t('突发超压', [1, 0, 0, 0], [0, 0, 0, 1], false),
      ],
      forbidden: [
        [{ place: 3, op: 'ge', value: 1 }],
      ],
    },
  },
  {
    key: 'il-choice',
    label: '【联锁】双工位选择与回退（最大宽容）',
    description: '两条受控路径都严格推进至验收，故均被放行；“回退”把令牌带回更高收敛层，不保证严格推进，被拦截。',
    model: {
      places: [
        p('就绪', 1, 1, 0),
        p('A工位', 1, 0, 0),
        p('B工位', 1, 0, 0),
        p('完成', 1, 0, 1),
      ],
      transitions: [
        t('选A', [1, 0, 0, 0], [0, 1, 0, 0], true),
        t('选B', [1, 0, 0, 0], [0, 0, 1, 0], true),
        t('A完工', [0, 1, 0, 0], [0, 0, 0, 1], true),
        t('B完工', [0, 0, 1, 0], [0, 0, 0, 1], true),
        t('回退', [0, 1, 0, 0], [1, 0, 0, 0], true),
      ],
      forbidden: [],
    },
  },
];
