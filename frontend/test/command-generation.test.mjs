/**
 * 命令生成的端到端测试：一份设置 → 最终 argv。
 *
 * 为什么用 node:test + 仓库里已有的 tsc，而不拉一套测试框架进来：这里要断言的是
 * `args.ts` 这份纯数据变换，编译一遍就能在 node 里跑（CommonJS 输出按目录结构
 * 保留，`require` 直接解析无扩展名的相对导入）。为它再加一个 runner 与一份配置，
 * 与本仓库「界面只依赖 vite + tsc」的现状不成比例。
 *
 * 覆盖这次参数发现的改造必须守住的三件事：
 *
 *   1. 编码器自己注册的参数（-crf）与公共上下文层的参数（-global_quality）
 *      都能从设置走到命令行——后者正是以前从界面上拿不到的那批；
 *   2. filter 属于命令行选项层（-filter:a），不是编码器参数；
 *   3. 存成配方、读回来之后，生成的命令一字不差。
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

const frontend = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = mkdtempSync(join(tmpdir(), 'ffmpeg-remote-ui-args-'));

/** 把 args.ts 与 recipe.ts 编译成 CJS；tsc 会跟着 import 把依赖一起编出来。 */
function compile() {
  // 用 node 跑 typescript 自己的入口，而不是 node_modules/.bin/tsc：后者在
  // Windows 上是 .cmd 包装，execFileSync 直接执行会失败，而这个仓库明确支持
  // 在 Windows 上开发（build.ps1）。
  const tsc = join(frontend, 'node_modules', 'typescript', 'bin', 'tsc');
  execFileSync(
    process.execPath,
    [
      tsc,
      join(frontend, 'src/features/workspace/args.ts'),
      join(frontend, 'src/features/presets/recipe.ts'),
      '--outDir',
      outDir,
      '--module',
      'commonjs',
      '--target',
      'es2022',
      '--skipLibCheck',
      // tsconfig.json 就摆在旁边，而 tsc 在命令行指定文件时会拒绝加载它
      // （TS5112）。这里要的正是「一份最小配置」：这份测试只关心 args.ts
      // 的数据变换，不该跟着应用的构建选项变。
      '--ignoreConfig',
    ],
    { stdio: 'inherit' },
  );
}

compile();

const require = createRequire(import.meta.url);
const args = require(join(outDir, 'features/workspace/args.js'));
const recipe = require(join(outDir, 'features/presets/recipe.js'));

after(() => rmSync(outDir, { recursive: true, force: true }));

/** 一份设置：没配的类别缺席，硬件设备留空。 */
function settingsOf(streams, cli = {}) {
  return { cli, streams, hwDevice: { type: '', device: '' } };
}

function build(settings, extraArgs = '') {
  return args.buildArgs({ input: 'in.mp4', output: 'out.mp4', settings, extraArgs });
}

test('Case 1：编码器私有参数 → -c:v libx264 -crf 21', () => {
  const settings = settingsOf({ v: { codec: 'libx264', options: { crf: '21' } } });
  assert.deepEqual(build(settings), ['-i', 'in.mp4', '-c:v', 'libx264', '-crf', '21', 'out.mp4']);
});

test('Case 2：公共上下文层参数 → -c:v hevc_qsv -global_quality 21', () => {
  // global_quality 不在 `ffmpeg -h encoder=hevc_qsv` 的输出里，它来自
  // AVCodecContext 那一层（见 internal/ffmpeg/optiongroups.go）。命令生成这一侧
  // 不需要知道来源：两层在设置里都是「名字 → 取值」，都跟在 -c:<spec> 之后，
  // 正是 FFmpeg 接受 AVCodecContext 参数的位置。
  const settings = settingsOf({ v: { codec: 'hevc_qsv', options: { global_quality: '21' } } });
  assert.deepEqual(build(settings), [
    '-i',
    'in.mp4',
    '-c:v',
    'hevc_qsv',
    '-global_quality',
    '21',
    'out.mp4',
  ]);
});

test('Case 2b：两层参数并存时都落在 -c:<spec> 之后', () => {
  const settings = settingsOf({
    v: { codec: 'hevc_qsv', options: { preset: 'slow', global_quality: '21' } },
  });
  assert.deepEqual(build(settings), [
    '-i',
    'in.mp4',
    '-c:v',
    'hevc_qsv',
    '-preset',
    'slow',
    '-global_quality',
    '21',
    'out.mp4',
  ]);
});

test('Case 3：filter 是命令行选项层 → -filter:a loudnorm=…', () => {
  const cli = {
    filter: {
      value: 'loudnorm=I=-24:LRA=15:TP=-1',
      takesValue: true,
      position: 'output',
      spec: 'a',
    },
  };
  const argv = build(settingsOf({}, cli));
  assert.deepEqual(argv, ['-i', 'in.mp4', '-filter:a', 'loudnorm=I=-24:LRA=15:TP=-1', 'out.mp4']);

  // filter 的参数（I / LRA / TP）从不进入编码器参数表，它们只是这个取值的
  // 一部分；命令预览里也保持一个参数，不会被拆开。
  assert.equal(
    args.joinArgs(['ffmpeg', ...argv]),
    'ffmpeg -i in.mp4 -filter:a loudnorm=I=-24:LRA=15:TP=-1 out.mp4',
  );
});

test('Case 3b：视频 filter 同理 → -vf scale=1920:-2', () => {
  const cli = { vf: { value: 'scale=1920:-2', takesValue: true, position: 'output' } };
  assert.deepEqual(build(settingsOf({}, cli)), [
    '-i',
    'in.mp4',
    '-vf',
    'scale=1920:-2',
    'out.mp4',
  ]);
});

test('存档往返：写进配方再读回来，生成的命令一字不差', () => {
  const settings = settingsOf(
    {
      v: { codec: 'hevc_qsv', options: { global_quality: '21', preset: 'slow' } },
      a: { codec: 'aac', options: { b: '192k' } },
    },
    {
      y: { value: '', takesValue: false, position: 'global' },
      filter: {
        value: 'loudnorm=I=-24:LRA=15:TP=-1',
        takesValue: true,
        position: 'output',
        spec: 'a',
      },
    },
  );
  const extraArgs = '-movflags +faststart';
  const before = build(settings, extraArgs);

  // 配方落盘再读回来：这正是「存预设 → 换台机器载入」那条路。
  const document = JSON.parse(
    JSON.stringify(recipe.encodeRecipe({ settings, extraArgs })),
  );
  assert.equal(document.version, recipe.RECIPE_VERSION);

  const loaded = recipe.decodeRecipe(document);
  assert.ok(loaded, '配方应当能读回来');
  assert.deepEqual(build(loaded.settings, loaded.extraArgs), before);

  // 每一段都在该在的位置上：-y 最前、输入侧在没有、流设置跟在 -c:<spec> 后
  // （编码器私有层与公共上下文层在这里同列，顺序就是设置里的键序）、
  // filter 与手写参数在输出文件之前。
  assert.deepEqual(before, [
    '-y',
    '-i',
    'in.mp4',
    '-c:v',
    'hevc_qsv',
    '-global_quality',
    '21',
    '-preset',
    'slow',
    '-c:a',
    'aac',
    '-b',
    '192k',
    '-filter:a',
    'loudnorm=I=-24:LRA=15:TP=-1',
    '-movflags',
    '+faststart',
    'out.mp4',
  ]);
});

test('生成的命令真的能被 FFmpeg 接受', () => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  } catch {
    return; // 本机没有 ffmpeg：这一条只在这类机器上跑得起来
  }

  // 拿 libx264 验同一个 AVCodecContext 参数：本机不一定有 Intel GPU，
  // 但 global_quality 属于公共上下文层，与 hevc_qsv 共享同一份发现结果。
  const settings = settingsOf({ v: { codec: 'libx264', options: { global_quality: '21' } } });
  const argv = args.buildArgs({
    input: 'in.mp4',
    output: 'out.mp4',
    settings,
    extraArgs: '',
  });
  // 把输入输出换成一次真实的短转码：切掉 `-i in.mp4` 与末尾的输出文件，
  // 换成一段合成输入与 null 输出。要验的参数原样保留，也不在磁盘上留东西。
  const real = [
    '-hide_banner',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc=d=0.1:s=64x64',
    ...argv.slice(2, argv.length - 1),
    '-f',
    'null',
    '-',
  ];

  execFileSync('ffmpeg', real, { stdio: 'inherit' });
});
