/**
 * 预设配方：界面状态里真正可以复用的那部分。
 *
 * 结构由前端定义并带版本号，后端（internal/preset）只把它原样存进
 * <配置目录>/presets/<名字>.json。这样一来，界面加一个字段、调一次结构，
 * 都不需要后端跟着发版；预设文件也始终是干净、可读、能手工编辑的 JSON。
 *
 * 配方里的 settings 是**整个**转码设置——既包含每类流的编码器与参数，也包含
 * 命令行选项。所以「这一套我调好了」可以整套存下来：把常用的组合存成预设，
 * 比在界面上翻找每个选项省事得多。
 */

import { normalizeSettings, type EncodeSettings } from '../workspace/args';
import { isRecord } from '../../utils/format';

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

  const settings = normalizeSettings(raw.settings);

  // v1 的「覆盖输出文件」开关，在 v2 里就是命令行选项 -y（ffmpeg 的
  // Global options 之一）。位置固定在最前，因为全局选项只能放在那里。
  if (version < 2 && raw.overwrite === true && settings.cli.y === undefined) {
    settings.cli.y = { value: '', takesValue: false, position: 'global' };
  }

  const recipe: Recipe = {
    settings,
    extraArgs: textOf(raw.extraArgs),
  };

  if (isRecord(raw.naming)) {
    recipe.naming = { suffix: textOf(raw.naming.suffix), ext: textOf(raw.naming.ext) };
  }
  return recipe;
}

/** 判断一份存档/配方数据是否可用，供界面给出准确的提示。 */
export function describeRecipeFailure(raw: unknown): string {
  if (!isRecord(raw)) {
    return '预设内容不是一个 JSON 对象';
  }
  const version = typeof raw.version === 'number' ? raw.version : RECIPE_VERSION;
  if (version > RECIPE_VERSION) {
    return `预设的格式版本是 ${version}，当前界面只认识 ${RECIPE_VERSION}`;
  }
  return '预设内容无法识别';
}
