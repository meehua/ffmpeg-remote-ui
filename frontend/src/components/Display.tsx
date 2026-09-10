import { useState, type ReactNode } from 'react';

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

export function Spinner({ label = '加载中' }: { label?: string }) {
  return (
    <span className={styles.spinnerWrap} role="status">
      <span className={styles.spinner} aria-hidden="true" />
      <span className={styles.spinnerLabel}>{label}</span>
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

/** 错误提示；用 alert 角色让读屏器立刻播报。 */
export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <p className={styles.error} role="alert">
      {children}
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

export function CopyButton({ text, label = '复制', compact, disabled }: CopyButtonProps) {
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

  const caption = state === 'done' ? '已复制' : state === 'failed' ? '无法复制' : label;

  return (
    <Button compact={compact} variant="ghost" onClick={copy} disabled={disabled || text === ''}>
      {caption}
    </Button>
  );
}
