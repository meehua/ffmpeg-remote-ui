/**
 * 极简 i18n 引擎。
 *
 * 这个界面只有几十条文案，犯不上引入一套框架：插值、复数、兜底加起来不到
 * 一百行，而且不用为它维护构建插件。需要更复杂的能力（日期相对格式、
 * 命名空间懒加载）时再换实现，`t` 的签名是稳定的。
 *
 * 文案表以 zh-CN 为基准（见 types.ts 的说明），en-US 用 Record 约束保证不漏 key。
 */
import type { Locale, Message, Messages, Params } from './types';
import { LOCALES } from './types';
import { zhCN } from './zh-CN';
import { enUS } from './en-US';

/** 文案表里的合法 key；t() 对字面量 key 会据此补全和检查。 */
export type MessageKey = keyof typeof zhCN;

export const LOCALE_TABLES: Record<Locale, Messages> = {
  'zh-CN': zhCN,
  'en-US': enUS,
};

/**
 * 浏览器既不是中文也不是英文时的兜底语言。
 *
 * 选英文是因为本项目的文档与代码注释都以英文为默认（README、ffmpeg 的
 * 输出也全是英文），对这两者都不认识的访客来说它是最不容易帮倒忙的一种。
 * 用户手动选过一次之后就会记进本地存档，不再走这条路。
 */
export const FALLBACK_LOCALE: Locale = 'en-US';

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/**
 * 按浏览器的语言偏好挑一个最接近的语言。
 *
 * navigator.languages 已经按用户偏好排好序，逐个只看主语言标签就够了：
 * zh-TW、zh-Hans 都归到 zh-CN，en-GB 归到 en-US。
 */
export function detectLocale(): Locale {
  const tags: readonly string[] =
    typeof navigator === 'undefined' ? [] : navigator.languages ?? [navigator.language];
  for (const tag of tags) {
    switch (String(tag).toLowerCase().split('-')[0]) {
      case 'zh':
        return 'zh-CN';
      case 'en':
        return 'en-US';
      default:
        continue;
    }
  }
  return FALLBACK_LOCALE;
}

/**
 * 把 `{name}` 换成参数值。
 *
 * 参数缺失时占位符原样留下：漏传参数的条目在界面上一眼可见，比悄悄变成
 * "undefined" 或空字符串好排查。
 */
function interpolate(text: string, params?: Params): string {
  if (!params) {
    return text;
  }
  return text.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    name in params ? String(params[name]) : placeholder,
  );
}

/** 取出这次该用哪条文案；带 {one, other} 的按 count 选复数形式。 */
function pick(message: Message, locale: Locale, params?: Params): string {
  if (typeof message === 'string') {
    return interpolate(message, params);
  }
  const count = typeof params?.count === 'number' ? params.count : undefined;
  if (count === undefined) {
    return interpolate(message.other, params);
  }
  // 交给运行时的语言规则，而不是写 count === 1：那样对 0、小数都不准。
  // 文案表只准备了 one / other 两种形态（够覆盖中英文），所以这里把
  // PluralRules 交回来的其它类别（zero/few/many…）都归到 other。
  const category = new Intl.PluralRules(locale).select(count);
  return interpolate(category === 'one' ? message.one : message.other, params);
}

/**
 * 查一条文案；查不到返回 null。
 *
 * 当前语言缺失时回退到基准语言，这样某条英文漏翻时看到的是中文而不是 key。
 */
export function lookup(locale: Locale, key: string, params?: Params): string | null {
  const message = LOCALE_TABLES[locale][key] ?? LOCALE_TABLES[FALLBACK_LOCALE][key];
  return message === undefined ? null : pick(message, locale, params);
}
