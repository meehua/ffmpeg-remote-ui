import {
  Children,
  cloneElement,
  isValidElement,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from 'react';

import { useI18n } from '../i18n/LocaleProvider';
import { LayoutModeProvider, type LayoutMode } from './LayoutMode';
import { Tabs } from './Tabs';
import styles from './Pane.module.css';

interface PanesProps {
  children: ReactNode;
  /** 并排时的最大栏数；1 表示始终单栏。 */
  columns?: number;
}

/** 当前形态，以及并排时实际用了几列。 */
interface Layout {
  mode: LayoutMode;
  columns: number;
}

/**
 * 把设计令牌里的长度读成像素。
 *
 * 分栏阈值必须和样式表用同一个来源——在这里把 19rem 再抄一遍，两边迟早会各说
 * 各话。自定义属性本身取不到解析后的值，所以借一个不可见的探针让浏览器算。
 */
function tokenPx(name: string, fallback: number): number {
  if (typeof document === 'undefined') {
    return fallback;
  }
  const probe = document.createElement('div');
  probe.style.cssText = `position:absolute;visibility:hidden;pointer-events:none;inline-size:var(${name})`;
  document.body.appendChild(probe);
  const px = probe.getBoundingClientRect().width;
  probe.remove();
  return px > 0 ? px : fallback;
}

/**
 * 分栏容器。
 *
 * 形态只有两种，且由**一处**判定（见 LayoutMode）：
 *   排得下两栏以上 —— 并排成放得下的栏数，每一栏自己滚动；
 *   连两栏都排不下 —— 折叠成「一次一个模块」，顶部给一条切换条，整页由内容区滚动。
 *
 * 判定必须在 JS 里做，而不是交给 CSS 的 auto-fit：auto-fit 放不下时会自己减列，
 * 减出来的第二行落在一个高度已被锁死的容器里，行高被压缩、内容溢出叠到相邻栏上
 * ——这正是「收窄后组件重叠、显示不全」的来源。阈值一旦由 JS 把关，CSS 就只需要
 * 表达一种形态，不必再兜底。
 */
export function Panes({ children, columns = 2 }: PanesProps) {
  const { t } = useI18n();
  const modules = Children.toArray(children).filter(isValidElement) as Array<
    ReactElement<PaneProps>
  >;

  // 探针只跑一次：它读的是设计令牌，运行期不会变。
  const [paneMin] = useState(() => tokenPx('--pane-min', 304));
  const [layout, setLayout] = useState<Layout>({ mode: 'stacked', columns });
  const [active, setActive] = useState(0);
  const frame = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = frame.current;
    if (element === null) {
      return;
    }
    // 量 frame 而不是 .panes：后者的内边距随形态变化，拿它当基准会让阈值跟着
    // 形态摆动，在边界上反复横跳。
    const sync = () => {
      const fits = Math.min(columns, Math.floor(element.clientWidth / paneMin));
      // 能并排两栏就并排两栏，而不是「排不满就整个折叠」：1024px 这类宽度本来
      // 装得下两栏，一刀切成单模块只会让人以为「分栏没了，也没什么能滚的」。
      // 连两栏都排不下（那多半是手机）再折叠，此时并排已经没有意义。
      setLayout(fits >= 2 ? { mode: 'columns', columns: fits } : { mode: 'stacked', columns });
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(element);
    return () => observer.disconnect();
  }, [columns, paneMin]);

  // 模块数量会变（例如能力页从「加载中」变成两栏），选中的下标要收回来。
  const current = Math.min(active, Math.max(modules.length - 1, 0));
  const switching = layout.mode === 'stacked' && modules.length > 1;

  return (
    <LayoutModeProvider mode={layout.mode}>
      <div className={styles.frame} ref={frame}>
        {switching ? (
          <div className={styles.switcher}>
            <Tabs
              label={t('panes.switcher')}
              value={String(current)}
              onChange={(next) => setActive(Number(next))}
              items={modules.map((module, index) => ({
                id: String(index),
                label: module.props.title,
              }))}
            />
          </div>
        ) : null}

        <div
          className={styles.panes}
          data-mode={layout.mode}
          style={{ '--pane-count': String(layout.columns) } as CSSProperties}
        >
          {/* 折叠时只隐藏、不卸载：模块内部的展开状态、已选条目都还在，切回来
              还是原样。 */}
          {modules.map((module, index) =>
            cloneElement(module, switching ? { hidden: index !== current } : {}),
          )}
        </div>
      </div>
    </LayoutModeProvider>
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
  /** 折叠形态下被收起的模块；由 Panes 决定谁可见，Pane 只负责表现。 */
  hidden?: boolean;
}

/** 分栏里的一栏；并排时它自己是滚动容器。 */
export function Pane({ title, description, actions, children, narrow, hidden }: PaneProps) {
  return (
    <section className={styles.pane} data-narrow={narrow ? 'true' : undefined} hidden={hidden}>
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
