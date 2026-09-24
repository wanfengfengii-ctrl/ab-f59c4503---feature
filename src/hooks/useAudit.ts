import { useCallback, useEffect, useRef, useState } from 'react';
import type { AuditResult } from '../petri/audit';
import { runAudit } from '../petri/audit';
import { validateModel } from '../petri/validate';
import type { PetriModel } from '../petri/types';

/** 优先在 Web Worker 中执行审计以保持界面响应；Worker 不可用时回退到主线程。 */
export function useAudit() {
  const workerRef = useRef<Worker | null>(null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<AuditResult | null>(null);

  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  const audit = useCallback((model: PetriModel, maxStates: number) => {
    setRunning(true);
    setResult(null);

    const done = (r: AuditResult) => {
      setResult(r);
      setRunning(false);
    };

    try {
      workerRef.current?.terminate();
      const w = new Worker(new URL('../petri/auditWorker.ts', import.meta.url), {
        type: 'module',
      });
      workerRef.current = w;
      w.onmessage = (ev: MessageEvent<AuditResult>) => {
        done(ev.data);
        w.terminate();
        if (workerRef.current === w) workerRef.current = null;
      };
      w.onerror = () => {
        // Worker 加载失败时回退主线程同步执行
        w.terminate();
        if (workerRef.current === w) workerRef.current = null;
        const { errors, model: valid } = validateModel(model);
        done(
          valid
            ? runAudit(valid, maxStates)
            : { kind: 'error', message: `模型非法：${errors.join('；')}` },
        );
      };
      w.postMessage({ model, maxStates });
    } catch {
      const { errors, model: valid } = validateModel(model);
      done(
        valid
          ? runAudit(valid, maxStates)
          : { kind: 'error', message: `模型非法：${errors.join('；')}` },
      );
    }
  }, []);

  return { running, result, audit };
}
