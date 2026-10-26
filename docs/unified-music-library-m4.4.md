# M4.4：Focus 查询、保存与冻结播放

2026-10-24。接续 M4.3，在原“全部歌曲”页加入独立折叠的 **Focus**。本批功能开发已接线；人工内容、真实桌面、视觉／键盘／主题和打包验收仍按用户安排后置。

## 从全部歌曲页组合条件

展开 Focus 后，选择录音或具体发行，再添加“全部满足／任一满足／不满足”的条件。可组合流派及子类、来源和音频规格、个人／资料／有效评分、标签、具体发行年／项目首发年、收藏／禁播、播放历史、现有分类维度和名称搜索。

- 默认查询音乐库；“已缓存目录”只查本机目录缓存，不发全网搜索。该范围在界面中不提供集合播放。
- 流派、标签和实际 provider ID 可分页选择，不要求手写 JSON 或先加载完整曲库。
- 结果和分面每页 20 条，保存查询每页 20 条；公共接口最多 200 条。分面标明“当前结果中的数量”，保留全部当前条件。
- 保存查询支持创建、改名、更新条件和确认删除；每次打开重新求值。名称和条件分别 CAS，冲突保留草稿及原操作意图，不自动覆盖。
- 空库仍能打开 Focus、查看和管理已保存查询；不依赖资料补全开关或平台登录。原歌曲列表、字符串 genre 筛选和普通歌单重复项保持原用途。

## 列表、计数、分面和播放使用同一查询

版本化 AST 在现有 SQLite 中编译为参数化 SQL：`all/any/not`，深度最多 8、叶子最多 64、稳定实体 ID 兜底排序，NULL 排后。缺值不满足数值比较；`not` 是当前 scope 的集合补集，所以“不是四星以上”包含未评分。

同一个 source 叶的 provider、格式、位深和采样率必须命中同一来源行；不同来源要求用多个显式叶表达。播放只使用该布尔查询保留下来的来源范围，显式的自动禁播排除仍约束最终来源，不能借另一个未禁播来源放行已禁播的本地文件。

录音／发行仅按当前同类型已确认身份分组，未确认时保留物理实体；人工播放版本不合并录音身份或个人值。评分以个人半星值比较；当前没有获准的外部评分供应商，base 为缺失，effective 使用适用的个人分，不从音质、热度或匹配置信度造分。现有分类事实仍受账号、使用范围和过期条件约束。

token 冻结查询身份、`asOf`、上下文和资料到期时间，以及保存查询、目录、内容、流派、资料、评分、偏好、标签、身份关联及历史共十类 revision。后续页、分面和播放使用原 token；依赖变化时撤下旧结果和计数，保留条件并要求显式刷新。Core 在 worker 回复后还会检查账号切换、资料到期和已观察到的新修订，拒绝迟到的旧结果。

### 播放历史不按歌曲名猜来源

继续使用现有 Core 统计定义，按实际记录的 Track／sourceIds 投影，并在已确认身份内取最大时间。最近 N 天按冻结 `asOf` 的 N×24 小时计算，包含“无播放记录”，不称为从未听过。

旧原始 Track ID 索引保留原排序含义；另外投影 `focus-source-v1` 的 provider＋原来源 ID 键，Focus 只读取这类精确键。两个平台同时使用原 ID `42` 不再串历史；旧 Windows 路径缺省 source 仍按目录规则识别为本地，记录中的 provider 大小写和首尾空白也统一规范化。启动由原 Core 历史投影完成水合；投影失败时查询明确等待，不使用空历史冒充权威结果。

## 分批生成原播放队列

Core 在首次异步读取前进入原 `fromPages`，先保留播放意图；每批最多 100 首直接流入现有隐藏 SQLite 队列 builder。逐页、准备结束及采用前核对完整 token，取消、空集、缺锚点、授权不足或来源准备失败都不替换旧队列。

集合按当前已确认录音身份去重；未指定来源时沿明确首选、首次实际入库时间和稳定 ID 选择，不默认偏爱本地。发行内部保持碟号／轨号顺序。公开行仍显示自身实际来源；点击“从此项播放”时，每个私有播放页都携带同一个 `anchorSourceId`，只在原匹配范围内优先该精确来源。这修复了多张发行共享录音时，行可播放但锚点被全局去重淘汰的问题，不改变录音总数，也不把行的 provider 偷换成另一张发行的来源。

新队列项冻结为 `sourceSelection: explicit`，不通过旧标题／艺人恢复逻辑跳到集合外。采用后改标签、评分或资料不会重排已发布队列；平台播放 URL 仍由原 Session 按需准备，不为构建集合预取全库链接。

### 用请求 ID 查询是否已提交

Focus 在提交前生成已知 requestId，作为原 Core 命令 envelope 的 ID。取消或回复未知后，调用只读 `focus.play.status`，不会再次发送播放命令：

- pending：仍在准备，继续禁止重复提交；
- not_committed：本次请求没有替换原队列；
- committed：原 Session 已采用该队列，并分别报告原生播放确认中、已确认或调用失败。调用失败包括回复丢失，界面提示查看当前播放状态，不断言从未开始播放；
- unknown：当前 Core 没有可核对回执，才提供人工核对路径。

回执按实际客户端身份、Core epoch 和 requestId 隔离，最多保留 1024 项，不淘汰进行中的请求。回执在本次 Core 内存中保存；重启、记录被淘汰或身份不匹配时返回 unknown，界面保留原 epoch／ID，不将未知结果解释为未提交。取消后的晚成功和旧 epoch 的晚对账不会覆盖当前界面。

## 生产接线和 schema 26

共享 DTO／校验／权限、数据库 worker／client、Core application／生产入口、快照修订和实际 Vue 调用者已接通。

- 查询和保存列表需 `library:read`，保存查询写入需 `library:write`。
- 播放需 `playback:write`＋`library:read`；实际解析平台来源时才额外检查 `providers:call`。播放回执查询需 `playback:read`＋`library:read`，不能查询别人的请求。
- 公共结果只含当前页与汇总，不暴露 Track、路径、原始来源键、账号上下文或播放 URL。私有 `anchorSourceId` 不能提交给公开 query／facets。
- schema 25→26 只增加默认 Profile 的保存查询及状态两张表，名称和条件各有修订。沿原 WAL 一致快照／事务升级，保留标签、评分、收藏、迁移收据及普通歌单 occurrence；失败回滚，当前版本缺对象时拒绝继续。
- SQLite 一致备份包含保存查询；完整 music 域的便携导出／恢复仍归 M5.2，原 v1 歌单备份不含这些新个人整理数据。

实现入口：[Focus 仓库](D:/Project/Twilight_Echo/src/main/library/libraryDatabaseFocus.ts)、[Core 服务](D:/Project/Twilight_Echo/src/core/library/focusService.ts)、[原页面面板](D:/Project/Twilight_Echo/src/renderer/src/components/music-focus/MusicFocusPanel.vue)。测试已注册原 `test:core`／`test:library-database`。

## 自动化证据与剩余交付

下列日志有重叠，不合计为一次完整套件。失败的 fixture 期望已修正，受影响项定向复验，其余复用同候选有效结果。

| 范围 | 有效证据 |
|---|---|
| 仓库 | 原 17 项分别见 [初轮](D:/Project/Twilight_Echo/tmp/m4.4-focus-repository-tests.log)、[fixture 修正](D:/Project/Twilight_Echo/tmp/m4.4-focus-repository-token-fixed.log)、[历史／genre](D:/Project/Twilight_Echo/tmp/m4.4-focus-history-genre-regression.log)、[source＋ban](D:/Project/Twilight_Echo/tmp/m4.4-focus-source-ban.log)、[身份](D:/Project/Twilight_Echo/tmp/m4.4-focus-identity-fixed.log)、[年份／顺序](D:/Project/Twilight_Echo/tmp/m4.4-focus-year-album-order.log)和[最终查询物化](D:/Project/Twilight_Echo/tmp/m4.4-focus-query-materialization.log)；新增精确发行锚点 [3/3](D:/Project/Twilight_Echo/tmp/m4.4-focus-anchor-fixed.log)。原 genre 默认语义 4 项同时通过 |
| Core／协议／Session／桥接 | [13/13](D:/Project/Twilight_Echo/tmp/m4.4-focus-reconciliation.log)，含权限、意图、分页、逐修订检查、原生前采用回执和不重放；读侧最终修订检查 [1 项通过](D:/Project/Twilight_Echo/tmp/m4.4-focus-read-history-final.log)，锚点逐页传递 [2/2](D:/Project/Twilight_Echo/tmp/m4.4-focus-anchor-production.log)之一 |
| 新 schema | [2/2](D:/Project/Twilight_Echo/tmp/m4.4-focus-schema.log)：WAL 备份、重启、原数据、回滚及不完整 schema 拒绝 |
| 原迁移及历史／连接回归 | 原迁移选择 [22/22](D:/Project/Twilight_Echo/tmp/m4.4-focus-prior-schema.log)；[历史／连接／tags 迁移](D:/Project/Twilight_Echo/tmp/m4.4-focus-history-regressions.log)中 36 项通过，唯一内部索引 fixture 补齐 qualified 键后 [2/2](D:/Project/Twilight_Echo/tmp/m4.4-focus-history-fixture-final.log)，保留原 sourceIds 含义 |
| 真实 worker | [1 项通过](D:/Project/Twilight_Echo/tmp/m4.4-focus-anchor-production.log)：所有 Focus 数据库操作、完整修订事件、精确历史失效、私有锚点、worker 替换和保存查询重开 |
| Renderer | 32 个不同案例有效：状态 19、实际编译控件 13；基础 [状态](D:/Project/Twilight_Echo/tmp/m4.4-focus-ui-state.log)／[控件](D:/Project/Twilight_Echo/tmp/m4.4-focus-ui-controls.log)，生命周期／来源／保存增量以及最终请求对账 [状态 7/7](D:/Project/Twilight_Echo/tmp/m4.4-focus-ui-receipt-state.log)／[控件 3/3](D:/Project/Twilight_Echo/tmp/m4.4-focus-ui-receipt-controls.log)、未确认播放文案 [1/1](D:/Project/Twilight_Echo/tmp/m4.4-focus-ui-unconfirmed-copy.log) |
| 类型与 lint | [Node 类型](D:/Project/Twilight_Echo/tmp/m4.4-focus-node-final.log)、[Root lint](D:/Project/Twilight_Echo/tmp/m4.4-focus-root-lint.log)、[仓库 lint](D:/Project/Twilight_Echo/tmp/m4.4-focus-anchor-lint.log)及 [UI lint](D:/Project/Twilight_Echo/tmp/m4.4-focus-ui-receipt-lint.log)通过；[Web](D:/Project/Twilight_Echo/tmp/m4.4-focus-ui-receipt-types.log)仍只有 `DspSignalOverview.vue` 既存 14 项诊断，无 Focus 诊断 |

本批没有运行生产构建、真实 Electron／Windows 包、人工内容／视觉／键盘／主题、200 条内容样本或十万条性能验收。原 sandbox `CreateWindowStationW ACCESS_DENIED` 依赖未变，未重复失败操作或关闭 sandbox。音乐库域负责人在后续验收恢复这些原入口；全局 DSP 类型问题留在 DSP 域。

下一开发包为 **M5.1：按实际角色的人物参与查询，以及作品／演绎／录音探索**，再推进完整 music 备份恢复、全库性能核对和实际发布。M4 功能批次已接通，整体验收与 M1—M5 交付仍未完成。
