# FFmpeg Remote UI 设计原则

## 1. 只做好用且通用的功能

软件围绕真实的 FFmpeg 工作流设计，不为了“看起来完整”制造复杂的抽象层。

## 2. 不在代码里硬编码 FFmpeg 能力

编码器、解码器、滤镜、格式、muxer、demuxer、bitstream filter、protocol、device、像素格式、采样格式、layout、color、disposition、硬件加速方法等，均从运行时 FFmpeg 查询结果获取。

代码可以解析 FFmpeg 已公开且稳定的输出结构，但不得把某个具体 codec、GPU 型号、格式或厂商能力写入能力数据库。

## 3. FFmpeg 是能力的唯一事实来源

FFmpeg 更新后，软件应尽可能直接看到新增能力。针对单个组件的参数也通过 `ffmpeg -h ...` 获取，并保留原始输出。

## 4. 浏览器只是控制端

媒体文件、ffprobe、ffmpeg、GPU、任务队列和计算资源全部位于运行程序的服务器。浏览器不执行转码，也不要求用户上传服务器已有媒体。

## 5. 单一 Linux 二进制快速启动

运行时只需要程序本身以及服务器上的 FFmpeg/FFprobe。默认端口由系统随机分配；路径、端口、媒体根目录等初始行为通过环境变量覆盖，而不是强制配置文件。
