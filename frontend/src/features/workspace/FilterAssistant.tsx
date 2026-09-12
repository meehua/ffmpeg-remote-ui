import { useState } from 'react';

import type { FFItem } from '../../api/types';
import { Button, Select } from '../../components/Controls';
import { CopyButton } from '../../components/Display';
import { useI18n } from '../../i18n/LocaleProvider';
import { componentParams, type OptionValues } from './args';
import { OptionSection } from './OptionSection';
import styles from './CommandBuilder.module.css';

interface FilterAssistantProps {
  /** 服务器报告的滤镜，来自 `ffmpeg -filters`。 */
  filters: FFItem[];
  /** 把生成好的片段交出去：某一路流的滤镜链，或者 filter_complex 的图。 */
  onInsert: (snippet: string) => void;
}

/**
 * 滤镜参数助手：选一个滤镜，看它自己注册了哪些参数，然后把它们拼成一段
 * 可以放进滤镜链的文本。
 *
 * 为什么是「生成片段」而不是「滤镜图编辑器」：滤镜图的语法是可嵌套、可并联的
 * 表达式（`[0:v]split[a][b];[a]scale=…[c]`），任何表单式编辑器都只能表达它的
 * 一个子集，剩下的写法反而被挡住。这里只把 ffmpeg 报出来的参数如实翻成
 * `名=键=值` 那一段，图怎么写由用户决定——滤镜名与参数表都来自 FFmpeg
 * （`-filters` 与 `-h filter=<名>`），程序不维护任何滤镜清单。
 *
 * 同一段文本既用在每路流的简单滤镜链（`-filter:v`），也用在 filter_complex，
 * 所以插入目标由调用方给。
 */
export function FilterAssistant({ filters, onInsert }: FilterAssistantProps) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [values, setValues] = useState<OptionValues>({});

  const snippet = name === '' ? '' : componentParams(name, values);

  return (
    // 默认收起：它是「要用滤镜时先看一眼参数」的辅助，不该常占着一屏。
    <details className={styles.section}>
      <summary className={styles.sectionHead}>
        <span className={styles.sectionTitle}>{t('builder.filterHelper.title')}</span>
        <span className={styles.sectionMeta}>{t('builder.filterHelper.hint')}</span>
      </summary>

      <Select
        value={name}
        aria-label={t('builder.filterHelper.filter')}
        onChange={(event) => {
          // 换了滤镜，上一组参数不再属于它，跟着清掉。
          setName(event.target.value);
          setValues({});
        }}
      >
        <option value="">{t('builder.filterHelper.filter.none')}</option>
        {filters.map((item) => (
          <option key={item.name} value={item.name}>
            {item.name} · {item.description ?? ''}
          </option>
        ))}
      </Select>

      {name === '' ? (
        <p className={styles.sectionMeta}>{t('builder.filterHelper.filter.empty')}</p>
      ) : (
        <>
          <OptionSection
            label={t('builder.options.component.title', { name })}
            target="filter"
            name={name}
            ownTitle={t('builder.options.component.own.title')}
            ownHint={t('builder.options.component.own.hint', { name })}
            values={values}
            onChange={setValues}
          />

          <p className={styles.snippet} title={snippet}>
            {snippet}
          </p>

          <div className={styles.probe}>
            <Button compact onClick={() => onInsert(snippet)}>
              {t('builder.filterHelper.insert')}
            </Button>
            <CopyButton compact text={snippet} />
          </div>
        </>
      )}
    </details>
  );
}
