import { useState, type ReactNode } from 'react';

import { ApiError } from '../api/client';
import { useI18n } from '../i18n/LocaleProvider';
import type { Params } from '../i18n/types';
import { cx } from '../utils/format';
import { Button } from './Controls';
import styles from './Display.module.css';

type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'danger';

interface BadgeProps {
  children: ReactNode;
  tone?: Tone;
  mono?: boolean;
}

export function Badge({ children, tone = 'neutral', mono }: BadgeProps) {
  return <span className={cx(styles.badge, styles[tone], mono && styles.mono)}>{children}</span>;
}

interface ProgressBarProps {
  /** 0-100。 */
  value: number;
  indeterminate?: boolean;
}

export function ProgressBar({ value, indeterminate }: ProgressBarProps) {
  const clamped = Math.min(100, Math.max(0, value));
  return (
    <div
      className={cx(styles.progress, indeterminate && styles.progressIndeterminate)}
      role={indeterminate ? undefined : 'progressbar'}
      aria-valuemin={indeterminate ? undefined : 0}
      aria-valuemax={indeterminate ? undefined : 100}
      aria-valuenow={indeterminate ? undefined : Math.round(clamped)}
    >
      <div className={styles.progressFill} style={{ inlineSize: `${clamped}%` }} />
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  const { t } = useI18n();
  return (
    <span className={styles.spinnerWrap} role="status">
      <span className={styles.spinner} aria-hidden="true" />
      <span className={styles.spinnerLabel}>{label ?? t('common.loading')}</span>
    </span>
  );
}

interface EmptyStateProps {
  title: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
}

export function EmptyState({ title, hint, action }: EmptyStateProps) {
  return (
    <div className={styles.empty}>
      <p className={styles.emptyTitle}>{title}</p>
      {hint ? <p className={styles.emptyHint}>{hint}</p> : null}
      {action}
    </div>
  );
}

interface ErrorNoteProps {
  /** 一个 Error（多半来自 useAsync/useAction）；带码时按当前语言渲染。 */
  error?: Error | null;
  /** 裸的码与参数：事件流推来的任务失败、以及「200 但带错误」的响应走这条路。 */
  code?: string | null;
  params?: Params;
  /** 没有可用文案时显示的原文。 */
  fallback?: string | null;
  /**
   * 直接给一句话，或者把一个 Error 塞进来。
   *
   * 带上 Error 是有意的：`{x.error}` 这种写法到处都是，而 React 渲染不了
   * Error 对象——与其让每个调用点都记得换成 `error={x.error}`，不如在这里
   * 一次接住，顺带拿到它的码。
   */
  children?: ReactNode | Error;
}

/**
 * 错误提示；用 alert 角色让读屏器立刻播报。
 *
 * 「说哪句话」在这里决定，而不是散在各个调用点：后端给的是码，语言是用户
 * 选的，把这两件事凑在一起的地方越少，漏翻一处就越容易看出来。
 *
 * 三种写法都收：`error={err}`、把 Error 直接写在 children 里（`{x.error}` 这种
 * 老写法很顺手，而 React 自己渲染不了 Error 对象，所以必须在这里接住），
 * 以及给不了码时直接给一句原文。
 */
export function ErrorNote({ error, code, params, fallback, children }: ErrorNoteProps) {
  const { t, has } = useI18n();

  const source = error ?? (children instanceof Error ? children : null);
  const resolvedCode = source instanceof ApiError ? source.code : (code ?? null);
  const resolvedParams = source instanceof ApiError ? source.params : params;
  const raw =
    fallback ??
    source?.message ??
    (children instanceof Error ? null : children) ??
    null;

  const text =
    resolvedCode !== null && has(`error.${resolvedCode}`)
      ? t(`error.${resolvedCode}`, resolvedParams)
      : raw;

  if (text === null || text === undefined) {
    return null;
  }
  return (
    <p className={styles.error} role="alert">
      {text}
    </p>
  );
}

interface DataListProps {
  items: Array<{ label: ReactNode; value: ReactNode }>;
  dense?: boolean;
}

/**
 * 键值清单。
 *
 * ffprobe 结果、DRM 设备、-h 的元信息都适合用它呈现，
 * 所以这里用语义化的 dl，而不是堆一堆 div。
 */
export function DataList({ items, dense }: DataListProps) {
  return (
    <dl className={cx(styles.dataList, dense && styles.dataListDense)}>
      {items.map((item, index) => (
        <div className={styles.dataRow} key={index}>
          <dt className={styles.dataLabel}>{item.label}</dt>
          <dd className={styles.dataValue}>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

interface CopyButtonProps {
  text: string;
  label?: string;
  compact?: boolean;
  disabled?: boolean;
}

export function CopyButton({ text, label, compact, disabled }: CopyButtonProps) {
  const { t } = useI18n();
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState('done');
    } catch {
      // 非安全上下文（例如通过内网 IP 访问）里剪贴板不可用，如实告知。
      setState('failed');
    }
    window.setTimeout(() => setState('idle'), 1800);
  };

  const caption =
    state === 'done'
      ? t('common.copied')
      : state === 'failed'
        ? t('common.copyFailed')
        : (label ?? t('common.copy'));

  return (
    <Button compact={compact} variant="ghost" onClick={copy} disabled={disabled || text === ''}>
      {caption}
    </Button>
  );
}
