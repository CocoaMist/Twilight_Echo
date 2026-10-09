# 第二轮性能修复证据

对应 [实施记录](D:/Project/Twilight_Echo/docs/player-performance-round2-implementation-2026-10-05.md)。原始审计数据保留在相邻 `2026-10-05-round2` 目录；该目录的歌词源码提取器针对修复前的结构，修复后的失效行为由新增回归测试验证。

## 原生复测

`native-postfix.cpp` 直接链接卷积、FFT、队列的当前源码。两次运行分别保存为 `native-results.jsonl`、`native-results-repeat.jsonl`，每次 27 条记录。编译参数与修复前一致：`-O2 -std=c++20`。本机 AMD Ryzen 9 7845HX，Windows；计时包含组件执行，不包含声卡、完整 IPC 和绘制。

卷积每次 256 帧，覆盖 18 个组合。预热延长至完整 IR 时长加 64 次回调，测量 512 次，避免低估尚未填满的历史。`activeCalls` 记录进入处理前活动的回调数；`warmupPeakMs` 和 `warmupDeadlineMisses` 保留保护触发前的真实开销。预热旁路的记录不能用作活动卷积性能。`p999Ms` 在这个样本数量下等于最大值，不是长期尾延迟保证。

频谱比较原始 4096 点与直接生成 140 根柱条的接口，FFT 仍为 8192。队列加载包含第一次解析；中位数主要反映相同 JSON 的复用。`queueCursor` 单独测量游标更新，不包括路径重新授权。20000 项仅为组件探测，公开 IPC 上限仍为 5000。

```powershell
$auditOutputPath = Join-Path ([System.IO.Path]::GetTempPath()) 'twilight-player-round2-fixes-repro'
New-Item -ItemType Directory -Force -Path $auditOutputPath | Out-Null
$auditExecutablePath = Join-Path $auditOutputPath 'native-postfix.exe'
& D:\TwilightEchoDependencies\w64devkit\bin\g++.exe -O2 -std=c++20 -I audio-engine docs/performance-audit-evidence/2026-10-05-round2-fixes/native-postfix.cpp audio-engine/dsp/ConvolverProcessor.cpp audio-engine/dsp/FftSpectrumAnalyzer.cpp audio-engine/dsp/KissFftAdapter.cpp audio-engine/playlist/QueueManager.cpp -o $auditExecutablePath
if ($LASTEXITCODE -ne 0) { throw 'Compilation failed' }
& $auditExecutablePath $auditOutputPath
if ($LASTEXITCODE -ne 0) { throw 'Benchmark failed' }
```

## 正确性和行为回归

- `audio-engine/tests/convolver_tests.cpp`：与直接卷积比较全部输出，覆盖非均匀分区边界、后期输入、回调分块、重置尾音和周期性超预算计数。
- `audio-engine/tests/dsp_tests.cpp`：原生柱条与原算法逐项比较，检查空闲零值与省略的 payload。
- 原生队列及运行时测试：同内容游标更新、随机模式、非法输入、同文件 CUE 范围和无效索引。
- `nativeQueueLoader.test.ts`：5000 项连续 13 次选择、内容变更、失效版本、旧版接口、CUE 身份及被替代的请求。
- `lyricContentInvalidation.test.ts`：执行当前 Vue computed/watch 和桌面歌词发布函数，验证元数据更新零解析、零重居中、零全文发送；真实 Electron 歌词行为测试另行覆盖视图切换与重建。
- `nativeQueuePreparation.test.ts`：授权降级峰值并发 16，并停止派发被替代的请求。
- `fileAnalysisManager.test.ts`：1050 个失败文件验证 1024 上限、过期清理和成功后删除。

主要命令：`pnpm run test:audio-manager`、`pnpm run test:playback-routing`、`pnpm run test:lyrics-management`、`pnpm run test:audio-toolchain`、`pnpm run configure:audio-engine:mingw`、`pnpm run build:audio-engine:mingw`、`pnpm run test:audio-engine:mingw`、`pnpm run lint`、`pnpm run build`。部分测试交叉覆盖，不将各套件数量相加当作独立用例总数。
