/// <reference lib="webworker" />
import { runAudit } from './audit';
import { synthesizeInterlock } from './interlock';
import { validateModel } from './validate';
import type { PetriModel } from './types';

export type EngineMode = 'audit' | 'interlock';

export interface EngineRequest {
  model: PetriModel;
  maxStates: number;
  mode: EngineMode;
}

self.onmessage = (ev: MessageEvent<EngineRequest>) => {
  const { model, maxStates, mode } = ev.data;
  const { errors, model: valid } = validateModel(model);
  if (!valid) {
    self.postMessage({ kind: 'error', message: `模型非法：${errors.join('；')}` });
    return;
  }
  try {
    self.postMessage(mode === 'interlock' ? synthesizeInterlock(valid, maxStates) : runAudit(valid, maxStates));
  } catch (err) {
    self.postMessage({ kind: 'error', message: `引擎异常：${String(err)}` });
  }
};
