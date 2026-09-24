import { useCallback, useEffect, useRef, useState } from 'react';
import type { InterlockResult } from '../petri/interlock';
import { runInterlock } from '../petri/interlock';
import { validateModel } from '../petri/validate';
import type { PetriModel } from '../petri/types';

/** 联锁综合：优先在 Web Worker 中执行；Worker 不可用时回退主线程（与审计同构）。 */
export function useInterlock() {
  const workerRef = useRef<Worker | null>(null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<InterlockResult | null>(null);

  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  const synthesize = useCallback((model: PetriModel, maxStates: number) => {
    setRunning(true);
    setResult(null);

    const done = (r: InterlockResult) => {
      setResult(r);
      setRunning(false);
    };

    try {
      workerRef.current?.terminate();
      const w = new Worker(new URL('../petri/auditWorker.ts', import.meta.url), {
        type: 'module',
      });
      workerRef.current = w;
      w.onmessage = (ev: MessageEvent<InterlockResult>) => {
        done(ev.data);
        w.terminate();
        if (workerRef.current === w) workerRef.current = null;
      };
      w.onerror = () => {
        w.terminate();
        if (workerRef.current === w) workerRef.current = null;
        const { errors, model: valid } = validateModel(model);
        done(
          valid
            ? runInterlock(valid, maxStates)
            : { kind: 'error', message: `模型非法：${errors.join('；')}`, states: [], failure: null },
        );
      };
      w.postMessage({ model, maxStates, mode: 'interlock' });
    } catch {
      const { errors, model: valid } = validateModel(model);
      done(
        valid
          ? runInterlock(valid, maxStates)
          : { kind: 'error', message: `模型非法：${errors.join('；')}`, states: [], failure: null },
      );
    }
  }, []);

  return { running, result, synthesize };
}
