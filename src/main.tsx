import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { runAudit } from './petri/audit';
import { runInterlock } from './petri/interlock';
import { SAMPLES } from './petri/samples';
import { validateModel } from './petri/validate';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// 验收钩子：供 compose 中 verify 服务在真实浏览器里直接驱动引擎（纯前端，无后端调用）
declare global {
  interface Window {
    __runAudit?: (model: unknown, maxStates?: number) => unknown;
    __runInterlock?: (model: unknown, maxStates?: number) => unknown;
    __samples?: typeof SAMPLES;
  }
}
window.__runAudit = (model: unknown, maxStates?: number) => {
  const { errors, model: valid } = validateModel(model);
  if (!valid) return { kind: 'error', message: errors.join('；') };
  return runAudit(valid, maxStates);
};
window.__runInterlock = (model: unknown, maxStates?: number) => {
  const { errors, model: valid } = validateModel(model);
  if (!valid) return { kind: 'error', message: errors.join('；'), states: [], failure: null };
  return runInterlock(valid, maxStates);
};
window.__samples = SAMPLES;
