import { useCallback, useEffect, useRef, useState } from 'react';

export interface AsyncResource<T> {
  data: T | null;
  /**
   * 保留原始错误对象，而不是提前拍平成字符串。
   *
   * 后端把同一条错误拆成了「码 + 参数 + 中文原文」，界面要按当前语言重述它；
   * 一旦在这里转成字符串，语言就固定在出错那一刻了。
   */
  error: Error | null;
  loading: boolean;
  reload: () => void;
}

/** 把任意抛出物收拢成 Error，便于界面统一渲染。 */
export function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

/**
 * 加载一份远程数据，并提供手动重载。
 *
 * 只在依赖变化或显式 reload 时请求；组件卸载后到达的响应会被丢弃，
 * 因此切换功能域时不会有「旧请求覆盖新数据」的问题。
 */
export function useAsync<T>(loader: () => Promise<T>, deps: readonly unknown[] = []): AsyncResource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    let alive = true;
    setLoading(true);
    loaderRef
      .current()
      .then((value) => {
        if (!alive) return;
        setData(value);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!alive) return;
        setError(toError(cause));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // deps 由调用方决定；nonce 用于手动重载。
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);
  return { data, error, loading, reload };
}

export interface ActionState {
  pending: boolean;
  error: Error | null;
  /** 执行动作；返回是否成功，便于调用方决定后续步骤。 */
  run: (task: () => Promise<unknown>) => Promise<boolean>;
  clearError: () => void;
}

/** 提交类动作的通用状态：进行中、错误、以及是否成功。 */
export function useAction(): ActionState {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const run = useCallback(async (task: () => Promise<unknown>) => {
    setPending(true);
    setError(null);
    try {
      await task();
      return true;
    } catch (cause: unknown) {
      setError(toError(cause));
      return false;
    } finally {
      setPending(false);
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);
  return { pending, error, run, clearError };
}

/** 值稳定一小段时间后才返回，避免每次按键都触发请求或过滤。 */
export function useDebounced<T>(value: T, delay = 200): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);

  return settled;
}
