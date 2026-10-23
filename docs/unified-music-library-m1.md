# M1 已接通：统一身份、来源与原播放链路

日期：2026-10-23。主计划：[本地与流媒体统一音乐库](D:/Project/Twilight_Echo/docs/unified-music-library-plan.md)。

M1 已完成后端纵向链路。现有窗口、扫描器、歌单、收藏和版本编辑继续使用原入口；新目录由 Core 在就绪后自动维护。简介、图片补全、流派层级、评分和统一库界面仍在后续阶段。

## 音乐条目先有稳定身份，再补外部资料

- 在现有音乐库 SQLite 增加 `catalog_*` 表，schema 从 11 升至 12。来源和音乐实体使用独立 UUID；保留原来源键、当前 Track ID 和原始实体，不重写队列 occurrence。
- 本地文件／CUE 片段由现有扫描结果进入目录。标题修改、删除后同来源重导入、Track ID 变化不会重建来源身份。路径／选择器变化视为新来源；旧来源保留为缺失记录。
- 已保存歌单、收藏和导入歌单中的平台快照进入目录。平台浏览结果不自动成为库成员；移出歌单后可保留目录缓存，但不继续计作库成员。
- 同名歌曲、现场版、同名人物不凭标题合并。没有平台专辑 ID 的平台条目也不凭专辑名合并发行。已有本地专辑分组沿用原规则。
- 现有手工版本关系是权威：新目录只投影版本、版本族及首选来源。清除／拆分关系后可以重新看到原实体，不物理吞并原记录。专辑首选来源与录音首选来源分别解释。
- 文件名、未知艺术家等展示兜底不会冒充文件标签事实。缺专辑、缺艺人标签时，不创建虚假的“未知专辑”发行或“未知艺术家”人物。

跨平台自动确认身份、外部 ID、简介和 credits 的完整事实模型由 M2 接续；当前已有多来源实体的确认依据是原手工版本关系。

## Core 分批维护，不占有第二份全库缓存

实现入口：

- [共享契约](D:/Project/Twilight_Echo/src/shared/musicCatalog.ts)
- [SQLite 目录仓库](D:/Project/Twilight_Echo/src/main/library/libraryDatabaseCatalog.ts)
- [Core 目录服务](D:/Project/Twilight_Echo/src/core/catalog/service.ts)
- [生产接线](D:/Project/Twilight_Echo/src/main/coreProcess/entry.ts)

本地回填按保存的物理游标处理，每次最多 200 条，事务之间让出事件循环。`tracks` 的增、改、删触发器持久记录待同步 ID。重启从已提交游标和待同步队列继续，不重新传输全库。

平台成员按歌单 revision 分批暂存，全部读取完毕并核对 revision 后，原子替换成员集合。中途变化或取消会丢弃这一代成员暂存。已取得的来源展示资料可以留在目录缓存中，不代表已经加入音乐库。私有批次同时限制为 200 条和 1 MiB；发送前剥离歌词、封面、streamUrl 和平台扩展载荷。

库成员使用 `librarySourceTracks()`：普通歌单只读取仍在成员列表中的快照，导入条目只采用当前手工绑定或当前解析结果。孤立快照及被手工绑定替换的旧候选不会混入库内查询。版本选择器仍使用原 `sourceTracks()` 完整候选入口。

目录使用独立 revision，不修改扫描／曲库内容 revision。扫描、歌单保存和版本编辑会触发增量投影，不产生目录更新反过来重启扫描的循环。

取消只暂停目录投影，并等待当前已发出的有限批次结束；不取消扫描、播放或歌单写入。`catalog.refresh` 可恢复；Core 重启也可以从持久进度续跑。同步失败会暂停并通过状态查询返回错误，不自动重放未知结果。

## 公共查询只返回有界投影

查询通过现有 Core 协议、权限检查和窗口桥，不另建 Renderer IPC：

| 操作 | 用途 |
|---|---|
| `catalog.query` | 按 recording／release／artist、来源、库内／目录缓存及文字分页查询 |
| `catalog.detail` | 实体及文件／平台原始字段事实；最多 200 个事实，并返回 `factsTruncated` |
| `catalog.sources` | 来源分页、成员状态、缓存可用性、对应层次的首选来源和展示资料 |
| `catalog.status` | 目录 revision、回填游标、待同步量、已投影的歌单／版本 revision、运行或暂停状态 |
| `catalog.refresh`／`catalog.cancel` | 桌面窗口恢复／暂停目录任务，要求曲库写权限 |
| `catalog.play` | 按明确来源 ID 和目录 revision 播放，要求播放和曲库读取权限；平台来源还要求 provider 调用权限 |

分页最大 200 条。调用方可携带 revision；资料变化后返回 `STALE_REVISION`，不能把旧页的来源选择静默应用到新状态。

公开来源视图不包含路径、播放 URL、凭据、来源键、SACD 选择器或可能本身就是路径的旧 Track ID。播放使用 `sourceId`；只有 Core 的私有解析器能恢复原 Track、物理文件和 CUE／SACD 选择器。`indexed` 表示本地来源被索引，`unknown` 表示平台缓存尚未验证；这不是账号授权、文件存在或地区可播放的保证。

## 明确选源不会触发现有的搜索换源

`catalog.play` 经私有来源解析器和现有 `fromTrack`／队列／媒体授权链路播放；平台先检查已启用的原适配器，不缓存授权 URL。

新入口将 `sourceSelection: explicit` 保存在这一队列条目上。现有故障恢复仍可刷新该来源的 URL，但不会搜索替代歌曲，也不会在原生明确拒绝后自动换成另一来源。该选择随持久队列和保存的数组会话保留。既有入口未带此标记时，保持原恢复行为。

M3 再提供统一曲目自动选源入口；届时只允许在已经确认等价的来源之间选择与回退。

## 验收证据

| 验证 | 已取得的证据 |
|---|---|
| 新模型及 Core 后台任务 | 13 项测试通过：稳定 ID、重复导入、缺失标签、CUE／SACD、手工录音和专辑版本、分层首选来源、分页、暂存取消、暂停恢复、传输字节上限 |
| 升级与恢复 | v11→12 备份、队列与内容 revision 保留、重开续跑；注入部分 DDL 失败后回滚，备份失败阻止升级；旧 schema 迁移 fixture 同步更新 |
| 数据库服务和原队列 | 实际子进程 transport 与队列回归组 82 项通过；目录写入不发布假的曲库内容变化 |
| 播放与 Core 协议 | Core 请求校验／权限测试、应用接线、实际持久队列及原生引擎替身验证通过；明确来源失败不搜索换源，CUE 范围与新 occurrence 保留 |
| 会话及原调用方 | 保存／恢复显式选择、旧工作区、Renderer 队列快照和会话工具回归通过 |
| 歌单成员边界 | 歌单服务 27 项回归通过，覆盖孤立快照、被替换的导入候选与旧版本选择器入口保留 |
| 架构与编译 | Core 边界 3 项通过；Node 与 Web 类型检查通过；`electron-vite build` 打包通过 |
| 真实运行时 | 扩展既有 `scripts/core-headless.test.cjs`，真实 Electron Core／数据库在零窗口环境完成目录查询、修订通知及曲库 reset 后成员同步；测试通过，未使用用户资料或启动音乐播放 |

主要测试文件：

- [目录数据库](D:/Project/Twilight_Echo/src/main/library/libraryDatabaseCatalog.test.ts)
- [Core 后台任务](D:/Project/Twilight_Echo/src/core/catalog/service.test.ts)
- [Core 请求与应用](D:/Project/Twilight_Echo/src/core/application.test.ts)
- [播放会话](D:/Project/Twilight_Echo/src/core/playback/session.test.ts)
- [故障恢复](D:/Project/Twilight_Echo/src/core/playback/sourceRecovery.test.ts)
- [保存会话恢复](D:/Project/Twilight_Echo/src/core/workspace/restoration.test.ts)
- [真实 Electron 集成](D:/Project/Twilight_Echo/scripts/core-headless.test.cjs)

新增测试已加入现有 `test:core` 和 `test:library-database` 入口。这里记录的是受影响链路的验收，不包含 M5 的十万条性能对比、界面验收或 Windows 安装包验收。

## 升级后的恢复方式

打开旧数据库前会生成同目录的 `.v11-backup-<UUID>.sqlite` 一致快照，包含已提交 WAL 数据；升级失败不发布新 schema。旧二进制不能直接打开 schema 12。确需退回旧程序时，退出播放器后使用与旧版本匹配的升级前备份；已有新增个人数据时先按主计划导出，再执行恢复。

## 下一阶段：让用户看到补全资料

继续由音乐库域负责人扩展现有 CoreMetadataService：持久资料任务、供应商能力与使用限制、明确的身份依据、字段出处及覆盖，再接通平台资料、MusicBrainz、Wikidata／Wikipedia、CAA 和详情界面。不新增第二份补全队列，不把名字相似或文件名兜底当成已确认身份。
