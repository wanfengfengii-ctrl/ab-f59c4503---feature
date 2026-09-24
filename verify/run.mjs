/**
 * 一次性验收服务：在真实 Chromium 中驱动审计台前端，覆盖
 *  - Web 健康检查端点
 *  - 页面加载与示例模型审计（通过 / 禁态 / 非验收死锁 / 套索）
 *  - 反例逐步回放与每步令牌变化标注
 *  - JSON 导入（合法 / 非法）与模型编辑（删除变迁）
 *  - 浏览器内审计引擎钩子（最短 + 字典序、套索前缀/循环、容量语义、禁态优先）
 * 全部通过退出码 0，否则退出码 1。
 */
import { chromium } from 'playwright-core';

const BASE = (process.env.BASE_URL ?? 'http://web:80').replace(/\/$/, '');
const HEALTH_PATH = process.env.HEALTH_PATH ?? '/health';
const WAIT_TIMEOUT_MS = Number(process.env.WAIT_TIMEOUT_MS ?? 90_000);

const results = [];
const pageErrors = [];

function report(name, pass, extra = '') {
  results.push({ name, pass });
  console.log(`${pass ? '✅' : '❌'} ${name}${extra ? ` —— ${extra}` : ''}`);
}

async function waitHealthy() {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  let lastErr = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}${HEALTH_PATH}`);
      if (res.status === 200) return true;
      lastErr = `HTTP ${res.status}`;
    } catch (e) {
      lastErr = String(e?.message ?? e);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  console.error(`等待 ${BASE}${HEALTH_PATH} 健康检查超时：${lastErr}`);
  return false;
}

/** 轮询等待选择器文本包含子串 */
async function waitText(page, selector, needle, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const el = await page.$(selector);
    const txt = el ? await el.textContent() : null;
    if (txt && txt.includes(needle)) return txt;
    if (Date.now() > deadline) {
      throw new Error(`等待 ${selector} 包含「${needle}」超时，当前文本：${txt}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

const text = async (page, selector) => {
  const el = await page.$(selector);
  return el ? (await el.textContent())?.trim() ?? '' : '';
};

const chipTokens = async (page, i) =>
  text(page, `[data-testid="marking-chip-${i}"] strong`);

async function selectSample(page, key) {
  await page.selectOption('[data-testid="sample-select"]', key);
}

async function runAudit(page) {
  await page.click('[data-testid="run-audit"]');
}

async function main() {
  console.log(`验收目标：${BASE}`);

  // ---------- 0. 健康检查 ----------
  if (!(await waitHealthy())) {
    report('Web 健康检查', false, '等待超时');
    return finish();
  }
  const healthRes = await fetch(`${BASE}${HEALTH_PATH}`);
  const healthBody = (await healthRes.text()).trim();
  report('Web 健康检查端点返回 200 ok', healthRes.status === 200 && healthBody === 'ok');

  // ---------- 启动真实浏览器 ----------
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(20_000);
    page.on('pageerror', (err) => pageErrors.push(String(err)));

    // ---------- 1. 页面加载 ----------
    await page.goto(BASE, { waitUntil: 'networkidle' });
    const title = await page.title();
    report('页面标题正确', title.includes('Petri'), title);
    report('主标题可见', await page.isVisible('[data-testid="app-title"]'));
    report('运行审计按钮可见', await page.isVisible('[data-testid="run-audit"]'));

    // ---------- 2. 默认示例：应通过 ----------
    await runAudit(page);
    await waitText(page, '[data-testid="verdict"]', '已验证');
    report(
      '顺序灌装示例验证通过',
      (await text(page, '[data-testid="stat-states"]')) === '4',
      `状态数=${await text(page, '[data-testid="stat-states"]')}`,
    );

    // ---------- 3. 非验收死锁示例 ----------
    await selectSample(page, 'deadlock');
    await runAudit(page);
    await waitText(page, '[data-testid="verdict"]', '非验收死锁');
    const dlSteps = await page.$$('[data-testid^="trace-step-"]');
    report('死锁反例为最短 1 步轨迹', dlSteps.length === 1, `步数=${dlSteps.length}`);
    report(
      '死锁末态令牌落在「空转过热」',
      (await chipTokens(page, 3)) === '1',
      `P4=${await chipTokens(page, 3)}`,
    );
    report('回放位置显示 1 / 1', (await text(page, '[data-testid="replay-position"]')) === '1 / 1');

    // ---------- 4. 禁态示例 + 逐步回放 ----------
    await selectSample(page, 'forbidden');
    await runAudit(page);
    await waitText(page, '[data-testid="verdict"]', '禁态');
    report(
      '禁态反例为最短 2 步轨迹',
      (await page.$$('[data-testid^="trace-step-"]')).length === 2,
    );
    report(
      '禁态末态双阀同开（P2=1 且 P3=1）',
      (await chipTokens(page, 1)) === '1' && (await chipTokens(page, 2)) === '1',
    );
    await page.click('[data-testid="replay-prev"]');
    report(
      '回退一步后位置与令牌同步更新',
      (await text(page, '[data-testid="replay-position"]')) === '1 / 2' &&
        (await chipTokens(page, 2)) === '0',
    );
    const stepLabel = await text(page, '[data-testid="replay-transition"]');
    report('回放标注当前触发变迁', stepLabel.includes('T1'), stepLabel);
    await page.click('[data-testid="replay-next"]');
    report(
      '前进恢复禁态末态',
      (await text(page, '[data-testid="replay-position"]')) === '2 / 2' &&
        (await chipTokens(page, 2)) === '1',
    );

    // ---------- 5. 套索（无限执行）示例 ----------
    await selectSample(page, 'lasso');
    await runAudit(page);
    const lassoVerdict = await waitText(page, '[data-testid="verdict"]', '无限执行');
    report(
      '套索见证：前缀 0 步 + 循环 2 步',
      lassoVerdict.includes('前缀 0 步') && lassoVerdict.includes('循环 2 步'),
      lassoVerdict,
    );
    report('循环起点标注可见', await page.isVisible('[data-testid="cycle-start"]'));

    // ---------- 6. JSON 导入 ----------
    const customModel = {
      places: [
        { name: '原料', capacity: 2, initial: 2, acceptance: 0 },
        { name: '加工', capacity: 1, initial: 0, acceptance: 0 },
        { name: '成品', capacity: 2, initial: 0, acceptance: 2 },
      ],
      transitions: [
        { name: '投料', pre: [1, 0, 0], post: [0, 1, 0] },
        { name: '出料', pre: [0, 1, 0], post: [0, 0, 1] },
      ],
      forbidden: [],
    };
    await page.click('[data-testid="import-json"]');
    await page.fill('[data-testid="json-textarea"]', JSON.stringify(customModel));
    await page.click('[data-testid="json-confirm"]');
    await page.waitForSelector('[data-testid="json-textarea"]', { state: 'detached' });
    await runAudit(page);
    await waitText(page, '[data-testid="verdict"]', '已验证');
    report(
      '导入自定义模型并审计通过（5 状态）',
      (await text(page, '[data-testid="stat-states"]')) === '5',
      `状态数=${await text(page, '[data-testid="stat-states"]')}`,
    );

    // 非法模型被拒绝
    await page.click('[data-testid="import-json"]');
    await page.fill('[data-testid="json-textarea"]', '{"places":[]}');
    await page.click('[data-testid="json-confirm"]');
    report('非法模型导入被校验拦截', await page.isVisible('[data-testid="json-errors"]'));
    await page.click('[data-testid="json-cancel"]');

    // ---------- 7. 界面编辑：删除导致死锁的变迁后应通过 ----------
    await selectSample(page, 'deadlock');
    await page.click('[data-testid="transition-item-2"]');
    await page.click('[data-testid="delete-transition"]');
    await runAudit(page);
    await waitText(page, '[data-testid="verdict"]', '已验证');
    report('删除「空转」变迁后模型验证通过', true);

    // ---------- 8. 引擎钩子：最短 + 字典序 / 套索 / 容量 / 禁态优先 ----------
    const hook = await page.evaluate(() => {
      const tieModel = {
        places: ['s', 'a', 'b', 'c', 'd'].map((n, i) => ({
          name: n,
          capacity: 1,
          initial: i === 0 ? 1 : 0,
          acceptance: 0,
        })),
        transitions: [
          { name: 'T0', pre: [1, 0, 0, 0, 0], post: [0, 1, 0, 0, 0] },
          { name: 'T1', pre: [1, 0, 0, 0, 0], post: [0, 0, 1, 0, 0] },
          { name: 'T2', pre: [0, 1, 0, 0, 0], post: [0, 0, 0, 1, 0] },
          { name: 'T3', pre: [0, 0, 1, 0, 0], post: [0, 0, 0, 0, 1] },
        ],
        forbidden: [],
      };
      const capModel = {
        places: [
          { name: '源', capacity: 2, initial: 2, acceptance: 0 },
          { name: '汇', capacity: 1, initial: 0, acceptance: 1 },
        ],
        transitions: [{ name: '移', pre: [1, 0], post: [0, 1] }],
        forbidden: [],
      };
      const accForbidden = {
        places: [
          { name: 'a', capacity: 1, initial: 1, acceptance: 1 },
          { name: 'b', capacity: 1, initial: 0, acceptance: 0 },
        ],
        transitions: [{ name: 'go', pre: [1, 0], post: [0, 1] }],
        forbidden: [[{ place: 0, op: 'eq', value: 1 }]],
      };
      const lassoSample = window.__samples.find((s) => s.key === 'lasso').model;
      const pipeline = window.__samples.find((s) => s.key === 'pipeline').model;
      return {
        tie: window.__runAudit(tieModel),
        cap: window.__runAudit(capModel),
        accForbidden: window.__runAudit(accForbidden),
        lasso: window.__runAudit(lassoSample),
        pipeline: window.__runAudit(pipeline),
      };
    });
    report(
      '等长死锁轨迹取字典序最小 [T1,T3]',
      hook.tie.kind === 'deadlock' &&
        JSON.stringify(hook.tie.trace.map((s) => s.t)) === '[0,2]',
      JSON.stringify(hook.tie.trace?.map((s) => s.t)),
    );
    report(
      '容量上限阻塞变迁并暴露死锁',
      hook.cap.kind === 'deadlock' &&
        JSON.stringify(hook.cap.trace[0].after) === '[1,1]',
    );
    report('禁态判定优先于验收判定', hook.accForbidden.kind === 'forbidden');
    report(
      '套索：空前缀 + 循环 [T1,T2]',
      hook.lasso.kind === 'lasso' &&
        hook.lasso.prefix.length === 0 &&
        JSON.stringify(hook.lasso.cycle.map((s) => s.t)) === '[0,1]',
    );
    report(
      '双批次产线验证通过（30 状态）',
      hook.pipeline.kind === 'verified' && hook.pipeline.stats.states === 30,
      `状态数=${hook.pipeline.stats?.states}`,
    );

    // ---------- 9. 浏览器页面级异常 ----------
    report('页面运行无未捕获异常', pageErrors.length === 0, pageErrors.join(' | '));
  } catch (e) {
    report('验收执行异常', false, String(e?.message ?? e));
  } finally {
    await browser.close();
  }
  finish();
}

function finish() {
  const failed = results.filter((r) => !r.pass);
  console.log('────────────────────────────');
  console.log(`验收结果：${results.length - failed.length}/${results.length} 项通过`);
  if (failed.length > 0) {
    console.log(`失败项：${failed.map((f) => f.name).join('；')}`);
  }
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('验收服务异常退出：', e);
  process.exit(1);
});
