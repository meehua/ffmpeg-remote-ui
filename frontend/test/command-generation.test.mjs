/**
 * 命令生成的端到端测试：一份设置 → 最终 argv。
 *
 * 为什么用 node:test + 仓库里已有的 tsc，而不拉一套测试框架进来：这里要断言的是
 * `args.ts` 这份纯数据变换，编译一遍就能在 node 里跑（CommonJS 输出按目录结构
 * 保留，`require` 直接解析无扩展名的相对导入）。为它再加一个 runner 与一份配置，
 * 与本仓库「界面只依赖 vite + tsc」的现状不成比例。
 *
 * 覆盖参数来源扩展之后必须守住的事：
 *
 *   1. 编码器自己注册的参数（-crf）与公共上下文层的参数（-global_quality）
 *      都能从设置走到命令行——后者正是以前从界面上拿不到的那批；
 *   2. 解码器落在输入侧（早于 -i）；bsf 与简单滤镜链落在输出侧；
 *   3. filter_complex 与它的 -map 成对出现，空的那条不进命令；
 *   4. 同一个命令行选项可以重复出现（连着好几条 -map）；
 *   5. 容器（-f）与协议参数按方向各归各位。
 *   6. 存成配方、读回来之后，生成的命令一字不差；旧结构的预设（v1 的布尔开关、
 *      v2 的「名字 -> 取值」映射）照样读得回来。
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

/**
 * 一份设置：从空设置派生，只覆盖这次要断言的部分。
 *
 * 必须从 emptySettings 派生而不是手写三个字段：buildArgs 会读容器、协议、
 * 滤镜图这些字段，缺了它们就不是「没配置」，而是数据不完整。
 */
function settingsOf(streams, cli = []) {
  return { ...args.emptySettings, cli, streams };
}

function build(settings, extraArgs = '') {
  return args.buildArgs({ input: 'in.mp4', output: 'out.mp4', settings, extraArgs });
}

test('Case 1：编码器私有参数 → -c:v libx264 -crf 21', () => {
  const settings = settingsOf({ v: { ...args.emptyStream, codec: 'libx264', options: { crf: '21' } } });
  assert.deepEqual(build(settings), ['-i', 'in.mp4', '-c:v', 'libx264', '-crf', '21', 'out.mp4']);
});

test('Case 2：公共上下文层参数 → -c:v hevc_qsv -global_quality 21', () => {
  // global_quality 不在 `ffmpeg -h encoder=hevc_qsv` 的输出里，它来自
  // AVCodecContext 那一层（见 internal/ffmpeg/optiongroups.go）。命令生成这一侧
  // 不需要知道来源：两层在设置里都是「名字 → 取值」，都跟在 -c:<spec> 之后，
  // 正是 FFmpeg 接受 AVCodecContext 参数的位置。
  const settings = settingsOf({
    v: { ...args.emptyStream, codec: 'hevc_qsv', options: { global_quality: '21' } },
  });
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
    v: { ...args.emptyStream, codec: 'hevc_qsv', options: { preset: 'slow', global_quality: '21' } },
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
  const cli = [
    {
      name: 'filter',
      value: 'loudnorm=I=-24:LRA=15:TP=-1',
      takesValue: true,
      position: 'output',
      spec: 'a',
    },
  ];
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
  const cli = [{ name: 'vf', value: 'scale=1920:-2', takesValue: true, position: 'output' }];
  assert.deepEqual(build(settingsOf({}, cli)), [
    '-i',
    'in.mp4',
    '-vf',
    'scale=1920:-2',
    'out.mp4',
  ]);
});

test('Case 4：解码器落在输入侧（早于 -i），参数跟在它后面', () => {
  const settings = settingsOf({
    v: { ...args.emptyStream, decoder: 'hevc_cuvid', decoderOptions: { gpu: '0' } },
  });
  assert.deepEqual(build(settings), [
    '-c:v',
    'hevc_cuvid',
    '-gpu',
    '0',
    '-i',
    'in.mp4',
    'out.mp4',
  ]);
});

test('Case 5：bsf 与它自己的参数拼成一段文本', () => {
  const settings = settingsOf({
    v: {
      ...args.emptyStream,
      codec: 'libx264',
      bitstreamFilter: 'h264_metadata',
      bitstreamOptions: { aud: 'insert', colour_primaries: '1' },
    },
  });
  assert.deepEqual(build(settings), [
    '-i',
    'in.mp4',
    '-c:v',
    'libx264',
    '-bsf:v',
    'h264_metadata=aud=insert:colour_primaries=1',
    'out.mp4',
  ]);
});

test('Case 6：简单滤镜链落在输出侧 → -filter:v scale=…,fps=…', () => {
  const settings = settingsOf({
    v: { ...args.emptyStream, codec: 'libx264', filter: 'scale=1280:-1,fps=30' },
  });
  assert.deepEqual(build(settings), [
    '-i',
    'in.mp4',
    '-c:v',
    'libx264',
    '-filter:v',
    'scale=1280:-1,fps=30',
    'out.mp4',
  ]);
});

test('Case 7：filter_complex 与它的 -map 成对出现，空的那条不进命令', () => {
  const settings = {
    ...args.emptySettings,
    filterComplex: { graph: '[0:v]scale=1280:-1[outv]', maps: ['[outv]', '   '] },
  };
  assert.deepEqual(build(settings), [
    '-i',
    'in.mp4',
    '-filter_complex',
    '[0:v]scale=1280:-1[outv]',
    '-map',
    '[outv]',
    'out.mp4',
  ]);

  // 图是空的（没配过滤镜）：整段都不生成——空的 -filter_complex '' 会让 ffmpeg 报错。
  assert.deepEqual(build({ ...args.emptySettings, filterComplex: { graph: '  ', maps: ['[outv]'] } }), [
    '-i',
    'in.mp4',
    'out.mp4',
  ]);
});

test('Case 8：同一个命令行选项可以重复出现（连着好几条 -map）', () => {
  const cli = [
    { name: 'map', value: '[vout]', takesValue: true, position: 'output' },
    { name: 'map', value: '[aout]', takesValue: true, position: 'output' },
    { name: 'map', value: '0:s?', takesValue: true, position: 'output' },
  ];
  assert.deepEqual(build(settingsOf({}, cli)), [
    '-i',
    'in.mp4',
    '-map',
    '[vout]',
    '-map',
    '[aout]',
    '-map',
    '0:s?',
    'out.mp4',
  ]);
});

test('Case 9：容器（-f）与协议参数各归各位', () => {
  const settings = {
    ...args.emptySettings,
    // 输入侧的协议参数在输入选项之前，输入格式紧挨着输入文件。
    inputProtocol: { name: 'rtmp', options: { timeout: '5' } },
    inputFormat: { name: 'v4l2', options: { video_size: '640x480' } },
    // 输出侧的格式与它的私有参数（movflags 就是 muxer 的 AVOption）在输出文件之前。
    outputFormat: { name: 'mp4', options: { movflags: '+faststart' } },
    outputProtocol: { name: 'http', options: { send_expect_100: '0' } },
  };
  assert.deepEqual(build(settings), [
    '-timeout',
    '5',
    '-f',
    'v4l2',
    '-video_size',
    '640x480',
    '-i',
    'in.mp4',
    '-f',
    'mp4',
    '-movflags',
    '+faststart',
    '-send_expect_100',
    '0',
    'out.mp4',
  ]);
});

test('存档往返：写进配方再读回来，生成的命令一字不差', () => {
  const settings = settingsOf(
    {
      v: {
        ...args.emptyStream,
        codec: 'hevc_qsv',
        options: { global_quality: '21', preset: 'slow' },
        decoder: 'hevc_cuvid',
        bitstreamFilter: 'h264_metadata',
      },
      a: { ...args.emptyStream, codec: 'aac', options: { b: '192k' } },
    },
    [
      { name: 'y', value: '', takesValue: false, position: 'global' },
      {
        name: 'filter',
        value: 'loudnorm=I=-24:LRA=15:TP=-1',
        takesValue: true,
        position: 'output',
        spec: 'a',
      },
    ],
  );
  settings.filterComplex = { graph: '[0:v]scale=1280:-1[vout]', maps: ['[vout]'] };
  settings.outputFormat = { name: 'mp4', options: { movflags: '+faststart' } };

  const extraArgs = '-max_muxing_queue_size 1024';
  const before = build(settings, extraArgs);

  // 配方落盘再读回来：这正是「存预设 → 换台机器载入」那条路。
  const document = JSON.parse(JSON.stringify(recipe.encodeRecipe({ settings, extraArgs })));
  assert.equal(document.version, recipe.RECIPE_VERSION);

  const loaded = recipe.decodeRecipe(document);
  assert.ok(loaded, '配方应当能读回来');
  assert.deepEqual(build(loaded.settings, loaded.extraArgs), before);

  // 每一段都在该在的位置上：-y 最前，解码器早于 -i，图与 -map 紧跟输入，
  // 编码器/bsf/filter 在输出文件之前，容器与它的参数也在那里，手写参数最后。
  assert.deepEqual(before, [
    '-y',
    '-c:v',
    'hevc_cuvid',
    '-i',
    'in.mp4',
    '-filter_complex',
    '[0:v]scale=1280:-1[vout]',
    '-map',
    '[vout]',
    '-c:v',
    'hevc_qsv',
    '-global_quality',
    '21',
    '-preset',
    'slow',
    '-bsf:v',
    'h264_metadata',
    '-c:a',
    'aac',
    '-b',
    '192k',
    '-filter:a',
    'loudnorm=I=-24:LRA=15:TP=-1',
    '-f',
    'mp4',
    '-movflags',
    '+faststart',
    '-max_muxing_queue_size',
    '1024',
    'out.mp4',
  ]);
});

test('旧结构的预设照样读得回来：v1 的布尔开关、v2 的「名字 -> 取值」映射', () => {
  // v1：编码器平铺在顶层，「覆盖输出文件」还是一个布尔字段。
  const v1 = recipe.decodeRecipe({
    version: 1,
    settings: { videoCodec: 'libx264', videoOptions: { crf: '21' } },
    extraArgs: '',
    overwrite: true,
  });
  assert.ok(v1);
  assert.deepEqual(build(v1.settings), ['-y', '-i', 'in.mp4', '-c:v', 'libx264', '-crf', '21', 'out.mp4']);

  // v2：命令行选项是映射（那时同一个选项只能出现一次）。列表化之后照样读得回来。
  const v2 = recipe.decodeRecipe({
    version: 2,
    settings: {
      cli: { y: { value: '', takesValue: false, position: 'global' } },
      streams: { v: { codec: 'libx264', options: {} } },
      hwDevice: { type: '', device: '' },
    },
    extraArgs: '',
  });
  assert.ok(v2);
  assert.equal(v2.settings.cli.length, 1);
  assert.equal(v2.settings.cli[0].name, 'y');
  assert.deepEqual(build(v2.settings), ['-y', '-i', 'in.mp4', '-c:v', 'libx264', 'out.mp4']);
});

test('生成的命令真的能被 FFmpeg 接受', () => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  } catch {
    return; // 本机没有 ffmpeg：这一条只在这类机器上跑得起来
  }

  // 拿 libx264 验同一个 AVCodecContext 参数：本机不一定有 Intel GPU，
  // 但 global_quality 属于公共上下文层，与 hevc_qsv 共享同一份发现结果。
  const settings = settingsOf({
    v: {
      ...args.emptyStream,
      codec: 'libx264',
      options: { global_quality: '21' },
      // bsf 与简单滤镜链这一段也给 ffmpeg 真的跑一次：它们的语法由本程序拼出来
      // （`name=key=value:key2=value2`、`-filter:<spec>`），拼错了只有 ffmpeg 会说。
      bitstreamFilter: 'h264_metadata',
      bitstreamOptions: { aud: 'insert' },
      filter: 'scale=64:64',
    },
  });
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

test('filter_complex 与 -map 生成的命令真的能被 FFmpeg 接受', () => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  } catch {
    return;
  }

  const settings = {
    ...args.emptySettings,
    filterComplex: { graph: '[0:v]scale=64:64[outv]', maps: ['[outv]'] },
  };
  const argv = args.buildArgs({ input: 'in.mp4', output: 'out.mp4', settings, extraArgs: '' });
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

test('Case 10：输入侧与输出侧各初始化一个硬件设备，两块卡各生成一条', () => {
  // 两块卡各管一边：类型相同、设备不同，两条都必须在——这里是用户真的指定了
  // 两个设备，丢掉第二条就等于输出侧那块卡没生效。
  const twoCards = {
    ...args.emptySettings,
    inputHardware: { type: 'qsv', device: '/dev/dri/renderD128' },
    outputHardware: { type: 'qsv', device: '/dev/dri/renderD129' },
  };
  assert.deepEqual(build(twoCards).slice(0, 4), [
    '-init_hw_device',
    'qsv=qsv:/dev/dri/renderD128',
    '-init_hw_device',
    'qsv=qsv2:/dev/dri/renderD129',
  ]);

  // 两侧不同类型：也是各一条（输入用 cuda 解码、输出用 qsv 编码）。
  const both = {
    ...args.emptySettings,
    inputHardware: { type: 'cuda', device: '' },
    outputHardware: { type: 'qsv', device: '0' },
  };
  assert.deepEqual(build(both).slice(0, 4), [
    '-init_hw_device',
    'cuda=cuda',
    '-init_hw_device',
    'qsv=qsv:0',
  ]);

  // 两侧填得一模一样：那是同一次初始化，并成一条。
  const same = {
    ...args.emptySettings,
    inputHardware: { type: 'qsv', device: '0' },
    outputHardware: { type: 'qsv', device: '0' },
  };
  assert.deepEqual(build(same).slice(0, 2), ['-init_hw_device', 'qsv=qsv:0']);

  // 两侧都留空：一条也不生成，其余照旧。
  assert.deepEqual(build(args.emptySettings), ['-i', 'in.mp4', 'out.mp4']);
});

test('旧预设里那一个 hwDevice 迁到输入侧，生成的命令一字不差', () => {
  const loaded = recipe.decodeRecipe({
    version: 2,
    settings: {
      cli: [],
      streams: {},
      hwDevice: { type: 'qsv', device: '0' },
    },
    extraArgs: '',
  });
  assert.ok(loaded, '旧配方应当能读回来');
  assert.equal(loaded.settings.inputHardware.type, 'qsv');
  assert.equal(loaded.settings.outputHardware.type, '');
  assert.deepEqual(build(loaded.settings).slice(0, 2), ['-init_hw_device', 'qsv=qsv:0']);
});
