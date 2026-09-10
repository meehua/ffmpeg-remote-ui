import type { CSSProperties, ReactNode } from 'react';

import styles from './Pane.module.css';

interface PanesProps {
  children: ReactNode;
  /** 横屏时并排的栏数；1 表示始终单栏。 */
  columns?: number;
}

/**
 * 分栏容器。
 *
 * 竖屏（或窗口太窄）时它是一串卡片，整体随文档流滚动；横屏时变成并列的
 * 分栏，每一栏各自纵向滚动。两种形态是同一份 DOM，只由 CSS 在方向变化时
 * 切换，因此不存在两套布局代码，也不需要 JS 监听视口。
 */
export function Panes({ children, columns = 2 }: PanesProps) {
  return (
    <div className={styles.panes} style={{ '--pane-count': String(columns) } as CSSProperties}>
      {children}
    </div>
  );
}

interface PaneProps {
  title: ReactNode;
  description?: ReactNode;
  /** 标题右侧的操作区。 */
  actions?: ReactNode;
  children: ReactNode;
  /** 控件为主的栏，限制行宽更好读。 */
  narrow?: boolean;
}

/** 分栏里的一栏；横屏时它自己是滚动容器。 */
export function Pane({ title, description, actions, children, narrow }: PaneProps) {
  return (
    <section className={styles.pane} data-narrow={narrow ? 'true' : undefined}>
      <header className={styles.head}>
        <div className={styles.titles}>
          <h2 className={styles.title}>{title}</h2>
          {description ? <p className={styles.description}>{description}</p> : null}
        </div>
        {actions ? <div className={styles.headActions}>{actions}</div> : null}
      </header>
      <div className={styles.body}>{children}</div>
    </section>
  );
}
