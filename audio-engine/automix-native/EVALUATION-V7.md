# AutoMix .7：分轨器开关与计算设备选择

在现有 .6 AutoMix 和局部分轨交接逻辑上增加实际设备检测、分轨增强开关、自动 / GPU / CPU 选择和重新检测。默认保留既有分轨偏好，新设备偏好默认自动；全新配置的 AutoMix 主模式仍为关闭，人工验收门控不变。

## 检测和执行

播放器检测同目录 `automix-enhancement`，也支持同格式的 `automix-enhancement-gpu` / `automix-enhancement-cpu`。开发目录及显式 `TWILIGHT_AUTOMIX_STEM_PACK` 路径同样支持。多个目录中损坏的包不会遮住可用的包。目录存在不是就绪证明：检测固定模型版本和文件，再通过包内 Python 验证模型摘要、数值运行库、CPU 重采样及 CUDA 张量运算，返回 GPU 名称。

主进程持有检测结果，UI 和准备流程复用同一次检测。包文件变化使检测缓存失效；重新检测可刷新驱动 / 设备能力。单次 Python 探测限制 20 秒，隐藏运行、不加载 Demucs 模型。播放器打包自己的 `probe.py`、`worker.py` 和 `arrangement.py`，增强包 2.2 无需重制。

设备选择实际传给分轨工作进程。CPU 不查询 CUDA 可用性；自动优先 GPU，CUDA 显存不足时转 CPU；强制 GPU 不可用或显存不足时拒绝增强，由既有协调器准备基础 AutoMix。完整原始声部缓存仍在导入 Torch 前复用，与计算设备偏好无关。支持固定 Demucs 4.0.1、Python 3.11 和 Torch 2.8.0 的 cu128 / cpu / 无后缀发行版本；实机使用已验证 2.2 cu128 包。

启停或设备改变先更新主进程偏好，再取消旧的分析、分轨与待提交计划，防止重新观察时读到旧偏好。缺包或已保存设备暂不可用时保留偏好，UI 显示有效能力，不把强制 GPU 静默改成 CPU。

## 本轮验证

- `pnpm run test:automix`：39 通过，包括真实 Vue 组件在隐藏 Electron 中的开关、设备选择、缺包、CPU-only、GPU 名称、设置重新打开及保存失败恢复。
- `pnpm run test:audio-manager`：445 通过。
- IPC 公共契约：5 通过，新增能力读取通道及对应基线。
- 设备策略 Python 回归：6 通过；分轨编排 Python 回归：12 通过。
- 相关 ESLint、类型检查、人工验收构建和 renderer 资源预算通过。
- RTX 5070 Laptop 实测 `pair-25` 的真实源绑定材料：强制 GPU 无缓存推理 6.12 秒，强制 CPU 无缓存推理 13.61 秒；自动 / GPU / CPU 三种策略的完整缓存均不导入 Torch、不初始化 CUDA。
- 隐藏 CUDA 设备后，强制 GPU 返回 `gpu_unavailable`；限制 CUDA 分配预算后，强制 GPU 返回 `gpu_memory_exhausted`，自动模式实际转 CPU 完成，13.53 秒。失败路径不生成已完成混音材料。这些耗时仅对应该短交接样本。
- 打包后的真实主进程 / preload / renderer / 原生服务，在缺包、同目录 GPU+CPU 包、同目录 CPU-only 能力三种场景中分别验证初次启动与设置恢复。目录测试通过 NTFS junction 指向已有 2.2 包，测试后移除 junction，没有复制增强包。
- 包中三个 Python 文件摘要与源文件一致；原生 PE 架构、符号裁剪和依赖闭合检查通过。基础图资源不变。

隐藏 Electron 验证工具已修正 `process.resourcesPath` 的设置：该属性只读但可重新定义，原来直接赋值没有生效。现在实际指向打包目录，并对预期 missing / cpu / gpu 能力作明确断言。

本轮改进控制流程，未修改基础智能过渡编排算法，未宣称覆盖率增长。沿用 .6 的基础 36 对记录：Natural 26 / 36，DJ 34 / 36，DJ ≥16 秒 22 / 36。本轮没有重复整个音频样本评估或原生 CTest；本轮实机验证覆盖新设备策略、目录检测和设置恢复。

实现提交：`824b92f0`（检测与执行）、`92349811`（界面与偏好）。完整报告随 .7 交付说明保存。
