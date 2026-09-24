import { useMemo, useRef, useState } from 'react';
import { ForbiddenEditor } from './components/ForbiddenEditor';
import { InterlockPanel } from './components/InterlockPanel';
import { JsonModal } from './components/JsonModal';
import { PlacesEditor } from './components/PlacesEditor';
import { ResultPanel } from './components/ResultPanel';
import { TransitionsEditor } from './components/TransitionsEditor';
import { useAudit } from './hooks/useAudit';
import { SAMPLES } from './petri/samples';
import type { EngineMode } from './petri/auditWorker';
import { PetriModel, PlaceSpec, TransitionSpec } from './petri/types';
import { hasControllability, validateModel } from './petri/validate';

const blankModel = (): PetriModel => ({
  places: [
    { name: 'P1', capacity: 1, initial: 1, acceptance: 0 },
    { name: 'P2', capacity: 1, initial: 0, acceptance: 1 },
  ],
  transitions: [{ name: 'T1', pre: [1, 0], post: [0, 1] }],
  forbidden: [],
});

export default function App() {
  const [model, setModel] = useState<PetriModel>(() => structuredClone(SAMPLES[0].model));
  const [sampleKey, setSampleKey] = useState(SAMPLES[0].key);
  const [maxStates, setMaxStates] = useState(200_000);
  const [mode, setMode] = useState<EngineMode>('audit');
  const [modal, setModal] = useState<{ open: boolean; mode: 'import' | 'export' }>({
    open: false,
    mode: 'import',
  });
  const [jsonText, setJsonText] = useState('');
  const [jsonErrors, setJsonErrors] = useState<string[]>([]);
  const { running, result, interlockResult, audit } = useAudit();
  const auditedModel = useRef<PetriModel | null>(null);

  const controllableReady = useMemo(() => hasControllability(model), [model]);
  const stale = useMemo(
    () => auditedModel.current !== null && auditedModel.current !== model,
    [model],
  );

  // ---- 结构性修改：库所增删时同步弧向量长度与禁态下标 ----
  const setPlaces = (places: PlaceSpec[]) => {
    setModel((m) => {
      const oldLen = m.places.length;
      const removedIdx: number[] = [];
      for (let i = oldLen - 1; i >= places.length; i--) removedIdx.unshift(i);
      const remap = (idx: number): number => {
        let shift = 0;
        for (const r of removedIdx) if (r < idx) shift++;
        return idx - shift;
      };
      const removedSet = new Set(removedIdx);
      const transitions: TransitionSpec[] = m.transitions.map((t) => ({
        ...t,
        pre: places.map((_, i) => t.pre[i] ?? 0),
        post: places.map((_, i) => t.post[i] ?? 0),
      }));
      const forbidden = m.forbidden
        .map((group) =>
          group
            .filter((c) => !removedSet.has(c.place))
            .map((c) => ({ ...c, place: remap(c.place) })),
        )
        .filter((group) => group.length > 0);
      return { places, transitions, forbidden };
    });
  };

  const setTransitions = (transitions: TransitionSpec[]) =>
    setModel((m) => ({ ...m, transitions }));
  const setForbidden = (forbidden: PetriModel['forbidden']) =>
    setModel((m) => ({ ...m, forbidden }));

  const loadSample = (key: string) => {
    const s = SAMPLES.find((x) => x.key === key);
    if (!s) return;
    setSampleKey(key);
    setModel(structuredClone(s.model));
  };

  const openImport = () => {
    setJsonText(JSON.stringify(model, null, 2));
    setJsonErrors([]);
    setModal({ open: true, mode: 'import' });
  };
  const openExport = () => {
    setJsonText(JSON.stringify(model, null, 2));
    setJsonErrors([]);
    setModal({ open: true, mode: 'export' });
  };

  const doImport = (text: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      setJsonErrors([`JSON 解析失败：${(e as Error).message}`]);
      return;
    }
    const { errors, model: valid } = validateModel(parsed);
    if (!valid) {
      setJsonErrors(errors);
      return;
    }
    setModel(valid);
    setSampleKey('');
    setModal((m) => ({ ...m, open: false }));
  };

  const run = () => {
    auditedModel.current = model;
    audit(model, maxStates, mode);
  };

  const sample = SAMPLES.find((s) => s.key === sampleKey);
  const runLabel =
    running ? '计算中…' : mode === 'interlock' ? '▶ 综合联锁策略' : '▶ 运行审计';

  return (
    <div className="app">
      <header className="app-header">
        <h1 data-testid="app-title">Petri 网配液产线审计台</h1>
        <div className="header-actions">
          <select
            data-testid="sample-select"
            value={sampleKey}
            onChange={(e) => loadSample(e.target.value)}
          >
            <option value="" disabled>
              载入示例…
            </option>
            {SAMPLES.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
          <button className="secondary" data-testid="reset-model" onClick={() => { setModel(blankModel()); setSampleKey(''); }}>
            新建空白模型
          </button>
          <button className="secondary" data-testid="import-json" onClick={openImport}>
            导入 JSON
          </button>
          <button className="secondary" data-testid="export-json" onClick={openExport}>
            导出 JSON
          </button>
          <div className="mode-switch" role="tablist" aria-label="引擎模式">
            <button
              className={mode === 'audit' ? 'primary' : 'secondary'}
              data-testid="mode-audit"
              onClick={() => setMode('audit')}
            >
              完整审计
            </button>
            <button
              className={mode === 'interlock' ? 'primary' : 'secondary'}
              data-testid="mode-interlock"
              onClick={() => setMode('interlock')}
              title={controllableReady ? '' : '所有变迁填写可控 / 不可控后可用'}
            >
              联锁综合
            </button>
          </div>
          <label className="max-states">
            状态上限
            <input
              data-testid="max-states-input"
              type="number"
              min={1000}
              step={1000}
              value={maxStates}
              onChange={(e) => {
                const n = Number.parseInt(e.target.value, 10);
                if (!Number.isNaN(n) && n > 0) setMaxStates(n);
              }}
            />
          </label>
          <button
            className="primary"
            data-testid="run-audit"
            disabled={running || (mode === 'interlock' && !controllableReady)}
            onClick={run}
          >
            {runLabel}
          </button>
        </div>
      </header>
      {sample && <div className="sample-desc">{sample.description}</div>}
      {mode === 'interlock' && !controllableReady && (
        <div className="mode-hint" data-testid="interlock-disabled-hint">
          存在未填写联锁属性的变迁：请在变迁编辑器中将每个变迁标为「可控（联锁可拦截）」或
          「不可控（现场必然发生）」；未全部填写时维持原审计结果，不进行联锁综合。
        </div>
      )}
      <main className="layout">
        <section className="editor-col">
          <PlacesEditor places={model.places} onChange={setPlaces} />
          <TransitionsEditor
            places={model.places}
            transitions={model.transitions}
            onChange={setTransitions}
          />
          <ForbiddenEditor
            places={model.places}
            groups={model.forbidden}
            onChange={setForbidden}
          />
        </section>
        <section className="result-col">
          {mode === 'audit' ? (
            <ResultPanel result={result} running={running} model={model} stale={stale} />
          ) : (
            interlockResult && (
              <InterlockPanel result={interlockResult} running={running} model={model} stale={stale} />
            )
          )}
          {mode === 'interlock' && !interlockResult && (
            <div className="card result-panel" data-testid="result-empty">
              <h2>联锁综合结果</h2>
              <p className="hint">
                {running
                  ? '综合中……'
                  : controllableReady
                    ? '全部变迁已填写联锁属性，点击「综合联锁策略」。'
                    : '全部变迁填写可控 / 不可控属性后，点击「综合联锁策略」。'}
              </p>
            </div>
          )}
        </section>
      </main>
      <JsonModal
        open={modal.open}
        mode={modal.mode}
        initialText={jsonText}
        errors={jsonErrors}
        onClose={() => setModal((m) => ({ ...m, open: false }))}
        onImport={doImport}
      />
    </div>
  );
}
