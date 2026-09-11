import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import './styles/tokens.css';
import './styles/base.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('页面缺少 #root 容器');
}

createRoot(container).render(
  <StrictMode>
    {/* 最外层的兜底：App 自身渲染出错时也要留下可读的提示，而不是一片空白。 */}
    <ErrorBoundary label="界面">
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
