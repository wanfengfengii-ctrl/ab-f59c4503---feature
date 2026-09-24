# Petri 网配液产线审计台

自动配液产线把阀门、泵和批次令牌编译为**有界 Petri 网**后，本工具在浏览器中对其做完整可达性审计：证明“每条执行都终止于验收标记且从未进入禁态”，或给出可逐步回放的反例。**纯前端实现（TypeScript + React），全程不调用任何业务后端。**

## 功能

- **模型编辑 / 导入**：2–18 个库所、1–40 个变迁；每个库所可设容量（0–3）、初始令牌、验收标记；禁态条件为子句组的析取范式（组内“且”、组间“或”）；支持 JSON 导入 / 导出与 5 个内置示例。
- **变迁语义**：按前置 / 后置整数弧原子触发，仅当令牌充足且结果不超过容量时可用；到达验收标记该次执行即结束（验收态为吸收态）。
- **完整审计**：完整探索可达状态图（默认上限 20 万状态，可调）：
  - 存在**禁态**或**非验收死锁** → 返回**步数最短、变迁编号序列字典序最小**的反例轨迹；
  - 否则存在**无限执行** → 返回**前缀最短、循环最短**并按同一规则决胜的**套索见证**；
  - 否则给出**验证通过**结论（所有执行终止于验收且未进入禁态）。
- **反例回放**：逐步前进 / 后退 / 自动播放，页面标出每步令牌变化（库所筹码 ±n、SVG 网图令牌与弧高亮、步骤表令牌迁移）；套索循环段自动循环演示。
- **交付形态**：Dockerfile（多阶段构建 → nginx 静态托管）、Docker Compose（Web 健康检查、`HOST_PORT` 可配置宿主机端口）、名为 `verify` 的一次性验收服务（真实 Chromium 中执行场景，以退出码报告结果）。

## 快速开始（Docker）

```bash
# 仅启动 Web（默认宿主机端口 8080）
docker compose up web

# 指定宿主机端口
HOST_PORT=9090 docker compose up web

# 运行一次性验收：verify 等 web 健康后在真实浏览器中执行场景，
# 全部通过退出码 0，否则非 0；--abort-on-container-exit 让其结束后整体退出
docker compose up --exit-code-from verify --abort-on-container-exit
```

健康检查：`GET /health` 返回 `200 ok`（Dockerfile `HEALTHCHECK` 与 Compose `healthcheck` 均使用该端点）。

## 本地开发

```bash
npm install
npm run dev        # 开发服务器
npm test           # 审计引擎单元测试（vitest，21 例）
npm run build      # 类型检查 + 生产构建（dist/）
npm run preview    # 预览生产构建
```

## 模型 JSON 格式

```jsonc
{
  "places": [                       // 2..18 个库所
    { "name": "就绪",   "capacity": 1, "initial": 1, "acceptance": 0 },
    { "name": "泵运行", "capacity": 1, "initial": 0, "acceptance": 0 },
    { "name": "完成",   "capacity": 1, "initial": 0, "acceptance": 1 }
  ],
  "transitions": [                  // 1..40 个变迁
    { "name": "启动泵", "pre": [1, 0, 0], "post": [0, 1, 0] },
    { "name": "停机",   "pre": [0, 1, 0], "post": [0, 0, 1] }
  ],
  "forbidden": [                    // 禁态条件：DNF，组内“且”、组间“或”，可为空数组
    [
      { "place": 0, "op": "ge", "value": 1 },
      { "place": 1, "op": "ge", "value": 1 }
    ]
  ]
}
```

- `capacity`：0–3；`initial` / `acceptance`：0–capacity。
- `pre` / `post`：非负整数弧权（0–9），长度与库所数一致（缺省补 0）。
- `op`：`eq ne lt le gt ge` 之一；`value`：0–3。

## 审计语义约定

1. **触发**：变迁 `t` 在标记 `m` 下可用 ⟺ 对每个库所 `m[p] ≥ pre[t][p]` 且 `m[p] − pre[t][p] + post[t][p] ≤ capacity[p]`；触发是原子的。
2. **验收**：标记逐位等于验收向量即为验收态；验收态是吸收态（到达即结束，不再触发变迁），该次执行记为成功。
3. **禁态优先**：若一个标记同时满足验收与禁态条件，按违规处理（执行确实进入了禁态）。
4. **反例最优性**：禁态 / 非验收死锁反例按（步数，变迁编号序列字典序）最小返回；套索见证按（前缀长度，循环长度，序列字典序）最小返回。引擎按 (深度, 序列) 均匀代价搜索保证该最优性。
5. **无限执行**：状态空间有限，无限执行 ⟺ 可达环；套索 = 初始态到环入口的最短前缀 + 环上的最短循环。
6. **状态上限**：默认探索上限 20 万状态（界面可调）；超出时明确报告“审计中止”，不给出伪结论。

## 架构

```
浏览器（React SPA）
├── 模型编辑器（库所 / 变迁 / 禁态条件 / JSON 导入导出）
├── 审计引擎（src/petri/audit.ts，纯函数，Web Worker 中执行）
│     阶段一：按 (深度, 序列字典序) 的均匀代价搜索，完整探索可达状态，
│             命中禁态 / 非验收死锁即返回最优反例
│     阶段二：Kosaraju 求环上状态 + 逐候选最短环，产出最优套索
└── 结果面板（判定、统计、SVG 网图、逐步回放、每步令牌变化）
```

- 无业务后端：nginx 仅托管静态文件；审计计算全部发生在浏览器（Web Worker）。
- 状态编码：容量 ≤ 3，每库所 2 bit，18 库所共 36 bit，安全编码为 JS number，配合净增量 `key' = key + Δt` 快速转移。
- 验收钩子：`window.__runAudit(model)` / `window.__samples` 供 `verify` 服务在真实浏览器中直接驱动引擎。

## 目录结构

```
├── Dockerfile              # 多阶段：node 构建 → nginx 托管（含 HEALTHCHECK）
├── docker-compose.yml      # web（健康检查、HOST_PORT）+ verify（一次性验收）
├── nginx.conf              # /health 健康检查端点 + SPA 静态托管
├── index.html
├── src/
│   ├── petri/              # 类型、校验、审计引擎、示例、单元测试、Worker
│   ├── components/         # 编辑器、网图、结果回放、JSON 弹窗
│   └── hooks/useAudit.ts   # Worker 调度（失败回退主线程）
└── verify/                 # 一次性验收服务（Playwright + Chromium）
    ├── Dockerfile
    └── run.mjs             # 24 项端到端场景，退出码即验收结果
```

## verify 验收服务覆盖场景

健康检查端点、页面加载、四类判定（通过 / 禁态 / 非验收死锁 / 套索）、反例最短性与字典序、逐步回放与令牌变化标注、JSON 导入（合法 / 非法）、界面编辑（删除变迁）、容量阻塞语义、禁态优先、套索前缀/循环最优性、页面无未捕获异常。
