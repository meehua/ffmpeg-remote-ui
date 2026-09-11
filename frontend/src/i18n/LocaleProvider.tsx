import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';

import { usePersistentState } from '../hooks/usePersistentState';
import { detectLocale, lookup } from './index';
import type { Locale, Params } from './types';

export interface I18n {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  /**
   * 取一条文案。
   *
   * key 用 string 而不是 MessageKey：错误码和任务阶段码是运行时拼出来的
   * （`error.${code}`），编译期没法穷举。字面量 key 仍然有补全。
   */
  t: (key: string, params?: Params) => string;
  /** 表里有没有这条 key；动态 key 用它决定要不要退回原文。 */
  has: (key: string) => boolean;
  /** 按当前语言格式化时间。 */
  formatDate: (value: string | number | Date) => string;
}

const I18nContext = createContext<I18n | null>(null);

/**
 * 语言上下文。
 *
 * 语言存进浏览器本地存档：用户选过一次就一直用它，而首次访问按浏览器的
 * 语言偏好猜（见 detectLocale）。
 */
export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = usePersistentState<Locale>('locale', detectLocale());

  // <html lang> 跟着走：读屏器、断词规则和字体回退都看它。
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const value = useMemo<I18n>(
    () => ({
      locale,
      setLocale,
      t: (key, params) => lookup(locale, key, params) ?? key,
      has: (key) => lookup(locale, key) !== null,
      formatDate: (input) => new Date(input).toLocaleString(locale),
    }),
    [locale, setLocale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  const value = useContext(I18nContext);
  if (value === null) {
    // 与其返回一份英文兜底让调用方悄悄降级，不如直接说清楚哪里用错了。
    throw new Error('useI18n must be used inside a LocaleProvider');
  }
  return value;
}
