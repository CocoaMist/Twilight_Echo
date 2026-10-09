# 播放器性能审计：第三轮（2026-10-05）

审计基线：`6dc31708`，分支 `Pxasen`。本轮检查当前实现，并核对前两轮修复；没有修改生产代码。新增隔离复现程序、原始测量和本报告。

后续状态：本报告保留修复前发现；用户授权修复后，9 项确认问题已实施修改。最新结果见[修复报告](D:/Project/Twilight_Echo/docs/player-performance-fixes-round3-2026-10-05.md)。

确认 **8 项性能或调度问题**，另外发现 **1 项 PCM 转 DSD 的声道打包正确性问题**。最先处理声道布局、实时响度表分配和高负载 PCM 转 DSD；随后处理卷积配置重建、会话保存和统计存储。

## 检查范围与证据边界

检查涵盖 renderer 的播放选择、队列快照、歌词、封面、可视化、统计、会话保存、系统媒体和小播放器同步；main 的来源授权、队列提交、播放信息轮询、音频服务调用、分析池和缓存；native 的渲染回调、PCM 转 DSD、卷积准备、响度表、DSP 图发布和回收。

- 环境：Windows，AMD Ryzen 9 7845HX（12 核 / 24 线程），Node v24.21.0，Electron 43.5.0 / Chromium 150.0.7871.250，MinGW GCC 16.2.0。
- 原生组件以 `-O3 -std=c++20` 编译，与当前 CMake Release 优化级别一致。响度表链接本机当前构建使用的 libebur128 1.2.6 静态库，并使用链接器 `--wrap` 计数 `malloc/calloc/free`。
- PCM 转 DSD 覆盖 48/192 kHz、2/8 声道、DSD64/128/256；同时覆盖 256 输入 PCM 帧，以及按 256 DoP carrier 帧 / 256 Native DSD 字节帧反算的 PCM 输入长度。每项预热 64 次，测量 512 次。两轮运行的 36 项矩阵均保留，超期指组件执行超过所代表音频的期限，**不是实测声卡掉音次数**。
- 两轮 native 的性能矩阵源码一致；第二轮原始文件先于追加声道布局复现保存，所以声道布局的两个新增记录仅在第一轮文件中。新增记录使用当前生成器和打包函数，并带差异断言。
- 响度表运行了相当于 10 分钟音频的样本，执行速度快于实时；没有在真实声卡上等候 10 分钟。
- 浏览器测量使用隐藏 Electron 窗口、独立临时用户目录和真实 `localStorage`。两轮各 3 次，未读取用户历史，未测实际页面动画或 GPU。
- JS 行为复现使用真实 Vue、保存器、主进程 BPM 管理器和 renderer 控制器；文件分析、磁盘/IPC 接收端使用明确的桩。不能将次数测试解释为完整播放启动耗时。
- 未做真实 WASAPI/ASIO 连续播放、全应用 CPU/GPU/RSS 长时间采样、网络中断或全应用堆快照；本报告不构成长期稳定性或全部格式认证。

全部源码、原始 JSON 和复现命令见 [证据目录说明](D:/Project/Twilight_Echo/docs/performance-audit-evidence/2026-10-05-round3/README.md)。

## 额外 P1：PCM 转 DSD 的声道步长与打包函数假设不一致

位置：[预留缓冲与声道指针](D:/Project/Twilight_Echo/audio-engine/core/AudioPipeline.cpp:2587)、[本次写入与打包](D:/Project/Twilight_Echo/audio-engine/core/AudioPipeline.cpp:4838)、[Native planar 读取](D:/Project/Twilight_Echo/audio-engine/core/AudioPipelineDsdUtils.h:61)、[DoP planar 读取](D:/Project/Twilight_Echo/audio-engine/decoder/DopPackerUtils.h:98)。

控制侧按 `outputBytesPerChannel(maxRenderFrames)` 为每个声道预留空间，声道指针按这一预留长度分隔。回调将输出帧换算为较少的 PCM 帧，生成器只写入这些帧对应的数据；随后传入打包函数的 `byteCount` 是实际写入长度之和。两个打包函数把 `byteCount / channels` 当作声道步长，第二声道起点因此与生成器的指针不一致。

真实函数隔离复现：48 kHz 双声道转 DSD256，输出缓冲 256 帧。每声道预留 8192 字节，Native 实际仅写 256 字节、DoP 实际仅写 512 字节。将现有调用布局与同一生成器数据的正确紧凑布局比较：

| 路径 | 打包输出长度 | 不同字节数 |
| --- | ---: | ---: |
| Native DSD | 512 | 256 |
| DoP int24-in32 | 2048 | 512 |

Native 的第二声道数据全部不同；DoP 的第二声道音频字节不同，marker / padding 仍可相同。证据是字节布局错误，未进行 DAC 听感验证。触发范围是显式开启的 PCM 转 DSD、多声道、本次写入少于预留步长；不能推广到普通 PCM 或源文件 DSD 解码路径。

建议把实际声道步长显式传给打包函数，或者直接从预分配的 per-channel 指针打包到后端输出，避免为了拼紧凑布局再分配或复制。验收覆盖 1/2/8 声道、Native/DoP、小缓冲、尾部不足帧数、不同 DSD 倍率，逐声道比较输出并核对 marker。

## 1. P1：响度表在音频回调内持续分配历史节点

位置：[libebur128 模式](D:/Project/Twilight_Echo/audio-engine/dsp/DspWorkspaceProcessors.cpp:131)、[实时调用](D:/Project/Twilight_Echo/audio-engine/dsp/DspWorkspaceProcessors.cpp:763)、[DSP 处理入口](D:/Project/Twilight_Echo/audio-engine/dsp/DspChain.cpp:723)。

模式启用了 I/LRA/M/S，未启用 `EBUR128_MODE_HISTOGRAM`，也未设置历史窗口。当前依赖头文件说明非 histogram 模式的默认历史上限为 `ULONG_MAX`。在音频回调里，`process()` 直接调用 `ebur128_add_frames_float()`。

使用真实 `LoudnessMeterProcessor` 和真实静态库，两轮分配计数完全一致：

| 音频区间 | process 内 malloc | process 内 free | 请求分配字节 |
| --- | ---: | ---: | ---: |
| 0–180 秒 | 1975 | 0 | 31,600 |
| 180–600 秒 | 4620 | 0 | 73,920 |

10 分钟总计 6595 次、105,520 字节；未包含 allocator 元数据。这里的主要问题是实时回调进入 allocator 和历史量持续增长，**不是已经证明大规模内存泄漏**；meter 重置和销毁会清理状态。暂停后状态保留时，历史也仍被持有。

作为后续方案的可行性测试，直接给同一 libebur128 使用 histogram 模式处理 180 秒音频，处理期间分配和释放均为 0。此测试没有修改产品，也没有验收 histogram 与现有指标的数值差异。

建议使用有界、无实时分配的统计结构，或通过预分配队列把统计送到分析线程；保留音频和测量语义。加入 allocator 检测门禁，并验证 integrated LUFS、LRA、重置和长时间运行。当前性能门禁通过不代表这一回调已满足零分配要求。

## 2. P1：8 声道高采样率 PCM 转 DSD256 的计算超过期限

位置：[同步转换](D:/Project/Twilight_Echo/audio-engine/core/AudioPipeline.cpp:4839)、[插值和调制内核](D:/Project/Twilight_Echo/audio-engine/dsp/PcmToDsdModulator.cpp:176)、[性能门禁固定配置](D:/Project/Twilight_Echo/audio-engine/tests/audio_performance_gate.cpp:33)。

转换发生在 `renderTyped()` 内。每个输入帧、每个声道都进行 halfband 插值，并在完整 DSD 位时钟上更新五阶调制器及稳定性检查；内部循环还移动 FIR 历史。高 DSD 倍率和多声道时，即使没有锁或分配，计算量仍可能不满足期限。

192 kHz、8 声道、DSD256 的两轮结果：

| 输入 / 输出单位 | 实际 PCM 输入帧 | 期限 | p99，第一 / 第二轮 | 超期，第一 / 第二轮 |
| --- | ---: | ---: | ---: | ---: |
| 256 PCM 帧组件测试 | 256 | 1.333 ms | 1.807 / 1.844 ms | 512 / 512 |
| 256 DoP carrier 帧 | 64 | 0.333 ms | 0.501 / 0.457 ms | 512 / 512 |
| 256 Native DSD 字节帧 | 32 | 0.167 ms | 0.243 / 0.227 ms | 512 / 512 |

已按真实传输单位换算，避免把 carrier 帧或字节帧误当 PCM 帧。计时仍只包含调制器，其他 DSP、打包和后端开销会继续占用预算。48 kHz 8 声道 DSD256 的超期随系统状态变化，不能视为所有分块都稳定失败。双声道成本显著较低；没有发现普通双声道播放同样稳定超期的证据。

建议优先将高负载转换移到有界预生成队列，由回调消费；同时优化 FIR 环形历史和声道批处理，并在控制侧明确识别不能实时支持的配置。不能仅增大块数并声称解决平均计算量。验收补齐采样率、声道、倍率和后端帧单位矩阵，检查整条链的期限、队列欠载、seek/stop 取消和格式切换。

## 3. P2：PCM 转 DSD 输出缓冲没有在控制侧预分配

位置：[只执行 clear](D:/Project/Twilight_Echo/audio-engine/core/AudioPipeline.cpp:2596)、[Native 回调打包](D:/Project/Twilight_Echo/audio-engine/core/AudioPipeline.cpp:4856)、[DoP 回调打包](D:/Project/Twilight_Echo/audio-engine/core/AudioPipeline.cpp:4877)。

新 pipeline 的 `pcmToDsdInterleavedBytes_` 容量为 0，控制侧只清空它；后续 Native/DoP 打包函数使用 `vector::resize()`。调用真实打包函数时，容量分别从 0 增到 512 / 1024 字节，确认需要在第一次回调中增长。

同样大小的后续回调会复用容量，不是每个回调都分配。更大输出块也可能再次增长。此项未单独测得掉音，但违反控制侧准备全部 scratch 的设计。建议结合声道布局修复，直接写后端输出或提前准备足够容量；测试首次播放和最大帧数变化期间的分配次数。

## 4. P2：卷积在无关配置更新和相同格式 prepare 时重建

位置：[configure / prepare](D:/Project/Twilight_Echo/audio-engine/dsp/ConvolverProcessor.cpp:354)、[rebuild](D:/Project/Twilight_Echo/audio-engine/dsp/ConvolverProcessor.cpp:737)、[频谱与工作缓冲重建](D:/Project/Twilight_Echo/audio-engine/dsp/ConvolverProcessor.cpp:798)、[DSP 图候选](D:/Project/Twilight_Echo/audio-engine/core/AudioPipeline.cpp:4471)、[一次事务建立四个候选](D:/Project/Twilight_Echo/audio-engine/core/AudioPipeline.cpp:3299)。

`configure()` 不检查卷积相关参数是否变化，`prepare()` 在格式不变时也继续 `rebuild()`；该函数销毁并重建运行分区和频谱。采样率缓存只缓存 IR 数据，不缓存已经变换好的分区。图候选为新对象，还会重新读取相同 IR。

生成匹配采样率的单声道 float32 WAV，使用真实组件。每项加载后只修改无关的 `eqPreampDb`，再 `prepare` 相同格式，各测 5 次：

| 8 秒 IR | 无关 configure 中位 | 相同格式 prepare 中位 | 运行缓冲报告 |
| --- | ---: | ---: | ---: |
| 48 kHz，2 声道 | 142.1 ms | 141.4 ms | 约 22.0 MiB |
| 48 kHz，8 声道 | 565.0 ms | 543.9 ms | 约 87.9 MiB |
| 192 kHz，2 声道 | 546.8 ms | 556.3 ms | 约 58.0 MiB |
| 192 kHz，8 声道 | 2206.3 ms | 2284.2 ms | 约 232.0 MiB |

本表是单个组件准备成本，不是一次完整 EQ 操作的耗时；未启用 FFmpeg，WAV 由内置 reader 读取。当前播放中的 `ApplyDspState` 构造两个控制候选和两个渲染候选，即使没有实际 preload 也准备两份渲染图。因此上述工作有明确的重复调用链，但不能用表中数字直接乘四当作实测端到端时延。

这些准备在控制路径上执行，不是直接锁住 render。音频服务的原生方法调用是同步的，长时间准备可能延后同一消息循环中的后续控制请求；现有服务合并能减少排队批次，但消除不了一次批次的重复 IR 准备。

建议为卷积相关配置和音频格式建立明确失效条件，复用不可变 IR 与分区频谱，单独保留每个运行实例的历史状态；无 preload 时按需准备。不要共享可变卷积历史，也不能破坏现有事务失败时保留旧图的语义。验收无关 EQ 更新不重建卷积，相同格式 prepare 直接复用，真实 IR/矩阵/采样率改变仍重建，并测控制响应及总内存峰值。

## 5. P2：统计保存仍同步阻塞 renderer，历史天数会放大成本

位置：[同步整理、序列化、setItem](D:/Project/Twilight_Echo/src/renderer/src/stores/listeningStatsPersistence.ts:91)、[容量和保留规则](D:/Project/Twilight_Echo/src/renderer/src/stores/useListeningStatsStore.ts:75)、[暂停时同步 flush](D:/Project/Twilight_Echo/src/renderer/src/stores/useListeningStatsStore.ts:551)。

前一轮已经记录这个残留问题，本轮复查并扩大到每日历史。10,000 首和 730 天的数量限制不构成序列化字节预算。

真实 Chromium，独立 profile，两轮每项各 3 次：

| 统计数据形状 | JSON 字符数 | 两轮总耗时范围 |
| --- | ---: | ---: |
| 1000 首 × 1 天 | 483,381 | 2.0–4.2 ms |
| 10,000 首 × 1 天 | 4,893,382 | 28.4–40.4 ms |
| 2000 首 × 30 天 | 6,315,961 | 36.9–57.5 ms |
| 10,000 首 × 7 天 | 10,423,508 | 58.6–83.0 ms |
| 10,000 首 × 8 天 | 11,343,529 | 71.3–105.0 ms |

以上均成功写入，**本轮没有复现 quota 错误**。每首每天均有记录属于容量压力场景，不能描述为普通用户必然达到；但在合法保留范围内确实可以产生超过 50 ms 的 renderer 同步任务。它直接影响界面响应，不能据此推导原生声卡掉音。

建议将统计迁移到异步存储，增量保存修改过的条目和天；序列化也要避免仍在 renderer 中集中完成。保留旧数据迁移、导入导出、失败重试和退出一致性。仅把 `setItem` 包在 Promise 中不会使同步工作异步。验收关注实际 renderer 阻塞时长及多天历史，而不只测 1000 首。

## 6. P2：30 秒统计保存防抖被 5 秒更新持续推迟

位置：[5 秒 tick](D:/Project/Twilight_Echo/src/renderer/src/stores/useListeningStatsStore.ts:523)、[markDirty](D:/Project/Twilight_Echo/src/renderer/src/stores/listeningStatsPersistence.ts:78)、[每次重置定时器](D:/Project/Twilight_Echo/src/renderer/src/stores/listeningStatsPersistence.ts:140)。

每次 `markDirty()` 都取消并重新预约 30 秒后的 flush，播放时每 5 秒再次调用。因此它是等待静默的防抖，不是每 30 秒保存。

虚拟时钟驱动真实保存器，连续 300 秒共 60 次脏标记：期间写入 **0 次**；停止脏标记后到第 330 秒才首次写入。暂停、隐藏和退出有 flush 兜底，不能声称正常退出必然丢数据，但长时间持续播放时不提供周期检查点，非正常中断的未保存窗口可持续扩大。

建议在首个脏标记时预约检查点，后续更新只合并内容；或设置 `maxWait`。结合上一项异步存储实施，避免恢复周期检查点后每 30 秒制造一次同步长任务。验收持续更新超过多个周期仍定期保存，空闲无写入，失败时仍保留 dirty 并重试。

## 7. P2：应用层即时保存绕过切歌防抖，队列引用变化触发全量保存

位置：[store 的 1200 ms 防抖](D:/Project/Twilight_Echo/src/renderer/src/stores/player/playbackSessionController.ts:53)、[App 对 track ID 的即时保存](D:/Project/Twilight_Echo/src/renderer/src/app/usePlaybackSessionPersistence.ts:192)、[引用决定队列失效](D:/Project/Twilight_Echo/src/renderer/src/app/playbackSessionWriter.ts:49)、[无条件替换两个队列数组](D:/Project/Twilight_Echo/src/renderer/src/stores/usePlayerStore.ts:1183)、[每次 load 调用 patch](D:/Project/Twilight_Echo/src/renderer/src/stores/usePlayerStore.ts:2910)。

store 已对选曲保存做 1200 ms 合并，但 App 在每次 track ID 变化时直接 `savePlaybackSessionSnapshot()`。共享 writer 只保证写入顺序，没有合并已排队的快照。

此外，队列保存缓存使用数组引用判断失效；`patchTrackInQueues()` 即使投影内容相同也创建新数组。用当前源码提取出的真实 patch、真实 Vue post watcher 和保存器，对 5000 项内容相同的队列依次进行 12 次选曲：得到 **12 次即时保存、12 次完整队列提交、共 60,000 项**。磁盘 API 为回执桩，测试验证触发次数而不是 I/O 耗时；不是一次真实连点播放的端到端测量。

这与已修复的原生队列 token 复用是不同路径：原生授权和加载已经减少，会话持久化仍会重复处理完整队列。已有在线地址等实际内容更新仍应被保存，不能一律把 patch 视为无变化。

建议统一选曲保存调度，退出保留即时兜底；使用持久化内容版本或内容级判断区分队列变化，并让纯元数据/引用替换不会无效重写。验收跨事件循环快速选曲合并写入，内容不变时不重发队列，真实顺序/来源/CUE 变化仍保存，版本冲突和退出重试继续正确。

## 8. P3：BPM 分析完成同时通过事件和请求结果回写

位置：[发完成事件后返回 completed](D:/Project/Twilight_Echo/src/main/audio/fileAnalysisManager.ts:181)、[主进程转发事件](D:/Project/Twilight_Echo/src/main/bpm/bpmIpc.ts:39)、[renderer 事件回写](D:/Project/Twilight_Echo/src/renderer/src/stores/usePlayerStore.ts:3416)、[请求结果也回写](D:/Project/Twilight_Echo/src/renderer/src/stores/player/bpmAnalysisController.ts:80)、[曲库应用与保存](D:/Project/Twilight_Echo/src/renderer/src/stores/useMusicStore.ts:979)。

对真实临时文件调用真实 BPM 管理器和 renderer 控制器，按生产事件顺序连接完成回调：分析 **1 次**，完成事件 **1 次**，队列 patch **2 次**，曲库 apply **2 次**。分析和曲库接口使用桩，没有重复执行真实 BPM 算法。

每次应用都会产生新 currentTrack、处理队列和曲库，并预约保存。磁盘保存本身可能被防抖合并，不能称为必然写盘两次；但重复数组处理、引用失效和 playlist snapshot 工作已经存在。

建议以分析身份和版本去重，让 completed 走一次权威更新，cached 仍正常应用；或者让回写具有内容幂等性。验收完成事件加请求结果、缓存命中、不同来源同文件和重复完成通知，确认一次结果只造成一次有效状态更新。

## 已核对的前两轮修复与暂未发现新缺陷的范围

| 范围 | 当前证据和判断 |
| --- | --- |
| 原生队列授权和内容复用 | 当前 token / cursor 路径及 5000 项选曲回归通过；授权 fallback 保持 16 并发和过期请求检查。未重复报告旧的全队列授权风暴。 |
| 歌词内容失效 | 当前内容级缓存、重新居中和桌面发布专项通过；无关对象/文档替换不会重复解析和发送全文。 |
| 封面缓存 | 本地 data URL 缓存有 128 项 / 16 MiB 上限，远程 grant 256 项，颜色摘要缓存有 64 项上限；代际清空专项通过。未发现此前的大图片字符串键回归。 |
| 可视化轮询 | 消费者计数、可见性、播放状态、单请求在途和迟到数据代际检查存在。原生 bars 省略全量 spectrum 的优化仍在。 |
| 队列虚拟窗口 | 新跑 5k/20k/60k 组件基准：最多 18 行，窗口 p95 为 0.498 / 0.041 / 0.053 ms；快照不携带重歌词/BPM 载荷。这里不是完整浏览器 DOM 测量。 |
| 初次大队列快照 | 5k/20k/60k 重建 p95 为 3.0 / 12.9 / 53.8 ms。60k 初次重建仍可能跨越多个帧预算，缓存不能消除第一次成本；通常属一次性操作，可考虑分片准备。 |
| 分析失败记录 | 1024 条上限、每 64 次请求的过期清理和成功删除回归通过。分析池默认 1 个 worker、32 个等待任务，并有超时与空闲回收。 |
| runtime 释放 | player 独立 effectScope、runtime lease、HMR dispose、时钟/可视化停止路径存在。静态检查没有证明长期运行完全无泄漏。 |
| 小播放器与系统媒体 | 小播放器进度按整秒身份和节流发送；系统媒体所有权和清理明确，不是每次时钟 tick 广播整个队列。 |
| DSP 图与解码流回收 | 有 render epoch ACK 和代际上限。新发现集中在准备成本及 meter 内部历史，未找到旧解码流无限退休的证据。 |

另外两处可后续做的小优化：`PlayerBar.vue:761` 的队列总时长与当前索引共用 computed，切换索引会重新扫描全队列，可拆成内容汇总和游标文案；`NativeQueueLoader.ts:22` 在复用路径仍进行完整投影及 JSON 比较，可考虑有明确失效边界的内容版本。本轮没有量化这两项为主要卡顿，不提高其优先级。

## 本轮验证与建议顺序

- Node 定向回归 **61 项通过**，覆盖会话、BPM、队列 token、歌词内容失效、封面和统计及分析失败记录。
- 原生 CTest 定向 **7 项通过**：DSP、卷积、WSOLA 性能、AudioBuffer、PCM 转 DSD、队列和音频管线性能门禁。使用已有本机 Release 构建，主要二进制生成时间晚于对应源文件；本轮未重新构建和暂存生产运行文件。
- 新增 JS 复现断言全部通过；原生两轮 36 项性能矩阵及真实库 allocator 检查完成；声道布局差异复现通过；卷积控制准备 4 项矩阵完成；真实 Chromium 5 项数据形状各两轮完成；队列 3 项规模基准通过。
- 生产代码未改，没有把本轮解释为修复完成，也没有重跑无关的全仓库 lint / 类型 / 发布构建。

实施顺序：**先修声道布局 → 移除 meter 的实时分配并限制高负载 PCM 转 DSD → 预分配打包缓冲 → 避免卷积无关重建 → 统一会话保存 → 异步统计存储与周期检查点 → BPM 回写幂等性**。每一项的验收应验证输出或持久化语义，并用真实设备和整机观测补齐隔离测试的边界。
