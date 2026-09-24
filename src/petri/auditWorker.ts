/// <reference lib="webworker" />
import { runAudit } from './audit';
import { validateModel } from './validate';
import type { PetriModel } from './types';

export interface AuditRequest {
  model: PetriModel;
  maxStates: number;
}

self.onmessage = (ev: MessageEvent<AuditRequest>) => {
  const { model, maxStates } = ev.data;
  const { errors, model: valid } = validateModel(model);
  if (!valid) {
    self.postMessage({ kind: 'error', message: `模型非法：${errors.join('；')}` });
    return;
  }
  try {
    self.postMessage(runAudit(valid, maxStates));
  } catch (err) {
    self.postMessage({ kind: 'error', message: `审计异常：${String(err)}` });
  }
};
