import { Component, type ErrorInfo, type ReactNode } from 'react';

import { ErrorNote } from './Display';

interface ErrorBoundaryProps {
  /** 出错提示里用它指明是哪一块坏了。 */
  label: string;
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
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
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // 控制台留全量信息：组件栈比一句 message 有用得多。
    console.error(`[${this.props.label}] 渲染出错：`, error, info);
  }

  override render() {
    const { error } = this.state;
    if (error === null) {
      return this.props.children;
    }
    return (
      <ErrorNote>
        {`${this.props.label}渲染出错了：${error.message}（控制台里有完整的组件栈）`}
      </ErrorNote>
    );
  }
}
