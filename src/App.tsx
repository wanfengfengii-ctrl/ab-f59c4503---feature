import { useMemo, useRef, useState } from 'react';
import { ForbiddenEditor } from './components/ForbiddenEditor';
import { JsonModal } from './components/JsonModal';
import { PlacesEditor } from './components/PlacesEditor';
import { ResultPanel } from './components/ResultPanel';
import { TransitionsEditor } from './components/TransitionsEditor';
import { useAudit } from './hooks/useAudit';
import { SAMPLES } from './petri/samples';
import { PetriModel, PlaceSpec, TransitionSpec } from './petri/types';
import { validateModel } from './petri/validate';

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
  const [modal, setModal] = useState<{ open: boolean; mode: 'import' | 'export' }>({
    open: false,
    mode: 'import',
  });
  const [jsonText, setJsonText] = useState('');
  const [jsonErrors, setJsonErrors] = useState<string[]>([]);
  const { running, result, audit } = useAudit();
  const auditedModel = useRef<PetriModel | null>(null);

  const stale = useMemo(
    () => result !== null && auditedModel.current !== null && auditedModel.current !== model,
    [result, model],
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
    audit(model, maxStates);
  };

  const sample = SAMPLES.find((s) => s.key === sampleKey);

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
          <button className="primary" data-testid="run-audit" disabled={running} onClick={run}>
            {running ? '审计中…' : '▶ 运行审计'}
          </button>
        </div>
      </header>
      {sample && <div className="sample-desc">{sample.description}</div>}
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
          <ResultPanel result={result} running={running} model={model} stale={stale} />
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
