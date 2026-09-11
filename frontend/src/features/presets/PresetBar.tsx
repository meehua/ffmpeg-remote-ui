import { useState } from 'react';

import { api } from '../../api/client';
import { Button, Select, TextInput } from '../../components/Controls';
import { ErrorNote } from '../../components/Display';
import { useAction, useAsync } from '../../hooks/useAsync';
import { useI18n } from '../../i18n/LocaleProvider';
import { decodeRecipe, describeRecipeFailure, encodeRecipe, type Recipe } from './recipe';
import styles from './PresetBar.module.css';

interface PresetBarProps {
  /** 当前界面状态里可以复用的那部分，保存时原样写进预设。 */
  recipe: Recipe;
  /** 载入一份预设；调用方按自己的界面结构取值。 */
  onLoad: (recipe: Recipe) => void;
}

/**
 * 预设工具条：把当前参数存到服务器，或者把某份预设取回来。
 *
 * 预设文件落在服务器的用户配置目录里（见 internal/preset），因此它跨浏览器、
 * 跨设备可用，也能直接手工编辑。这里只做读、写、删三件事。
 */
export function PresetBar({ recipe, onLoad }: PresetBarProps) {
  const { t, has } = useI18n();
  const presets = useAsync(() => api.presets(), []);
  const [selected, setSelected] = useState('');
  const [name, setName] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const action = useAction();

  const items = presets.data?.items ?? [];

  const load = async () => {
    setNote(null);
    const target = selected;
    await action.run(async () => {
      const record = await api.readPreset(target);
      const parsed = decodeRecipe(record.recipe);
      if (!parsed) {
        const problem = describeRecipeFailure(record.recipe);
        throw new Error(t(problem.key, problem.params));
      }
      onLoad(parsed);
      setName(target);
      setNote(t('preset.loaded', { name: target }));
    });
  };

  const save = async () => {
    setNote(null);
    const target = name.trim();
    await action.run(async () => {
      await api.savePreset(target, encodeRecipe(recipe));
      setSelected(target);
      setNote(t('preset.saved', { name: target }));
      presets.reload();
    });
  };

  const remove = async () => {
    setNote(null);
    const target = selected;
    if (!window.confirm(t('preset.confirmDelete', { name: target }))) {
      return;
    }
    await action.run(async () => {
      await api.deletePreset(target);
      setSelected('');
      setNote(t('preset.deleted', { name: target }));
      presets.reload();
    });
  };

  return (
    <section className={styles.bar} aria-label={t('preset.label')}>
      <div className={styles.row}>
        <Select
          value={selected}
          aria-label={t('preset.existing')}
          onChange={(event) => setSelected(event.target.value)}
        >
          <option value="">{items.length === 0 ? t('preset.none') : t('preset.select')}</option>
          {items.map((item) => (
            <option key={item.name} value={item.name}>
              {item.name}
            </option>
          ))}
        </Select>
        <Button compact onClick={load} disabled={selected === '' || action.pending}>
          {t('common.load')}
        </Button>
        <Button compact variant="danger" onClick={remove} disabled={selected === '' || action.pending}>
          {t('common.delete')}
        </Button>
      </div>

      <div className={styles.row}>
        <TextInput
          value={name}
          placeholder={t('preset.name')}
          aria-label={t('preset.name')}
          onChange={(event) => setName(event.target.value)}
        />
        <Button
          compact
          variant="primary"
          onClick={save}
          disabled={name.trim() === '' || action.pending}
        >
          {t('common.save')}
        </Button>
      </div>

      {action.error ? <ErrorNote error={action.error} /> : null}
      {presets.error ? <ErrorNote error={presets.error} /> : null}
      {/* 坏掉的预设文件是「提示」不是「错误」，所以保留自己的样式；
          文案仍按码取，跟错误走同一张表。 */}
      {presets.data?.warnings?.map((warning) => (
        <p className={styles.warning} key={warning.code}>
          {has(`error.${warning.code}`)
            ? t(`error.${warning.code}`, warning.params)
            : warning.message}
        </p>
      ))}
      {note ? <p className={styles.note}>{note}</p> : null}

      <p className={styles.hint} title={presets.data?.dir}>
        {t('preset.dir', { dir: presets.data?.dir ?? t('common.reading') })}
      </p>
    </section>
  );
}
