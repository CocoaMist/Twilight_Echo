# 播放器性能修复：第三轮（2026-10-05）

已实现[第三轮审计](D:/Project/Twilight_Echo/docs/player-performance-audit-round3-2026-10-05.md)确认的 9 项问题，并补充队列时长汇总缓存。修改保留在当前工作区；原生引擎、Node 绑定和配套运行文件已重新构建并暂存到项目资源目录，renderer 生产构建和原有体积门禁通过。

## 修复清单

| 审计问题 | 实施结果 | 主要代码 |
| --- | --- | --- |
| PCM 转 DSD 多声道步长错误 | 直接读取各声道预留缓冲指针，按实际写入长度打包，不再推断紧凑 planar 步长 | [AudioPipelineDsdUtils.h](D:/Project/Twilight_Echo/audio-engine/core/AudioPipelineDsdUtils.h)、[AudioPipeline.cpp](D:/Project/Twilight_Echo/audio-engine/core/AudioPipeline.cpp) |
| 响度表持续分配历史节点 | 使用 libebur128 固定 histogram，验证指标差异、重置和 allocator 调用 | [DspWorkspaceProcessors.cpp](D:/Project/Twilight_Echo/audio-engine/dsp/DspWorkspaceProcessors.cpp)、[loudness_realtime_tests.cpp](D:/Project/Twilight_Echo/audio-engine/tests/loudness_realtime_tests.cpp) |
| 高负载 PCM 转 DSD 超期 | FIR 改为镜像环形历史、固定抽头展开；SSE2 并行计算两个独立声道的五阶调制器 | [PcmToDsdModulator.cpp](D:/Project/Twilight_Echo/audio-engine/dsp/PcmToDsdModulator.cpp) |
| 首次打包在回调内扩容 | 直接写后端输出缓冲，删除中间 interleaved vector，取消扩容和后续复制 | [AudioPipeline.cpp](D:/Project/Twilight_Echo/audio-engine/core/AudioPipeline.cpp) |
| 卷积无关重建、重复准备 IR | 相关配置和采样格式才使运行状态失效；共享不可变 IR、重采样结果与 FFT 频谱，各实例历史独立 | [ConvolverProcessor.cpp](D:/Project/Twilight_Echo/audio-engine/dsp/ConvolverProcessor.cpp) |
| 统计全量同步保存阻塞界面 | 迁移到 IndexedDB，按脏曲目增量提交，大批量操作每批 128 项，曲目和日期汇总在同一事务提交 | [listeningStatsDatabase.ts](D:/Project/Twilight_Echo/src/renderer/src/stores/listeningStatsDatabase.ts)、[useListeningStatsStore.ts](D:/Project/Twilight_Echo/src/renderer/src/stores/useListeningStatsStore.ts) |
| 统计定时器持续被推迟 | 首次脏标记预约 30 秒检查点，后续 tick 合并内容；失败保留 dirty，60 秒后重试 | [listeningStatsPersistence.ts](D:/Project/Twilight_Echo/src/renderer/src/stores/listeningStatsPersistence.ts) |
| App 即时保存绕过防抖、队列引用失效 | Store / App 共用 1200 ms 调度；相同队列投影保留原数组，重叠的相同待写快照合并 | [usePlaybackSessionPersistence.ts](D:/Project/Twilight_Echo/src/renderer/src/app/usePlaybackSessionPersistence.ts)、[playbackSessionWriter.ts](D:/Project/Twilight_Echo/src/renderer/src/app/playbackSessionWriter.ts)、[playbackQueueVirtualization.ts](D:/Project/Twilight_Echo/src/renderer/src/utils/playbackQueueVirtualization.ts) |
| BPM 双路径重复回写 | 分析结果按完整内容比较，完成事件与请求结果重复到达时仅执行一次有效更新 | [bpmAnalysisController.ts](D:/Project/Twilight_Echo/src/renderer/src/stores/player/bpmAnalysisController.ts)、[bpmAnalysisEquality.ts](D:/Project/Twilight_Echo/src/renderer/src/utils/bpmAnalysisEquality.ts)、[useMusicStore.ts](D:/Project/Twilight_Echo/src/renderer/src/stores/useMusicStore.ts) |

另将 [PlayerBar.vue](D:/Project/Twilight_Echo/src/renderer/src/components/PlayerBar.vue) 的队列总时长计算与当前序号文案分开。仅移动播放游标时，复用已有时长汇总。

## 原生结果与正确性验证

同一台 AMD Ryzen 9 7845HX / Windows 机器、Release `-O3`。采用修复前第二轮与最新修复后测量；每项 512 次，单位为 ms。CPU 频率和系统调度仍影响尾延迟。

**192 kHz、8 声道、DSD256：**

| 传输单位 | PCM 输入帧 | 音频期限 | 修复前 p99 | 修复后 p99 | 超期次数，前 → 后 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 256 PCM 帧组件调用 | 256 | 1.333 | 1.844 | 0.475 | 512 → 0 |
| 256 DoP carrier 帧 | 64 | 0.333 | 0.457 | 0.123 | 512 → 0 |
| 256 Native DSD 字节帧 | 32 | 0.167 | 0.227 | 0.060 | 512 → 0 |

覆盖 48/192 kHz、2/8 声道、DSD64/128/256 及三种帧单位的 **36 项矩阵，修复后均为零组件超期**。没有增大音频块或改变期限；保留双精度、原有系数、稳定性检查及非 SSE2 平台的标量路径。

[PCM 转 DSD 单元测试](D:/Project/Twilight_Echo/audio-engine/tests/pcm_to_dsd_tests.cpp)另外覆盖 44.1/48/192 kHz、DSD64/128/256、1/2/3/8 声道、两种源位序和碎片输入。SIMD 多声道结果逐声道与单声道标量结果逐字节比较；失稳注入、独立恢复、reset 和现有信号恢复测试均通过。

声道专项沿用每声道预留 8192 字节的布局：Native 实际写入 256 字节、DoP 实际写入 512 字节。修复前分别有 256 / 512 个音频字节不同，修复后均为 **0**。另检查 Native MSB/LSB/NER8、DoP int24/int24-in32、奇数 marker 相位、部分输出和末端哨兵。

**响度表：**相当于 600 秒的真实 libebur128 处理，回调内 `malloc/calloc/free` 从 6595 次分配、0 次释放变为全部 **0 次**；本轮查询也没有进入这些 allocator。新增永久 CTest 与真实非 histogram 参考实现对照：180 秒变化音量信号的 integrated LUFS 差异不超过 0.1 LU，LRA 不超过 0.2 LU，momentary / short-term 不超过 0.00001 LU。histogram 的 I/LRA 有离散量化误差，没有将两者描述为严格相同。

**8 秒 IR，单组件控制准备：**

| 格式 | 无关 EQ configure 中位，修复前 | 修复后最大值 | 同格式 prepare 中位，修复前 | 修复后最大值 |
| --- | ---: | ---: | ---: | ---: |
| 48 kHz，2 声道 | 142.086 | 0.001 | 141.381 | 0.000 |
| 48 kHz，8 声道 | 564.962 | 0.002 | 543.922 | 0.000 |
| 192 kHz，2 声道 | 546.797 | 0.001 | 556.317 | 0.001 |
| 192 kHz，8 声道 | 2206.320 | 0.001 | 2284.180 | 0.000 |

每项 5 次；0.000 代表低于程序的微秒显示精度。192 kHz / 8 声道初次加载由 2212.930 ms 降到 286.122 ms，主要消除了相同单声道 IR 的重复 FFT 准备。不将单组件数字乘四作为完整 DSP 事务实测。

共享缓存位于控制侧，每类索引最多 64 项，弱引用不保留已退休图。文件身份包含规范路径、大小和修改时间；采样率、分区大小、IR 来源声道参与准备结果的键。共享部分只含不可变数据，各实例的输入、历史频谱、延迟环和输出状态独立。回归验证无关 EQ / 同格式 prepare 保留尾音、克隆图的历史为空，以及同路径更新 IR 后不使用旧频谱。`memoryBytes` 仍是保守的实例报告，不用它推导全进程 RSS 节省。

## 保存、迁移与跨层行为

**统计存储：**真实 Electron / Chromium、独立临时 profile，10,000 首 × 每首 8 天。修改一首歌只提交 **1 条曲目记录**及日期汇总，最终回归的增量存储层等待完成约 **0.7 ms**。首次批量导入约 **675.6 ms 总等待时间**，分批提交；这不是单次界面阻塞或完整统计页渲染耗时。正常检查点不再全量 `JSON.stringify` / `localStorage.setItem`。

兼容与失败处理同时接入：

- 读取旧 v1 历史，成功写入新数据库后才删除旧 key。加载期间的听歌增量排队重放；读取失败时先重试读取再写入，避免覆盖未读到的旧记录。
- 曲目和日期汇总使用一个原子事务。失败保留脏条目及版本，重试不漏掉失败或写入期间产生的修改。
- 退出协调器等待加载与最后一次异步保存；保存期间有新修改时继续提交。失败沿现有退出错误路径报告。
- 全量 / 按日期清理删除数据库对应记录。清理按钮等待保存，避免重复提交并显示失败结果。
- 个人备份导出等待统计加载；恢复写入新数据库。统计已提交后若版本关系或恢复标记失败，会回滚统计；全部完成后才确认恢复请求。

真实浏览器确认旧数据 60 秒与启动阶段新增 5 秒都保存为 65 秒；事务 abort 不部分提交，重试保留修改；全量清空、恢复回滚、恢复重试及重复恢复均通过。

**检查点定时：**第 5 秒起每 5 秒更新，连续 300 秒。修复前期间写入 0 次，停止后第 330 秒才首次写入；修复后第 **35 秒**首次写入，播放期间 **9 次**，最终 flush 后 **10 次**。空闲不产生新写入。

**会话保存：**真实 Store 控制器、App 保存器、Vue watcher 和共享 writer；磁盘 / IPC 接收端用回执桩。5000 项队列快速选择 12 次：

| 指标 | 修复前 | 修复后 |
| --- | ---: | ---: |
| 选曲触发保存 | 12 次即时写入 | 1 次防抖写入 |
| 包含退出保存 | 旧探针未计数 | 2 次 |
| 完整队列提交 | 12 次 | 1 次 |
| 发送队列项总数 | 60,000 | 5,000 |

真实来源、地址、顺序、CUE、显示字段或身份变化仍使队列失效；等价 artists / CUE 值、歌词及重分析载荷不再无效替换整条队列。重复歌曲的各 `queueEntryId` 保留。writer 只合并相同的重叠待写快照，之后的显式保存仍执行版本比较与冲突重试；退出保留即时保存。

**BPM：**真实主进程分析管理器与 renderer 控制器相连，完成事件和 completed 返回同时到达。算法只执行一次；队列 patch / 曲库 apply 从各 2 次降为各 **1 次**。缓存仍能应用；算法版本、时间、分析范围或 tempo map 的实际变化会更新。controller 的去重仅覆盖同一次待完成请求，结束后删除记录，最多 64 项；之后再次命中缓存仍查询曲库，允许补全重新加载的曲库。曲库层也比较内容，避免相同结果触发重建与保存。

## 验证记录

| 验证 | 结果 |
| --- | --- |
| 最终 MinGW 构建及资源暂存 | 通过，包含最新 engine / Node 绑定 |
| 完整原生 CTest | 40 项登记，39 通过、1 跳过、0 失败；ASIO 跨 DLL 因本机环境跳过 |
| `pnpm test:player-performance` | 61 通过、0 失败，包含真实 Chromium 数据库回归和曲库重载后的 BPM 回填 |
| Player Store、曲库元数据、会话、统计页 / UX 浏览器行为、个人备份、会话曲目专项 | 106 通过，包含与上述脚本重叠的会话用例，不累加为唯一测试数量 |
| 音频工具链专项 | 54 通过，新增响度测试已纳入目标登记和 Release 断言开启列表 |
| Node / Web 类型检查、生产构建、renderer 体积门禁 | 通过；会话与统计存储拆为独立模块，未提高原有预算 |
| 修改的 renderer / 配置 / 工具脚本 ESLint、`git diff --check` | 通过 |
| 修复后探针 | 36 项调制器矩阵、声道打包、600 秒响度、4 项卷积准备和统计 / 会话 / BPM 次数复现完成 |

原始日志、前后 JSON 与复现命令见[证据说明](D:/Project/Twilight_Echo/docs/performance-audit-evidence/2026-10-05-round3/README.md)。

## 验证边界与后续机会

调制器矩阵只计转换内核；解码、其他 DSP、打包、驱动和系统调度仍会消耗预算。**零组件超期不等于完成真实 WASAPI / ASIO 的长时间无掉音认证**。响度 600 秒为加速样本；没有进行 DAC 听感或全应用 GPU / RSS 长时间观测。

首次读取旧 localStorage、JSON 解析和归一化仍有一次性成本；主动导出完整备份仍需完整快照。此次优化针对持续播放的周期保存。大型历史迁移和首次统计页显示可继续独立测量。

原审计未列为主要缺陷的 60k 队列首次快照生成、NativeQueueLoader 复用前的完整投影 / JSON 比较仍有优化空间。现有内容比较能识别原地修改，直接改成只看数组引用会漏掉失效；继续优化需要可靠的内容版本。DSP 事务仍保持原有图实例数量，以保留提交和预加载语义，通过共享准备减少重复工作。

