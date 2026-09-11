import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { LocaleProvider } from './i18n/LocaleProvider';
import './styles/tokens.css';
import './styles/base.css';

const container = document.getElementById('root');
if (!container) {
  // 这里还没进 React，i18n 也就无从谈起，所以这句只能是英文的。
  throw new Error('The page is missing its #root container');
}

createRoot(container).render(
  <StrictMode>
    {/* LocaleProvider 放在最外层：连 ErrorBoundary 的提示也要用它挑语言。 */}
    <LocaleProvider>
      {/* 最外层的兜底：App 自身渲染出错时也要留下可读的提示，而不是一片空白。 */}
      <ErrorBoundary scopeKey="app.boundary.scope.app">
        <App />
      </ErrorBoundary>
    </LocaleProvider>
  </StrictMode>,
);
