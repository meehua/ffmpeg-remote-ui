import { createContext, useContext, type ReactNode } from 'react';

/**
 * 内容区的两种形态。
 *
 * columns —— 各模块并排成栏，每一栏自己滚动。这是有鼠标时的形态：滚轮停在哪一栏
 *            就滚哪一栏，切换模块不需要离开当前视线。
 * stacked —— 一次只显示一个模块，整页由内容区滚动。窄屏没有鼠标，一屏里塞进好几
 *            个滚动区只会把人困住（手指在哪个区域划、滚的是谁全凭运气），
 *            所以这里改成「一个模块一屏」。
 *
 * 形态是布局层独有的判断，但下游组件也要据此决定自己该不该成为滚动容器
 * （见 ScrollArea），所以在这里集中判定一次，再通过上下文广播出去。
 */
export type LayoutMode = 'columns' | 'stacked';

/** 默认按最保守的形态给：没有 Panes 上下文时，任何容器都不该自作主张地滚动。 */
const LayoutModeContext = createContext<LayoutMode>('stacked');

export function LayoutModeProvider({ mode, children }: { mode: LayoutMode; children: ReactNode }) {
  return <LayoutModeContext.Provider value={mode}>{children}</LayoutModeContext.Provider>;
}

export function useLayoutMode(): LayoutMode {
  return useContext(LayoutModeContext);
}
