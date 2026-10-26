# M5.2：个人音乐备份 v2 与可复核恢复

2026-10-24。M5.2 的 v2 备份、手工资料图片、逐实体资料源首选、Rhine 出处复核与跨流派字典恢复已接线。人工内容、真实桌面／视觉／原生键盘／主题和 Windows 包验收按用户安排后置；完整交付尚未验收。下一开发阶段为 M5.3 全库对账与十万条混合记录性能。

## 在设置页选择要迁移的内容

“个人数据备份与迁移”默认导出全部项目，也可仅选择部分域。新版写 `twilight-personal-data` v2，仍读取原 v1；旧版应用不能读取 v2，回退应用使用升级前匹配快照。

- v1 的“歌单与收藏”保持原合同。v2 分为“歌单”和“收藏与音乐整理”：普通歌单仍保留顺序与重复 occurrence，系统收藏成员只由 music 域恢复。只恢复 v2 歌单不会重置本机收藏、禁播或评分。
- 恢复前显示所选域、记录重叠、缺少来源、可映射实体及离线锚点。改变恢复项目、路径映射或冲突规则后，必须点击“更新预览”再确认。身份引用歧义、标签／Focus 名称冲突和合并后流派环先处理，再安排恢复。
- 音频、登录凭据、插件、自动 HTTP 缓存、后台任务及受限正文／图片不随备份迁移。现有内联 `data:image` 图片可保留，缓存句柄、会话图片 URL 和封面来源字段不作为可移植资源导出。
- 总容量仍为 180 MiB，music 使用其他域之外的剩余预算；记录上限和字节上限明确校验，超限报错，不静默裁剪个人数据。

## music 保存现有权威，不重建第二个音乐库

music 域内版本为 1，由固定逻辑记录与列组成；新增 `sourcePreferences`／`artworkOverrides` 记录可选，仍读取未含这两组记录的旧 music v1。备份文件不能指定 SQL 表名或表达式。数据来自现有 SQLite 权威，经原数据库 worker 和 Core 备份服务读写，不由 Renderer 收集曲库。

本批覆盖：

- 歌曲／具体发行个人评分及明确清除；人物、作品、录音和发行的 `none / favorite / ban`；相关审计历史。
- 唯一系统收藏视图、个人排序和恢复所需快照；标签、成员及保存的 Focus 查询。
- 人工介绍／明确清空、手工资料图片及隐藏标记、逐实体介绍资料源首选，身份确认、拒绝、解除、历史和恢复证据，来源别名与旧 ID 映射。
- Rhine 能确认来历的用户导入／人工正文、人工注记及本地／人工 credits；新写入按精确正文和历史版本保存来历。旧来历不明正文默认排除，可在设置页逐版本确认有权迁移或排除；不改变原文，也不自动重标全部旧历史。
- 人物／作品最小引用锚点、人工演绎及有序录音关系。
- 流派节点、层级、别名、覆盖、迁移来历、字典版本，以及首次实际入库时间的来源引用。

原 `versions` 域继续拥有播放版本、版本族和首选音源关系；music 不另造一套首选版本。自动事实、图片缓存和运行中任务继续可重建，不成为个人值的依赖。

## 在资料页保存自己的图片和介绍来源

人物、专辑作品及具体发行的资料页可添加／替换 PNG、JPEG 或 WebP 图片，每张原始文件不超过 2 MiB，最长边 8192、总像素不超过 32 Mi。用户字节与外部 artwork 分开建模，以有界 data URL 存 SQLite，不依赖外部 ID、账号或会话图片授权；隐藏会同时隐藏手工与自动图片，恢复自动图片会移除个人覆盖，不发起联网请求。图片随 music 导出并计入 180 MiB 总预算，超限整次失败，不裁剪图片。

“介绍资料源”仅选择此实体已有且当前获准使用的正文，不改变播放音源、身份关联或全局联网策略。首选不可用时保留选择并回退其他可用资料；手写介绍、明确隐藏及人工导入优先。保存图片或首选无需启用在线资料；仍需原 `library:write`，按条目 revision 保存。结果未知时保留草稿，重新读取并核对，不自动重放写入。

设置页“复核旧正文出处”沿原资料扩展入口读取有界清单，当前正文和各个历史版本分别确认。两万字以上先展开全文；确认绑定当前文档 revision 和精确正文。新人工替换不继承旧平台署名，明确外部 AI 导入则保留其原引用。人工清除也随备份恢复，不被自动正文重新填回。来历未确认或明确排除的旧正文不会导出；恢复后的未知旧历史继续保持未确认，不因修订号变化被误记为人工。原库及升级快照仍保留原始内容。复核需启用原资料扩展。

便携恢复完成全部正文、来历和绑定写入后，在同一事务内复用旧资料权威的冲突重算。备份中的人工清空与本机另一旧 ID 的非空正文指向同一实体时，两侧均显示冲突，不任取一条，也不回退已有自动介绍。

schema 28 新增个人图片、资料首选与 Rhine 字段来历权威；升级前沿原机制保存一致 SQLite 快照，失败回滚 DDL。新表变化进入现有 metadata revision，备份预览与启动恢复 CAS 不会漏掉这些修改。

## 跨字典恢复按稳定 ID 选择，不按流派名称猜测

恢复不改本机当前内置 `dictionaryVersion`。已有未修改内置节点的名称和父级保持本机定义；备份新增节点按原稳定 ID、父级和原节点字典版本保存。用户修改仍按 `keep-local / use-backup` 选择，别名和个人覆盖保留准确节点引用。预览明确提示字典版本不同。

字典版本与别名标准化版本分别处理：当前支持标准化版本 1，未知标准化版本在预览与应用时阻止恢复，不能静默导入失效映射。缺父节点或备份自身成环属于无效文件；与本机合并才出现的环在预览中列出，直接恢复同样拒绝并回滚。

## 明确引用才能接回来源

恢复使用同库 origin、既存导入映射、准确来源键和类型化外部引用。标题、歌手名字或相同 Track ID 不单独证明同一来源。跨机映射结果可在后续导出／恢复中延续。

来源不存在时保留离线实体、个人值及原引用，不生成真实 `catalog_sources`、库成员或文件授权。离线收藏不会借导入快照中的路径或同名 Track ID 获得播放能力；真实来源明确回归后才接回现有来源，并通过原 preferences 事件让 Core 重读收藏视图，无需重启。旧回绑凭据和仅流派回绑不产生无效收藏更新。

M5.3 的跨域对账发现并修复了一处实际合同缺口：原默认收藏可以保留迁移前的重复 occurrence，但 v2 校验、恢复及来源回归曾拒绝或去重。现在导出、在线恢复、离线恢复、再次导出及精确来源回归均保留原顺序与重复；明确 `none` 仍隐藏该录音的全部可见 occurrence。本地回归快照从原 `tracks` 权威读取，不把不含路径的公开目录载荷当作完整 Track。跨平台 Track ID 碰撞时保留独立离线项和原引用，不覆盖另一来源快照或误播同 ID 本地曲目。新增反例与旧恢复／worker 事件消费见 [本批回归日志](D:/Project/Twilight_Echo/tmp/m5.3-root-consumption-final.log)；完整 music-only 恢复也已由 [对账用例](D:/Project/Twilight_Echo/tmp/m5.3-reconciliation-tests-final.log)消费。

路径映射只改引用，不移动音频。未带 library 域的 music 备份从明确本地来源推导目录，最多展示 100 个根；未列出或未映射的引用仍保留离线。Windows 盘符／UNC 与 POSIX 路径分别遵守其大小写含义。无法唯一映射的身份先列出冲突，不能由“使用备份”任取一个本机对象。

`keep-local / use-backup` 对稳定目标选择个人字段；明确空值、拒绝和解除也是状态。标签成员和人工演绎按各自完整集合选择，不能把“使用备份”实现成只增不删的并集。

## 同库事务与跨文件恢复各自负责

library、music 和 playlists 在同一 SQLite 事务发布，恢复前沿原一致性快照保存数据库。固定 `restoreId` 的完成 receipt 与数据同事务；收到结果未知的重试先检查 receipt，再检查 revision，不覆盖恢复后新改的评分或重复追加历史。跨机历史保留事件身份以去重。

CoreState、版本和其他文件继续沿原 redo／启动恢复流程发布，不宣称跨文件原子。恢复在启动期间、业务 owner 构建前执行。预览、暂存和应用均核对音乐库及个人域 revision；暂存到重启之间没有新增全局写锁。

若重启时发现 revision 已改变且 SQLite bundle 尚未提交，先将完整备份保存为 `personal-restore-needs-review.json`，再撤下活动恢复日志，正常启动。设置页显示“查看待复核恢复”，重新预览后由用户确认。只有 `STALE_REVISION` 走此分支；已提交但回执丢失的 bundle 按原 restoreId 继续 redo。

## 主链路检查（尾项接入前）

本批沿原 `test:core`／`test:library-database` 注册新用例，证据保存在 [tmp](D:/Project/Twilight_Echo/tmp)。日志有重叠，不将轮次相加：

- 仓库 20 个用例由 `m5.2-music-repository-final.log` 的原 17 项和 `m5.2-music-repository-edges.log` 的新增／变更 5 项覆盖。包含实际字段往返、明确空值、同名隔离、完整集合替换、流派环、事务回滚、历史序号转接与真实 SourceResolver 的离线不可播放检查。
- 收尾 5 项通过：`m5.2-music-consumption.log`，其中 4 项更新上述仓库证据，1 项新增真实 worker 的收藏回绑事件消费。预览两侧均按相同可备份逻辑记录计数，包含锚点、关联、历史及离线引用，不把备份总记录与本机六类个人对象混比；计数不生成当前备份大文档。
- Core 便携层及格式最终 17 项通过：`m5.2-portable-owner-final.log`。原 JSON 7 项、原数据库兼容 17 项分别复用 `m5.2-portable-stable.log` 对应部分和 `m5.2-portable-database-compat.log`。
- 原 Core 分发、协议及真实数据库 worker／重启 4 项通过：`m5.2-root-gateway-worker-final.log`。备份界面脚本行为及旧 IPC 10 项通过：`m5.2-root-backup-controls-final.log`；这些行为测试不算实际视觉验收。
- 当时 Node 类型检查通过：`m5.2-node-consumption-final.log`；各 owner 相关 lint 通过，界面最后修改另见 `m5.2-backup-controls-lint-final.log`、`m5.2-backup-copy-lint-final.log`。当时 Web 仅并行 DSP 一项错误，见 `m5.2-root-web-final.log`；当前工作区类型门槛见下节。

生产构建、真实页面／原生键盘／主题、人工 200 条内容样本、十万条正式性能与 Windows 包验收未运行，仍按用户安排后置。原 Electron sandbox 窗口站创建权限依赖保留，不以关闭 sandbox 绕过。

## 收尾检查与下一步

- `m5.2-tail-backup-final.log`：新增图片／首选／跨字典 5 项与原音乐备份 20 项通过，含往返、明确空值、旧 music v1 兼容、非法资源、不同字典版本与不支持的别名标准化。
- `m5.2-tail-schema.log`：schema 28 的新升级／回滚 2 项，以及探索、流派、资料修订迁移回归，共 11 项通过。`m5.2-tail-prior-migrations.log`：原评分、偏好、标签、Focus、路径、历史与旧扫描迁移等 17 项通过。
- `m5.2-tail-entrypoints-final.log`：原 Core 实际分发／权限、完整 2 MiB 图片的公共请求预算，以及真实 worker 传输和重启 3 项通过。
- `m5.2-tail-portable-regression.log`：原 Core 便携层及 v1／v2 格式 17 项通过。
- `m5.2-personal-metadata-final.log`：资料仓库／Core、图片格式、编辑器、资料投影与编译后控件 39 项通过。原人物资料消费者、公开图片及平台能力回归分别见 `m5.2-personal-metadata-consumers-final.log`、`m5.2-personal-metadata-consumers.log` 的 publicArtwork／platform 对应部分；后一个日志包含已另行修正的旧 schema 断言，不能视作整份日志通过。
- Rhine 领域 20 个不同用例由 `m5.2-legacy-provenance-tests.log`、`m5.2-legacy-provenance-changed.log`、`m5.2-legacy-clear-restore.log` 覆盖。便携恢复 6 项由 `m5.2-legacy-portable-provenance-final.log` 的 5 项和 `m5.2-legacy-portable-conflict.log` 的新增反例覆盖。冲突 helper 提取回归 2 项见 `m5.2-legacy-disposition-extraction.log`，原备份 Rhine 合同回归 1 项见 `m5.2-tail-legacy-restore-final.log`。
- 新复核界面脚本 4 项及原备份脚本 8 项见 `m5.2-legacy-provenance-ui.log`。这些脚本行为测试不是人工内容或真实页面验收。
- 本批相关 lint 通过：`m5.2-tail-root-lint.log`、`m5.2-tail-last-changes-lint.log`、`m5.2-personal-metadata-lint-final.log`、`m5.2-legacy-provenance-lint-final.log`、`m5.2-legacy-disposition-lint.log`。

最终工作区 Node／Web 类型检查均未通过，各剩一项并行领域错误：

- `m5.2-tail-node-final.log`：`src/core/playback/session.test.ts:4018` 的 `TrackData` 测试对象缺少 `fileName / size / cover / lyrics`，由播放域负责人修复。
- `m5.2-tail-web-final.log`：`src/renderer/src/components/dsp-rack/DspSignalOverview.vue:161` 访问不存在的 `CorePlayerTrack.filePath`，由 DSP 负责人修复。

两处修复后须重跑对应类型门槛，当前不能标记全局类型检查通过。

音乐库域负责人当前正在推进 [M5.3 全库与性能](D:/Project/Twilight_Echo/docs/unified-music-library-m5.3.md)：只读对账与后台读取探针已接入，首轮十万条实测暴露的查询退化仍在修复，等待同库复测。随后修复 SQLite date-only 扫描合同缺口，再由 M5.4 集中进行生产构建、包内备份恢复、人工内容、实际页面／键盘／主题及 Windows 交付验收。旧不明正文需用户在迁移前确认其权利，未确认内容留在原库，不宣称所有旧正文已自动迁走。M2.6 及 M1—M5 的完整交付仍待验收。
