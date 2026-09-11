import { isLocale } from './index';
import { useI18n } from './LocaleProvider';
import { LOCALES, LOCALE_LABEL } from './types';
import styles from './LocaleSwitch.module.css';

/**
 * 语言选择器。
 *
 * 用原生 select 而不是自绘下拉：浏览器自带的弹出层在移动端和读屏器上都是
 * 现成的正确实现。选项文字用各语言自己的写法（简体中文 / English），
 * 因此不管当前是哪种语言，用户都能认出自己那一项。
 *
 * 可访问名称只给 aria-label：再挂一个 title 会让原生控件同时暴露两个名字，
 * 读屏器读起来是重复的。
 */
export function LocaleSwitch() {
  const { locale, setLocale, t } = useI18n();

  return (
    <select
      className={styles.switch}
      value={locale}
      aria-label={t('locale.label')}
      onChange={(event) => {
        // 存档可能被外部改坏，所以值来自 DOM 时也校验一遍。
        if (isLocale(event.target.value)) {
          setLocale(event.target.value);
        }
      }}
    >
      {LOCALES.map((item) => (
        <option key={item} value={item}>
          {LOCALE_LABEL[item]}
        </option>
      ))}
    </select>
  );
}
