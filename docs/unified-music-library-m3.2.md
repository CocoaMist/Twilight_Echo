# M3.2：按分类浏览本地与流媒体音乐库

日期：2026-10-24。歌曲／专辑分类浏览、多维筛选、分类出处及人工集合编辑已接入原流派页。用户要求的人工内容与桌面验收继续后置；下一开发包为 M3.3 版本页与统一选源。

## 在原流派页筛选，再明确选择来源播放

“按分类探索”面板默认展开，支持：

- 按稳定流派 ID 查歌曲或专辑，选择是否包含子流派；流派树、结果、来源、证据和分面分别分页。
- 筛选全部／本地／库内平台来源，搜索歌曲或专辑；旧字符串卡片及其导航继续保留在下方。
- 按发行地区、项目首发年、具体发行年、专辑类型、格式、位深、采样率及管理状态组合筛选。同维度多值取 OR，维度之间取 AND，并约束同一来源。
- 展开条目的真实库内来源，分别查看歌曲与专辑分类的出处；为准确目标指定多流派、明确清空或恢复自动分类。
- 明确点击某一来源播放，继续走原 `catalog.play(sourceId, catalogRevision)`。失败后由用户改选，不取第一来源或跨版本代播。

已有“流派整理”面板继续管理树和未知原词，默认折叠。新查询不重定义 `LibraryQuery.genre`，也不改写文件标签、CUE 或平台账号。

## 合并条目，不抹平来源差别

查询只计真实 `catalog_memberships`，缓存的平台搜索结果不算入库。手工播放版本关系沿原 `catalog_bindings` 使用，不另猜同名歌曲是否相同。

歌曲使用当前筛选范围内的来源有效流派并集。专辑有直接分类时只用直接值，否则从库内曲目并集回退，标为“来自曲目”。**人工明确空集合仍是直接决定**，不会触发回退；专辑分类不反向灌给曲目。

本地专辑沿原 canonical collection 和文件夹别名映射。平台专辑使用原命名空间 album key，但须有非空字符串原生 `albumId`，条件与目录的 `albumId.trim()` 一致。仅有同名专辑、空白或非字符串 ID 的来源不产生共享专辑覆盖目标，仍保留隔离发行。

父节点、分面和列表按目标实体 DISTINCT；一个条目命中多个来源或多个子流派也只计一次。窗口只收当前页，每页最多 200；分类摘要最多 32 项，保留完整总数及截断标识，完整集合在证据／编辑接口读取。

## 未知维度保留未知

| 维度 | 当前依据 |
|---|---|
| 发行地区 | 已确认具体发行的有效 `country`；不表示歌手籍贯或歌曲语言 |
| 项目首发年 | 已确认专辑项目的 `firstReleaseDate` |
| 具体发行年 | 已确认具体发行的 `releaseDate`；缺少时使用来源实际日期，校验日期和精度 |
| 专辑类型 | 已确认专辑项目的有效 `primaryType`；不能由标题推测 |
| 来源规格 | 具体来源的 format／bitDepth／sampleRate；未知不代表低规格，也不折算为星级 |
| 管理状态 | 当前目标身份是否确认、发行是否确认、当前介绍是否可用、来源索引／缺失状态 |
| 歌曲语言、版本属性 | 当前适配器无相应权威字段，仅提供“未知”及能力说明，不从正文语言或 Live／Remaster 等标题词推断 |

“发行未确认”不表示必有复核任务；“来源缺失”来自目录记录，不冒充实时网络探测。介绍状态沿详情页人工覆盖／清空及 external-AI 导入优先规则。外部字段须有已确认身份、有效展示／缓存许可；平台资料还校验当前账号上下文及跨来源许可。MusicBrainz 社区流派／评分仍未启用。

## 同一快照贯穿列表、计数和详情

新增 `genres.browse`、`genres.members`、`genres.facets`，全部为 `library:read`，复用原 worker、Core 和客户端。人工编辑仍经原 `genres.override` 的 `library:write`。当前平台上下文由 Core 私下注入，客户端不能提交或读取账号上下文。

token 包含 genres／catalog／content／metadata 四项 revision、`asOf`、最早到期时间和不透明 context key。身份／事实／覆盖／旧资料的独立写入在原 SQLite 内推进持久 metadata revision；worker 发布修订，Core 快照及页面失效监听已接通。每次读取冻结时钟，返回前跨过到期点则整次拒绝；账号变化、worker 更换或任一相关修订变化也拒绝旧 token。

页面在到期或资料／上下文变化时撤下旧结果及计数，保留选择和人工草稿，要求明确重读。新 schema 22 先生成一致备份，再事务安装资料修订表及触发器；失败回滚，不完整的新 schema 拒绝打开。原 v14 启动兼容路径保留。

## 当前代码证据和后续责任

- 查询仓库最终 **15/15**：`tmp/genre-browse-repository-final.log`，包含父子包含、去重、真实成员、平台直接目标、无原生 ID 隔离、完整空白规则、分面及到期栅栏。
- 维度与许可：`tmp/m3.2-classification-dimensions.log` 10/10。
- UI VM／编译 Vue：`tmp/genre-browse-ui-tests.log` 13/13；持久资料修订监听补测 `tmp/genre-browse-ui-watch-test.log` 5/5。
- schema／生产平台目标：`tmp/genre-browse-schema-final.log` 4/4；原 schema 迁移选集 `tmp/genre-browse-migrations.log` 41/41；M3.1 迁移、回滚及完整性另见 `tmp/genre-browse-schema.log`。
- Core 调度及私有上下文和 schema 的最终补测 **9/9**：`tmp/genre-browse-final-adjustments.log`，包含首次读取建立资料修订基线；实际权限／路由：`tmp/genre-browse-core-final.log` 1/1；真实数据库 worker 更换、持久覆盖、快照失效及资料修订事件：`tmp/genre-browse-worker-final.log` 1/1。不同回归选集有重叠，不作为统一总数累加。
- Node 类型和相关 ESLint 通过，见 `tmp/genre-browse-node-final.log`、`tmp/genre-browse-lint-final.log` 和最终增量 `tmp/genre-browse-lint-last.log`。Web 检查仅有既存 `DspSignalOverview.vue` 的 11 项诊断，见 `tmp/genre-browse-ui-web.log`；由 DSP 修改负责人恢复全局门槛。

本批未做生产构建、人工 200 条样本、实际 Electron／原生键盘／主题／包内验收。用户安排验收时由音乐库域负责人完成；原 sandbox 窗口站权限依赖保留。M3.3 继续发行关系、版本页和统一选源，M4 再做评分、收藏／禁播、标签与 Focus。
