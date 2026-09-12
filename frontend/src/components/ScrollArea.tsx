import type { CSSProperties, ReactNode } from 'react';

import { cx } from '../utils/format';
import { useLayoutMode } from './LayoutMode';
import styles from './ScrollArea.module.css';

interface ScrollAreaProps {
  children: ReactNode;
  /** 可访问名称：读屏器靠它说明这个可滚动区域里装的是什么。 */
  label: string;
  /**
   * 并排分栏时允许的最大块级尺寸。窄屏下忽略——那时整页在滚，
   * 再限一次高等于把内容关进小盒子。
   */
  maxBlockSize?: string;
  className?: string;
}

/**
 * 通用滚动容器。
 *
 * 「滚动」这件事只由它负责：被包住的组件自己不设 overflow，内容长了就套一层这个。
 * 这样滚动条出现在哪儿是可数的——它永远在显式声明的区域上，而不是某个组件的默认
 * 行为漏出来的。
 *
 * 只有并排分栏时才真的滚动并限高：宽屏有鼠标，一栏里独立的滚轮目标很好用；窄屏
 * 用的是「一个模块一屏」，这里就退化成普通盒子，把高度还给文档流。
 *
 * role="region" 配 tabIndex，键盘用户也能把焦点移进来用方向键滚动，而不必先点一下。
 */
export function ScrollArea({ children, label, maxBlockSize, className }: ScrollAreaProps) {
  const scrolls = useLayoutMode() === 'columns';

  return (
    <div
      className={cx(styles.area, scrolls && styles.scrolls, className)}
      style={maxBlockSize ? ({ '--scroll-max': maxBlockSize } as CSSProperties) : undefined}
      role={scrolls ? 'region' : undefined}
      aria-label={scrolls ? label : undefined}
      tabIndex={scrolls ? 0 : undefined}
    >
      {children}
    </div>
  );
}
