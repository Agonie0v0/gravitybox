import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/global.css';
import { AppProvider } from './context/AppContext';
import { MainWindow } from './windows/MainWindow';
import { TrayWindow } from './windows/TrayWindow';

function resolveWindowRole(): 'main' | 'tray' {
  const hash = (window.location.hash || '').toLowerCase();
  if (hash.startsWith('#tray')) return 'tray';
  const params = new URLSearchParams(window.location.search);
  if (params.get('window') === 'tray') return 'tray';
  return 'main';
}

const role = resolveWindowRole();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppProvider windowRole={role}>
      {role === 'tray' ? <TrayWindow /> : <MainWindow />}
    </AppProvider>
  </StrictMode>,
);
