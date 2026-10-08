# 第三轮播放器审计与修复证据

对应[审计报告](D:/Project/Twilight_Echo/docs/player-performance-audit-round3-2026-10-05.md)和[修复报告](D:/Project/Twilight_Echo/docs/player-performance-fixes-round3-2026-10-05.md)。修复前记录来自 `6dc31708`；修复后记录来自当前工作区。测试使用临时文件、独立 Electron / Chromium profile，没有读取或修改用户音乐、应用配置与历史。

## 修复前证据

原始数据保持不变。`renderer-probe.mjs` 和 `native-probe.cpp` 含确认旧缺陷的断言，不能用它们在修复后的源码上验收修复。

| 文件 | 内容 |
| --- | --- |
| `renderer-probe.mjs` / `renderer-results.jsonl` | 旧定时器、真实 Vue / App 保存器、基线源码提取的队列 patch、BPM 双路径回写。磁盘 / IPC、分析和缓存用桩。 |
| `native-probe.cpp` / `native-results*.jsonl` | 两轮 36 项 PCM 转 DSD 矩阵、首次打包扩容、真实 libebur128 allocator；第一轮另含两个旧声道布局差异记录。 |
| `convolver-control-probe.cpp` / `convolver-control-results.jsonl` | 8 秒 IR，4 项格式，各 5 次无关 EQ 配置及同格式 prepare。内置 WAV reader，未启用 FFmpeg。 |
| `browser-probe.cjs` / `browser-results*.json` | 两次独立 Electron profile，真实 localStorage，5 种历史形状各 3 次。 |
| `queue-results.json` / `queue-benchmark.log` | 真实队列函数基准，5k/20k/60k，每项 5 次，未含完整 DOM。 |

基线阶段另运行了 61 项 Node 专项和 7 项原生 CTest，全部通过；当时尚未覆盖这里新增的缺陷。

## 修复后证据

| 文件 | 内容 |
| --- | --- |
| `renderer-after-probe.mjs` / `renderer-after.jsonl` | 首次脏标记计时、真实 Store + App 共用调度、5000 项快速选择、BPM 双路径幂等。磁盘 / IPC 和分析算法用桩。 |
| `native-after-probe.cpp` / `native-after.jsonl` | 同一 36 项矩阵；指针打包与正确紧凑布局差异为 0；真实响度表 600 秒加速样本 allocator 计数。 |
| `convolver-control-probe.cpp` / `convolver-after.jsonl` | 相同卷积探针在当前实现的结果。 |
| `renderer-regressions-after.log` | 61 项回归，含 `listeningStatsDatabase.test.ts` 的真实 Chromium 增量保存 / 迁移 / abort / 备份回滚 / 退出等待、曲库重载后的 BPM 回填，包含 10k × 8 天存储层测量。 |
| `toolchain-regressions-after.log` | 54 项工具链回归，包含 CTest 登记与 Release 断言开启检查。 |
| `ctest-after.log` | 最终原生构建完整 CTest：39 通过、1 ASIO 跨 DLL 环境跳过、0 失败。 |
| `build-after.log` | Node / Web 类型检查、生产构建和原有体积门禁。 |

环境：AMD Ryzen 9 7845HX / Windows，Node v24.21.0，Electron 43.5.0，MinGW GCC 16.2.0，libebur128 1.2.6。原生 `-O3`。矩阵 p99 为 512 次组件调用分位；按 PCM 帧 / 输入采样率计算期限，`transport` 说明输出帧换算。超期是组件时间，未代表物理声卡 underrun。

## 在当前源码复现

工作目录 `D:\Project\Twilight_Echo`。编译器和库路径对应本机既有依赖；其他机器需要替换实际路径。命令生成临时探针可执行文件和独立浏览器 profile。

```powershell
node --experimental-strip-types --import ./scripts/register-renderer-aliases.mjs docs/performance-audit-evidence/2026-10-05-round3/renderer-after-probe.mjs
pnpm test:player-performance

$fixNativeExe = Join-Path $env:TEMP 'twilight-fix3-native.exe'
$fixLibraryRoot = 'D:/TwilightEchoDependencies/builds/audio-engine-mingw/vcpkg_installed/x64-mingw-static'
& 'D:/TwilightEchoDependencies/w64devkit/bin/g++.exe' -O3 -std=c++20 -DTAE_HAS_EBUR128=1 -I audio-engine -I "$fixLibraryRoot/include" docs/performance-audit-evidence/2026-10-05-round3/native-after-probe.cpp audio-engine/core/AudioTypes.cpp audio-engine/dsp/PcmToDsdModulator.cpp audio-engine/dsp/DspWorkspaceProcessors.cpp "$fixLibraryRoot/lib/libebur128.a" '-Wl,--wrap=malloc,--wrap=calloc,--wrap=free' -o $fixNativeExe
if ($LASTEXITCODE -ne 0) { throw 'Native compilation failed' }
& $fixNativeExe
if ($LASTEXITCODE -ne 0) { throw 'Native probe failed' }

$fixConvolverExe = Join-Path $env:TEMP 'twilight-fix3-convolver-control.exe'
& 'D:/TwilightEchoDependencies/w64devkit/bin/g++.exe' -O3 -std=c++20 -I audio-engine docs/performance-audit-evidence/2026-10-05-round3/convolver-control-probe.cpp audio-engine/dsp/ConvolverProcessor.cpp audio-engine/dsp/KissFftAdapter.cpp -o $fixConvolverExe
if ($LASTEXITCODE -ne 0) { throw 'Convolver compilation failed' }
& $fixConvolverExe $env:TEMP
if ($LASTEXITCODE -ne 0) { throw 'Convolver probe failed' }
```

实际引擎构建使用项目 wrapper 和它准备的工具链环境；避免直接 Ninja 自动重新配置时改变 vcpkg ABI / patch 工具识别：

```powershell
$env:TAE_MINGW_BUILD_DIR = 'D:\TwilightEchoDependencies\builds\audio-engine-mingw'
$env:VCPKG_ROOT = 'D:\TwilightEchoDependencies\vcpkg'
$env:W64DEVKIT_ROOT = 'D:\TwilightEchoDependencies\w64devkit'
$env:TAE_MINGW_BUILD_JOBS = '8'
node scripts/run-audio-engine-mingw.cjs build
if ($LASTEXITCODE -ne 0) { throw 'Engine build failed' }
ctest --test-dir $env:TAE_MINGW_BUILD_DIR --output-on-failure
pnpm build
```

补充专项曾运行以下 7 个文件，106 项通过，其中会话用例与 `test:player-performance` 重叠：

```powershell
node --experimental-strip-types --test --import ./scripts/register-renderer-aliases.mjs src/renderer/src/stores/usePlayerStore.test.ts src/renderer/src/stores/useMusicStoreMetadataEnrichment.test.ts src/renderer/src/app/usePlaybackSessionPersistence.test.ts src/renderer/src/components/ListeningAnalyticsPage.behavior.test.ts src/renderer/src/components/UxFeatures.behavior.test.ts src/main/persistence/personalBackup.test.ts src/renderer/src/utils/playerSessionTrack.test.ts
node --test scripts/audio-engine-toolchain.test.cjs
```

浏览器存储 checkpoint 是异步等待总耗时，不能直接等同 UI 阻塞；首次迁移仍有一次性成本。探针和源码断言覆盖本文描述的范围，没有进行真实声卡长时间播放或完整应用 GPU / RSS 采样。
