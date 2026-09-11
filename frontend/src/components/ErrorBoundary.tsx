import { Component, type ErrorInfo, type ReactNode } from 'react';

import { useI18n, type I18n } from '../i18n/LocaleProvider';
import { ErrorNote } from './Display';

interface ErrorBoundaryProps {
  /** 出错提示里用它指明是哪一块坏了。传文案 key，由当前语言渲染。 */
  scopeKey: string;
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/** 类组件拿不到 hook，所以翻译函数随 props 注入（见下面的包装）。 */
interface BoundaryProps extends ErrorBoundaryProps {
  i18n: I18n;
}

/**
 * 渲染错误的兜底。
 *
 * React 在渲染期碰到异常会把**整棵树**卸掉：不管出错的是多小的一块，用户看到
 * 的都是连 logo 都没了的空白页，而且不知道发生了什么。这个组件唯一的职责就是
 * 把「整页空白」换成「这里出错了 + 错误原文」，让故障可读、可复现。
 *
 * 它刻意不自动重试：渲染错误通常来自数据本身，重试只会把同一份数据再喂一遍。
 */
class Boundary extends Component<BoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // 控制台留全量信息：组件栈比一句 message 有用得多。
    console.error(this.props.i18n.t('app.boundary.console', { scope: this.scope() }), error, info);
  }

  /** 出错的区块名，按当前语言渲染。 */
  private scope(): string {
    return this.props.i18n.t(this.props.scopeKey);
  }

  override render() {
    const { error } = this.state;
    if (error === null) {
      return this.props.children;
    }
    return (
      <ErrorNote>
        {this.props.i18n.t('app.boundary.title', {
          scope: this.scope(),
          message: error.message,
        })}
      </ErrorNote>
    );
  }
}

/** 渲染错误的兜底；语言取自最近的 LocaleProvider。 */
export function ErrorBoundary({ scopeKey, children }: ErrorBoundaryProps) {
  const i18n = useI18n();
  return (
    <Boundary scopeKey={scopeKey} i18n={i18n}>
      {children}
    </Boundary>
  );
}
