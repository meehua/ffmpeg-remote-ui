import { useState } from 'react';

import { api } from '../../api/client';
import { Button, Select, TextInput } from '../../components/Controls';
import { ErrorNote } from '../../components/Display';
import { useAction, useAsync } from '../../hooks/useAsync';
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
        throw new Error(describeRecipeFailure(record.recipe));
      }
      onLoad(parsed);
      setName(target);
      setNote(`已载入「${target}」。`);
    });
  };

  const save = async () => {
    setNote(null);
    const target = name.trim();
    await action.run(async () => {
      await api.savePreset(target, encodeRecipe(recipe));
      setSelected(target);
      setNote(`已保存「${target}」。`);
      presets.reload();
    });
  };

  const remove = async () => {
    setNote(null);
    const target = selected;
    if (!window.confirm(`删除预设「${target}」？此操作不可撤销。`)) {
      return;
    }
    await action.run(async () => {
      await api.deletePreset(target);
      setSelected('');
      setNote(`已删除「${target}」。`);
      presets.reload();
    });
  };

  return (
    <section className={styles.bar} aria-label="预设">
      <div className={styles.row}>
        <Select
          value={selected}
          aria-label="已有预设"
          onChange={(event) => setSelected(event.target.value)}
        >
          <option value="">{items.length === 0 ? '还没有预设' : '选择一份预设'}</option>
          {items.map((item) => (
            <option key={item.name} value={item.name}>
              {item.name}
            </option>
          ))}
        </Select>
        <Button compact onClick={load} disabled={selected === '' || action.pending}>
          载入
        </Button>
        <Button compact variant="danger" onClick={remove} disabled={selected === '' || action.pending}>
          删除
        </Button>
      </div>

      <div className={styles.row}>
        <TextInput
          value={name}
          placeholder="预设名"
          aria-label="预设名"
          onChange={(event) => setName(event.target.value)}
        />
        <Button
          compact
          variant="primary"
          onClick={save}
          disabled={name.trim() === '' || action.pending}
        >
          保存
        </Button>
      </div>

      {action.error ? <ErrorNote>{action.error}</ErrorNote> : null}
      {presets.error ? <ErrorNote>{presets.error}</ErrorNote> : null}
      {presets.data?.warnings?.map((warning) => (
        <p className={styles.warning} key={warning}>
          {warning}
        </p>
      ))}
      {note ? <p className={styles.note}>{note}</p> : null}

      <p className={styles.hint} title={presets.data?.dir}>
        预设保存在服务器：{presets.data?.dir ?? '读取中…'}
      </p>
    </section>
  );
}
