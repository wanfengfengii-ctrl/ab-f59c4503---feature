import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { runAudit } from './petri/audit';
import { getDecision, markingKey, synthesizeInterlock } from './petri/interlock';
import { SAMPLES } from './petri/samples';
import { validateModel } from './petri/validate';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// 验收钩子：供 compose 中 verify 服务在真实浏览器里直接驱动审计引擎（纯前端，无后端调用）
declare global {
  interface Window {
    __runAudit?: (model: unknown, maxStates?: number) => unknown;
    __samples?: typeof SAMPLES;
    __synthesizeInterlock?: (model: unknown, maxStates?: number) => unknown;
    __interlockDecision?: (model: unknown, result: unknown, marking: number[], t: number) => unknown;
    __markingKey?: (model: unknown, marking: number[]) => number;
  }
}
window.__runAudit = (model: unknown, maxStates?: number) => {
  const { errors, model: valid } = validateModel(model);
  if (!valid) return { kind: 'error', message: errors.join('；') };
  return runAudit(valid, maxStates);
};
window.__samples = SAMPLES;
window.__synthesizeInterlock = (model: unknown, maxStates?: number) => {
  const { errors, model: valid } = validateModel(model);
  if (!valid) return { kind: 'error', message: errors.join('；') };
  return synthesizeInterlock(valid, maxStates);
};
window.__interlockDecision = (model: unknown, result: unknown, marking: number[], t: number) => {
  const { errors, model: valid } = validateModel(model);
  if (!valid) return { error: errors.join('；') };
  const r = result as ReturnType<typeof synthesizeInterlock>;
  if (r.kind === 'error') return { error: r.message };
  return getDecision(valid, r.policy, markingKey(marking), t);
};
window.__markingKey = (model: unknown, marking: number[]) => {
  const { model: valid } = validateModel(model);
  return valid ? markingKey(marking) : 0;
};
