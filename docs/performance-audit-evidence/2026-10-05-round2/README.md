# 第二轮播放器性能审计证据

对应 [审计报告](D:/Project/Twilight_Echo/docs/player-performance-audit-round2-2026-10-05.md)。生产源码未修改，测试只生成临时文件。

- `native-audit.cpp`：直接链接当前卷积、FFT、队列组件，生成临时 IR。
- `native-results.jsonl`、`native-results-repeat.jsonl`：两轮独立原生结果，每轮 24 条记录。
- `renderer-audit.mjs`：真实函数与 Vue computed/watch 源码复现，包含分析失败记录检查。
- `renderer-results.jsonl`：7 条 JS 结果。授权、解码结果、视口和 IPC 接收端使用桩，见报告中的计时边界。

## PowerShell 复现

工作目录为 `D:\Project\Twilight_Echo`；使用项目已安装的 Node、Vue、esbuild、xmldom 和当前 MinGW 工具链。将可执行文件与 WAV 保存在临时目录，不写入音乐库或应用配置。

```powershell
$auditOutputPath = Join-Path ([System.IO.Path]::GetTempPath()) 'twilight-player-audit2-repro'
New-Item -ItemType Directory -Path $auditOutputPath -Force | Out-Null
$auditExecutablePath = Join-Path $auditOutputPath 'native-audit.exe'
& D:\TwilightEchoDependencies\w64devkit\bin\g++.exe -O2 -std=c++20 -I audio-engine docs/performance-audit-evidence/2026-10-05-round2/native-audit.cpp audio-engine/dsp/ConvolverProcessor.cpp audio-engine/dsp/FftSpectrumAnalyzer.cpp audio-engine/dsp/KissFftAdapter.cpp audio-engine/playlist/QueueManager.cpp -o $auditExecutablePath
if ($LASTEXITCODE -ne 0) { throw 'Native audit compilation failed' }
& $auditExecutablePath $auditOutputPath
if ($LASTEXITCODE -ne 0) { throw 'Native audit failed' }
node --experimental-strip-types --import ./scripts/register-renderer-aliases.mjs docs/performance-audit-evidence/2026-10-05-round2/renderer-audit.mjs D:/Project/Twilight_Echo
if ($LASTEXITCODE -ne 0) { throw 'Renderer audit failed' }
```

原生 IR 无 FFmpeg 解码，测量的是处理组件。每个组合使用匹配采样率的单声道 float32 WAV，首样本为 1，后续为确定的低幅衰减信号；内部复制到输出声道。输入样本在每次测量前重置，生成文件与加载 IR 不在 `process` 计时范围内。

Node 可能输出项目现有 `MODULE_TYPELESS_PACKAGE_JSON` 提示，不影响复现。JS 测试在独立临时目录创建 256 个小文件，注入时钟验证冷却过期；没有等待 10 分钟，也没有解码这些占位文件。

计时受 CPU 电源、温度和系统调度影响；对稳定性结论应看两轮配置、超期次数与计数逻辑，不能只比较某次峰值。当前 20,000 项 native 结果仅为组件扩展性探测，公开 IPC 上限是 5000，renderer 超限正确降级。
