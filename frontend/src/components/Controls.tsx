import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';

import { cx } from '../utils/format';
import styles from './Controls.module.css';

/* ---------------------------------------------------------------- 按钮 */

type ButtonVariant = 'default' | 'primary' | 'danger' | 'ghost';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  compact?: boolean;
}

export function Button({ variant = 'default', compact, className, type = 'button', ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      className={cx(styles.button, styles[variant], compact && styles.compact, className)}
    />
  );
}

/* ---------------------------------------------------------------- 输入 */

export function TextInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={cx(styles.input, className)} />;
}

export function TextArea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...rest} className={cx(styles.textarea, className)} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...rest} className={cx(styles.select, className)}>
      {children}
    </select>
  );
}

/* ---------------------------------------------------------------- 布局辅助 */

interface FieldProps {
  label: ReactNode;
  /** 控件下方的补充说明。 */
  hint?: ReactNode;
  children: ReactNode;
}

/** 标签在上、控件居中、说明在下的标准表单行。 */
export function Field({ label, hint, children }: FieldProps) {
  return (
    <label className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      {children}
      {hint ? <span className={styles.fieldHint}>{hint}</span> : null}
    </label>
  );
}

interface SwitchProps {
  label: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}

/**
 * 开关。
 *
 * 用原生 checkbox 承载状态，外观由 CSS 绘制，因此键盘与读屏器的行为
 * 和系统控件完全一致，不需要自己实现 ARIA 键盘交互。
 */
export function Switch({ label, checked, onChange, disabled }: SwitchProps) {
  return (
    <label className={cx(styles.switch, disabled && styles.switchDisabled)}>
      <input
        type="checkbox"
        className={styles.switchInput}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className={styles.switchTrack} aria-hidden="true" />
      <span className={styles.switchLabel}>{label}</span>
    </label>
  );
}

interface ButtonRowProps {
  children: ReactNode;
}

/** 一组按钮，窄屏时自动换行。 */
export function ButtonRow({ children }: ButtonRowProps) {
  return <div className={styles.buttonRow}>{children}</div>;
}
