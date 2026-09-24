/// <reference lib="webworker" />
import { runAudit } from './audit';
import { runInterlock } from './interlock';
import { validateModel } from './validate';

export interface EngineRequest {
  model: import('./types').PetriModel;
  maxStates: number;
  /** 缺省为原审计；'interlock' 执行联锁综合 */
  mode?: 'audit' | 'interlock';
}

self.onmessage = (ev: MessageEvent<EngineRequest>) => {
  const { model, maxStates, mode = 'audit' } = ev.data;
  const { errors, model: valid } = validateModel(model);
  if (!valid) {
    self.postMessage({ kind: 'error', message: `模型非法：${errors.join('；')}` });
    return;
  }
  try {
    self.postMessage(mode === 'interlock' ? runInterlock(valid, maxStates) : runAudit(valid, maxStates));
  } catch (err) {
    self.postMessage({ kind: 'error', message: `${mode === 'interlock' ? '联锁综合' : '审计'}异常：${String(err)}` });
  }
};
