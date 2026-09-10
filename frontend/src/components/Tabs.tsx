import { cx } from '../utils/format';
import styles from './Tabs.module.css';

export interface TabItem<T extends string> {
  id: T;
  label: string;
  count?: number;
}

interface TabsProps<T extends string> {
  items: Array<TabItem<T>>;
  value: T;
  onChange: (id: T) => void;
  /** 供读屏器描述这组标签页的用途。 */
  label: string;
}

/**
 * 纯按钮实现的标签页。
 *
 * 没有用 role="tab" 的完整 ARIA 组合（那还需要 tabpanel 与 roving tabindex），
 * 因为这里的切换其实等价于「换一份列表内容」，用一组普通按钮语义更诚实。
 */
export function Tabs<T extends string>({ items, value, onChange, label }: TabsProps<T>) {
  return (
    <div className={styles.tabs} role="group" aria-label={label}>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          aria-pressed={item.id === value}
          className={cx(styles.tab, item.id === value && styles.active)}
          onClick={() => onChange(item.id)}
        >
          {item.label}
          {typeof item.count === 'number' ? <span className={styles.count}>{item.count}</span> : null}
        </button>
      ))}
    </div>
  );
}
