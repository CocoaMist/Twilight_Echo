# NEO 性能优化与瘦身（2026-10-22）

保留 NEO 独立孵化方向和现有界面。本次核对上游 `main` 仍为 `d571636e`，补入 [PR #181](https://github.com/Px-asen/Twilight_Echo/pull/181) 最新提交 `7ba8fcaa`，形成优化前基线 `6e96cbc8`。PR #175、#177 及 #181 的前两次修复此前已纳入。

## 构建体积

生产构建显式启用 esbuild 压缩，并保留函数名供诊断使用。迷你播放器按需初始化主题运行时，共同入口不再静态导入整套主题状态。字体、主题、音频和插件能力保留。

| 同机生产构建产物              |       修改前 |       修改后 |  减少 |
| ----------------------------- | -----------: | -----------: | ----: |
| Renderer 全目录               | 22,696,414 B | 18,506,486 B | 18.5% |
| 主进程 JavaScript             |  2,935,155 B |  1,788,148 B | 39.1% |
| 共同入口及静态依赖 JavaScript |    922,108 B |    225,683 B | 75.5% |

前两项合计少 5,336,935 B；入口一项包含在 Renderer 中，不能重复相加。这里是未打包输出体积，不是安装包大小或启动时间。压缩后的 preload 为 62,602 B。

共同入口静态依赖由 5 个 chunk 降为 3 个，已不含 media-providers/playback-session。主题在迷你播放器挂载前仍完成初始化。

打包规则另外排除 Renderer 中重复的远控、分轨资源，并排除内置插件测试文件，共少复制 225,313 B 原始文件。使用 electron-builder 自身 FileMatcher 核实：远控 HTML/CSS/JS、三个分轨 Python 脚本、两个插件的入口和清单仍在各自 extraResources 中；可视化 iframe 仍保留。未生成新安装包。

Renderer 限制收紧为单个 JS chunk 512 KiB、所有构建 JS chunk 合计 4.5 MiB，并补充“小块拆分仍不能绕过总预算”的检查。

## 运行热点

主题装饰原本对任何新增 DOM 都重新扫描整页。现在只扫描新增子树，同批父子插入合并，跳过已脱离文档的节点，卸载后不再执行。真实 Chromium 中，在已有 5,000 个节点的页面连续插入 100 批内容：整页扫描 **100 → 0 次**。嵌套、重挂载、滚动、跨文档及待执行任务清理均通过行为检查。该夹具耗时约 40.9 → 0.8 ms，只作为局部测量。

音乐库集合与统一搜索复用 `Intl.Collator('zh')`，保持原有中文比较规则、数字与大小写规则及相同名称的排序。在 20,000 条合成记录、2 次预热、9 轮同进程交替对照中，集合重建中位数 **500.98 → 382.90 ms（约少 23.6%）**，完整输出顺序一致。搜索排序只降低约 2.1%，不据此宣称显著收益。

设置页保留常驻组件和草稿，诊断、连接、曲库状态仅在所属分类及文档可见时查询。进入立即刷新，离开、隐藏、卸载清理定时器；迟到响应不能覆盖新状态或重启旧循环。真实 Vue 生命周期与虚拟时间对照：常规分类停留 60 秒、Discord 开启时，三个隐藏分类的库/诊断/Discord/远控查询由 **13/7/8/1 次降为 0/0/0/0 次**。

## 验证与边界

- Node 24.13.1、ICU 78.2、Electron 43.7.0、Windows x64。
- 类型检查、生产构建、收紧后的体积限制、修改文件 ESLint 通过。
- 主题装饰、主题工作坊、分层像素采样检查 32/32 通过；排序相关测试 33/33 通过；设置轮询及原 Afterglow 相关检查 18/18 通过。
- 迷你播放器、桌面歌词、灵动岛及同步检查 46/46 通过；公共回归检查 60/60 通过；构建、测试归属及发布策略检查 33/33 通过，收紧预算后的预算及归属检查 16/16 通过。
- 额外设置及本地库等回归 99 项：95 通过、2 失败、2 跳过。失败分别为快速设置夹具未导出 `syncExtensions`、分类滚动位置断言；两者均在优化前 `6e96cbc8` 的独立副本复现，未降低或移除断言。
- 未测量端到端启动时间、真实内存、物理音频设备及投送设备。本记录不代表完整产品套件全部通过。

数据及版本信息见 [JSON 证据](audit-evidence/neo-performance-2026-10-22.json)。本地详细日志和基准脚本保存在 `.local/neo-perf-20261022/`。

可重复的常规检查：

```text
corepack pnpm run build
corepack pnpm run test:theme-workshop
corepack pnpm run test:cross-cutting-regressions
node --experimental-strip-types --test --import ./scripts/register-renderer-aliases.mjs src/renderer/src/stores/library/derivedCollections.test.ts src/renderer/src/utils/unifiedSearchSources.test.ts
```
