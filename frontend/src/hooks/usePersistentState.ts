import { useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

/** 存档键统一加前缀，避免和同一来源下的其他页面撞名。 */
const PREFIX = 'ffmpeg-remote-ui:';

/** 把存档解析成可以使用的值；返回 undefined 表示这份存档用不了。 */
type Revive<T> = (raw: unknown) => T | undefined;

function load<T>(key: string, initial: T, revive?: Revive<T>): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) {
      return initial;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!revive) {
      return parsed as T;
    }
    const value = revive(parsed);
    return value === undefined ? initial : value;
  } catch {
    // 隐私模式下 localStorage 会直接抛错，存档也可能被外部改坏。
    // 两种情况都只意味着「没有存档」，不该让界面打不开。
    return initial;
  }
}

function save(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 存不下就算了：持久化是锦上添花，不能影响正在填的配置。
  }
}

/**
 * 与浏览器本地存档联动的 useState。
 *
 * 切换功能域时组件会重新挂载，状态随即丢失。把状态放到 localStorage 里既
 * 解决了来回切换，也让刷新页面不再清空已经填好的路径与参数。
 *
 * revive 负责把存档收拢成当前版本的结构：界面改过、存档坏了都退回初始值，
 * 而不是把半个对象塞进界面。
 */
export function usePersistentState<T>(
  key: string,
  initial: T,
  revive?: Revive<T>,
): [T, Dispatch<SetStateAction<T>>] {
  const storageKey = PREFIX + key;
  const [value, setValue] = useState<T>(() => load(storageKey, initial, revive));

  useEffect(() => {
    save(storageKey, value);
  }, [storageKey, value]);

  return [value, setValue];
}
