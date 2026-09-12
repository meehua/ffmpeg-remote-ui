import type { MessageKey } from '../../i18n';
import type { Params } from '../../i18n/types';
import { isRecord } from '../../utils/format';
import { normalizeSettings, withOverwrite, type EncodeSettings } from '../workspace/args';

/**
 * 配方的结构版本。
 *
 * v1 → v2：编码器从「视频/音频两个平铺字段」改成「按 ffmpeg 的流定位符
 * 分类」，并且「覆盖输出文件」不再是一个布尔字段，而是命令行选项 `-y`
 * （它是 ffmpeg Global options 里的一员）。v1 的预设会在读取时自动迁移。
 */
export const RECIPE_VERSION = 2;

/** 批处理专属的命名选项：还原目录结构时用得上的两个后缀设置。 */
export interface BatchNaming {
  /** 文件名后缀，例如 _x265。 */
  suffix: string;
  /** 输出扩展名；留空表示保留原扩展名。 */
  ext: string;
}

export interface Recipe {
  settings: EncodeSettings;
  /** 手写补充参数，原样插在输出文件之前。 */
  extraArgs: string;
  /** 工作区没有命名选项，因此这个字段可以缺席。 */
  naming?: BatchNaming;
}

/** 落盘时带上版本号。 */
export interface RecipeDocument extends Recipe {
  version: number;
}

export function encodeRecipe(recipe: Recipe): RecipeDocument {
  return { version: RECIPE_VERSION, ...recipe };
}

function textOf(raw: unknown, fallback = ''): string {
  return typeof raw === 'string' ? raw : fallback;
}

/**
 * 宽容解析一份配方。
 *
 * 返回 undefined 表示这份数据完全不像配方（不是对象，或者版本比当前界面新）。
 * 其余情况一律尽量恢复：缺字段用默认值补齐，多出来的字段直接忽略——一份旧
 * 预设还能用，比一句「格式不对」有用得多。
 */
export function decodeRecipe(raw: unknown): Recipe | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const version = typeof raw.version === 'number' ? raw.version : RECIPE_VERSION;
  if (version > RECIPE_VERSION) {
    return undefined;
  }

  // v1 的「覆盖输出文件」开关，在 v2 里就是命令行选项 -y（ffmpeg 的
  // Global options 之一）。它由 withOverwrite 生成，与界面上那个开关同一条路。
  const settings =
    version < 2 && raw.overwrite === true
      ? withOverwrite(normalizeSettings(raw.settings), true)
      : normalizeSettings(raw.settings);

  const recipe: Recipe = {
    settings,
    extraArgs: textOf(raw.extraArgs),
  };

  if (isRecord(raw.naming)) {
    recipe.naming = { suffix: textOf(raw.naming.suffix), ext: textOf(raw.naming.ext) };
  }
  return recipe;
}

/**
 * 配方用不了的原因。
 *
 * 这里只给出文案 key 与插值参数，不返回成句的文字：本模块是纯数据层，
 * 该用哪种语言说话由界面决定。
 */
export interface RecipeProblem {
  key: MessageKey;
  params?: Params;
}

/** 判断一份存档/配方数据为什么用不了，供界面给出准确的提示。 */
export function describeRecipeFailure(raw: unknown): RecipeProblem {
  if (!isRecord(raw)) {
    return { key: 'preset.recipe.notObject' };
  }
  const version = typeof raw.version === 'number' ? raw.version : RECIPE_VERSION;
  if (version > RECIPE_VERSION) {
    return { key: 'preset.recipe.version', params: { version, supported: RECIPE_VERSION } };
  }
  return { key: 'preset.recipe.unrecognized' };
}
