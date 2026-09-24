import { useCallback, useEffect, useRef, useState } from 'react';
import type { AuditResult } from '../petri/audit';
import { runAudit } from '../petri/audit';
import type { InterlockResult } from '../petri/interlock';
import { synthesizeInterlock } from '../petri/interlock';
import type { EngineMode } from '../petri/auditWorker';
import { validateModel } from '../petri/validate';
import type { PetriModel } from '../petri/types';

export type EngineResult = AuditResult | InterlockResult;

/**
 * 优先在 Web Worker 中执行引擎以保持界面响应；Worker 不可用时回退到主线程。
 * mode：'audit' 完整审计（旧语义，永不变更）；'interlock' 联锁综合（需所有变迁填写可控属性）。
 */
export function useAudit() {
  const workerRef = useRef<Worker | null>(null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<AuditResult | null>(null);
  const [interlockResult, setInterlockResult] = useState<InterlockResult | null>(null);

  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  const run = useCallback((model: PetriModel, maxStates: number, mode: EngineMode) => {
    setRunning(true);
    if (mode === 'interlock') setInterlockResult(null);
    else setResult(null);

    const done = (r: EngineResult) => {
      if (mode === 'interlock') setInterlockResult(r as InterlockResult);
      else setResult(r as AuditResult);
      setRunning(false);
    };

    try {
      workerRef.current?.terminate();
      const w = new Worker(new URL('../petri/auditWorker.ts', import.meta.url), {
        type: 'module',
      });
      workerRef.current = w;
      w.onmessage = (ev: MessageEvent<EngineResult>) => {
        done(ev.data);
        w.terminate();
        if (workerRef.current === w) workerRef.current = null;
      };
      w.onerror = () => {
        // Worker 加载失败时回退主线程同步执行
        w.terminate();
        if (workerRef.current === w) workerRef.current = null;
        const { errors, model: valid } = validateModel(model);
        if (!valid) {
          done({ kind: 'error', message: `模型非法：${errors.join('；')}` } as EngineResult);
          return;
        }
        done(
          mode === 'interlock'
            ? synthesizeInterlock(valid, maxStates)
            : runAudit(valid, maxStates),
        );
      };
      w.postMessage({ model, maxStates, mode } satisfies { model: PetriModel; maxStates: number; mode: EngineMode });
    } catch {
      const { errors, model: valid } = validateModel(model);
      if (!valid) {
        done({ kind: 'error', message: `模型非法：${errors.join('；')}` } as EngineResult);
        return;
      }
      done(mode === 'interlock' ? synthesizeInterlock(valid, maxStates) : runAudit(valid, maxStates));
    }
  }, []);

  return { running, result, interlockResult, audit: run };
}
