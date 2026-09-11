/** 界面支持的语言。新增一种语言：加一个 Locale、一份文案表、一条 LOCALE_LABEL。 */
export type Locale = 'zh-CN' | 'en-US';

export const LOCALES: readonly Locale[] = ['zh-CN', 'en-US'];

/** 切换器里显示的语言名，用该语言自己的写法（endonym），而不是当前界面的语言。 */
export const LOCALE_LABEL: Record<Locale, string> = {
  'zh-CN': '简体中文',
  'en-US': 'English',
};

/**
 * 一条文案。
 *
 * 字符串是常态。只有中英文的数字变化规则不同时才需要 {one, other}：
 * 英文的 "1 job" / "2 jobs" 在中文里都是「1 个任务」「2 个任务」，
 * 所以中文表这一条写字符串就够了。
 */
export type Message = string | { one: string; other: string };

export type Messages = Record<string, Message>;

/** 插值参数。`count` 另有含义：用来挑复数形式。 */
export type Params = Record<string, string | number>;
