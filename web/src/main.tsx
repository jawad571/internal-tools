import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/fraunces/opsz.css';
import './styles.css';
import { App } from './App';

async function boot() {
  // The in-browser API mock exists only in VITE_MOCK=1 builds; this branch is removed from normal builds.
  if (import.meta.env.VITE_MOCK === '1') {
    const { installMock } = await import('./mock/server');
    installMock();
  }

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );

  if (import.meta.env.PROD && import.meta.env.VITE_MOCK !== '1' && 'serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch((e: unknown) => console.warn('Service worker not registered', e));
    });
  }
}

void boot();
