/**
 * 输出路径的推导。
 *
 * 工作区（单文件）与批处理（一组文件）用的是同一条规则：目录 + 相对路径 + 后缀 +
 * 扩展名。规则只写在这里一份——两边各写一遍的话，「批处理里对、工作区里错」这类
 * 差异迟早会出现，而且很难看出是哪一边的问题。
 */

import { baseName, relativeTo } from '../../utils/format';

/** 去掉最后一个扩展名；没有扩展名时原样返回。 */
export function stripExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

export interface OutputNaming {
  /** 输出目录。 */
  dir: string;
  /** 文件名后缀，插在扩展名之前。 */
  suffix: string;
  /** 输出扩展名；留空表示沿用输入的扩展名。 */
  ext: string;
  /** 还原目录结构时的参照根；为空表示平铺。 */
  root: string;
}

/**
 * 输入文件相对扫描根的那一段（保留子目录、去掉扩展名）。
 *
 * 返回 null 表示这个文件不在扫描根下（用户手工加进来的，或者换了扫描根），
 * 此时退回平铺到输出目录，而不是猜一个结构出来。
 */
function relativeStem(input: string, root: string): string | null {
  const rel = relativeTo(input, root.trim());
  if (rel === null) {
    return null;
  }
  const name = baseName(rel);
  return rel.slice(0, rel.length - name.length) + stripExtension(name);
}

/**
 * 按「目录 + 相对路径 + 后缀 + 扩展名」推出输出路径。
 *
 * 扩展名始终由「输出扩展名」决定：还原目录结构只负责把文件放回原来的子目录，
 * 命名仍然归命名设置管，两件事互不干扰。
 *
 * 分隔符跟着输出目录自己的写法走：服务器的路径在 Windows 上是反斜杠，这里若一律
 * 拼 `/`，出来的 `C:\out/name.mp4` 虽然 ffmpeg 认，但显示给用户就是一条错路径。
 */
export function outputPathFor(input: string, naming: OutputNaming): string {
  const name = baseName(input);
  const original = name.slice(stripExtension(name).length).replace(/^\./, '');
  const wanted = naming.ext.trim().replace(/^\./, '');
  const extension = wanted !== '' ? wanted : original;
  const tail = extension === '' ? '' : `.${extension}`;

  const prefix = relativeStem(input, naming.root) ?? stripExtension(name);
  const dir = naming.dir.replace(/[\\/]+$/, '');
  const separator = dir.includes('\\') ? '\\' : '/';
  return `${dir}${separator}${prefix}${naming.suffix}${tail}`;
}
