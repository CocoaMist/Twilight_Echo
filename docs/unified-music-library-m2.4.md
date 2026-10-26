# M2.4 实施记录：Rhine 资料迁入主库

日期：2026-10-24。状态：**资料存储、旧导入与联网查询已切换到主库及 Core 持久队列；旧页面生产验收仍待恢复 Electron 环境。** 后续推进 M2.5 页面接线，M2 整体未完成。总路线见[统一音乐库计划](D:/Project/Twilight_Echo/docs/unified-music-library-plan.md)。

## 本批交付：只有一份可写资料

生产 [CorePluginExperiences](D:/Project/Twilight_Echo/src/core/plugins/experiences.ts) 注入原音乐库数据库服务；没有另建 JSON 曲库或独立数据库。原 `extensions.document / edit`、task／preview／import／reconcile 继续使用相同文档、专辑 ID 与 revision 合同，切换后资料写入音乐库 SQLite。生产入口原本就依赖该数据库；未注入资料仓库的旧调用方式仍可使用原 JSON 路径。

schema **18 → 19** 增加 `metadata_legacy_documents / albums / bindings / history`，沿用升级前的 WAL 一致快照和 DDL 事务。原载荷按记录保存，旧外部 ID、人员、references、method、batch、时间、proofs、注记及非资料配置均保留。流派规则仍是旧文档的原字段，不提前转换为 M3 的分类模型；UI 偏好继续由原偏好域保存。

本批 **19 → 20** 增加批次、逐专辑手动输入版本与文档手动 revision。联网任务复用 `metadata_jobs / metadata_demands`，没有第二份任务库。v19 升级保留实际 WAL 一致快照，输入版本从原文档回填；部分 DDL 失败回滚，原文档仍可读。

### 归属由原 ID 和真实成员决定

- 保留原 `album-${sha256(collectionId)}` 算法，不把它当 MBID 或 catalog UUID。Core 分页读取真实 collection，SQLite 沿 collection aliases → Track → local catalog binding 保存原实体与成员证据。
- `bound` 仅指找到了原本地来源，不代表外部身份已确认。旧 `matched`、姓名或 trackTitle 不创建共享人物、录音或发行关联。
- 找不到原 collection 的记录保留为 `unassigned`。多个旧 ID／插件对同一来源保留不同正文、注记、人员或外部发行 ID 时标为 `conflict`；不按行顺序选一个介绍。
- 新导入首次为现有专辑增加记录时，也通过 Core 的真实 collection 映射建立归属；新未知 ID 不按同名标题匹配。普通编辑保留已有归属，恢复历史使用当时保存的成员证据。

### 迁移与恢复

[迁移协调器](D:/Project/Twilight_Echo/src/core/plugins/legacyMusicAuthority.ts)在首次旧入口读取时执行：等待扫描／旧查询不活跃、冻结曲库 revision → 保存旧文档快照 → begin → 每批最多 100 条暂存 → 重读旧文档核对内容 → 同一 SQLite 事务发布。collection 查询每页 200 条。

- 暂存不进入详情，未发布失败仍可用旧 JSON，status 暴露错误；同版本暂存可幂等重放，源文档或曲库 revision 改变后重新暂存。目前是从头幂等重放，不是游标跳过已迁页。
- 发布后只读写 SQLite；读库故障不能回退 JSON。重复启动不重导入旧文件覆盖新值。
- 迁移前保留 `music-metadata.before-main-library-<revision>.json`。每次旧接口编辑／导入／恢复前仍实际生成 `music-metadata.backup-<revision>.json`，原 import 返回的备份名可用；SQLite 同时保存历史载荷和成员证据。
- 恢复要求当前 expected revision，以新 revision 发布，不回退版本号；恢复本身也保留修改前历史。原 `albums: {}` 与没有 `albums` 属性分别保留。
- 读、写和重建文档均沿用原 **16 MiB** value 合同；暂存也检查聚合大小，拒绝分项合规但总文档过大的导入。

### 主库详情能读到什么

实体详情的 `imports` 返回原本地来源范围的介绍、注记、出处和人员姓名／原角色。显示限额为每条正文／注记 20,000 字符、8 个出处、64 个人员条目，完整载荷留在迁移清单。引用链接沿用 HTTPS 页面校验，不把原始音频路径、任意资源地址或旧 trackId 包装为已确认关系。

人工指定／明确清空仍优先。用户显式 `external-ai` 导入的正文优先于自动外部正文，普通历史正文仅在缺正文时回退；冲突记录保留可读但不自动选为介绍。正文标为 `origin: imported`、语言未知为 `und`，不冒充百科。资料不会通过共享 target 传播到另一张同名专辑。

## 旧桥的清单和恢复操作

仍使用 bridge `music.metadata.operate`，通过 `args.operation` 与 `args.body` 调用；需要原 `library:write` 权限和已启用的 experience。

```ts
// 分页查看已归属、未归属及冲突，包含原载荷和 collection／成员依据。
const inventoryArgs = { operation: 'inventory', body: { offset: 0, limit: 100 } }
// 列出历史 revision；读取后与当前文档核对内容。
const historyArgs = { operation: 'history', body: { offset: 0, limit: 100 } }
const readArgs = { operation: 'history.read', body: { revision: 7 } }
// expectedRevision 来自最新 music.metadata.read；冲突时重读，不覆盖。
const restoreArgs = { operation: 'restore', body: { revision: 7, expectedRevision: 9 } }
```

清单与历史分页最大 200；恢复返回新文档。该入口已贯穿请求白名单、Core、数据库协议和真实 worker；本批没有新增恢复按钮或宣称页面验收完成。

## 旧联网查询使用唯一持久 worker

[生产入口](D:/Project/Twilight_Echo/src/main/coreProcess/entry.ts)为 experience 注入 [CoreEntityMetadataService](D:/Project/Twilight_Echo/src/core/library/entityMetadataService.ts) 的任务代理和[旧来源适配器](D:/Project/Twilight_Echo/src/core/plugins/legacyMusicLookupProvider.ts)。introductions／credits／enrich 继续接受原选择与 force 参数，分别使用百科、QQ 制作人员和 MusicBrainz；不要求先确认 MB 身份或新增平台登录。没有注入任务 owner 的独立旧调用保留兼容循环，生产不会走该路径。

- 批次 begin → 每页最多 50 条 stage → publish；未完整发布不执行。Core 重启将中断提交的 staging 标为 abandoned，已发布 running 任务按原 generation 恢复。发布回执丢失不重放写操作。
- 结果、旧来源资料更新和任务状态在同一 SQLite 事务提交。每批保存一次查询前历史，不在每条自动结果写整文档备份。显式编辑／导入／恢复仍产生原备份文件。
- 提交同时检查 generation、批次、原 collection 的真实 Track 成员及版本、该专辑手动输入版本和相关联系配置。手动 A→B→A、删除后重建均拒绝旧结果；无关专辑编辑不取消当前来源任务。自动补资料不会使另一个 operation 的任务或暂存批次失效。
- 自动结果按最新来源行合成：QQ 和 MB 人员互不覆盖，保留原角色；MB 回传的查询前旧正文不覆盖新取得的百科介绍。external-ai 正文与实体人工覆盖／清空优先；旧 matched 仍不确认共享身份。
- 共享 HTTP 只为 QQ 增加精确、受限的 POST 端点，不开放任意主机、路径或请求体。请求键包含 body，避免不同歌曲串响应；相同请求共享结果并独立取消。保留 QQ 原 1.5 秒节奏及持久缓存／冷却，其他公开来源继续共用 host 预算。
- 429／503 与 Retry-After 进入持久重试，单任务最多 5 次尝试；等待期间同批剩余条目也延后，不扩散请求。部分 credits 先保留并计入 updated。401／403 阻断同批剩余流量；连续 3 个最终失败将余项标 blocked，用户可修复来源后从旧入口重新发起。取消不会被 QQ 误记为连接失败或制造冷却。
- 每次请求前和提交前检查启用状态、network 与 library:write。新自动识别设置默认关闭不禁止原显式查询；明确 `TWILIGHT_METADATA_ENABLED=0` 禁止旧联网任务，明确 `TWILIGHT_METADATA_WIKIPEDIA_TEXT=0` 禁止百科文字，但仍允许旧 MB 操作取得人员等结构资料。QQ 仍是原非稳定官方开放接口，商业来源启用条件需另行核对。

旧 status 的 running／completed／total／updated／failed／notFound／currentAlbum／error 保留，新增 batchId、needsReview、blocked、retrying、cancelled 和 nextAttemptAt。completed 是终态条目数；updated 可包含已保存部分结果且正在重试的条目。忙碌时原 task／preview／import／reconcile／restore 继续拒绝操作。

取消沿同一桥调用，无需停止扫描或关闭窗口：

```ts
const cancelArgs = { operation: 'cancel', body: { operation: 'credits' } }
```

取消只撤当前插件／操作的最新批次，不影响其他 operation、已完成资料或其他实体任务；迟到结果不能提交。重新查询仍受来源冷却约束。

## 资料迁移第一批证据

- 新迁移回归 **12 / 12**：原 payload／ID、同名隔离、人工值、暂存与 revision 漂移、源变化、原 task／preview／import、实际备份与恢复、空对象语义、冲突、首次导入归属、发布前后故障、16 MiB 聚合和真实 DDL 回滚。与原 experience 组合最终 **15 / 15**，包含数据库恢复可用后清除旧错误状态，见 `tmp/legacy-metadata-final-tests.log`。
- 完整 Core **1014 / 1014**；包含新迁移用例，原 experience 用例仍通过。证据：`tmp/legacy-metadata-core.log`。
- schema／数据库受影响组合 **316 / 316**。证据：`tmp/legacy-metadata-migrations.log`。
- 新增真实数据库 worker 恢复用例通过：跨两次进程替换，暂存继续、事务发布、历史和成员归属恢复；资料操作不推进扫描内容 revision。证据：`tmp/legacy-metadata-worker-final.log`。
- Node／Web 类型、相关 ESLint、生产构建和 Renderer 资源预算通过。证据：`tmp/legacy-metadata-{node-final,web,lint,build}.log`。
- 原 Electron 生产验收继续等待 Windows `CreateWindowStationW` 权限恢复；未再次启动失败的运行时，恢复后仍用原 `node --test scripts/core-headless.test.cjs`。

## 持久任务本批证据与继续点

- 完整 Core **1040 / 1040**：`tmp/legacy-tasks-core-final.log`。包含新增 22 个持久任务／真实来源适配器用例和 4 个共享 HTTP 用例；真实来源适配器使用模拟响应，未据此宣称在线覆盖率。
- 最终旧入口／迁移／持久任务／HTTP 组合 **41 / 41**：`tmp/legacy-tasks-final-tests.log`，包含扫描期间仍可取消，以及连续失败暂停余项的检查。
- 受影响 schema／数据库组合 **163 / 163**：`tmp/legacy-tasks-database.log`。新真实 worker 用例跨两次进程替换验证 staging 放弃、已发布恢复、旧 generation 拒绝、实际结果和取消持久化；单独证据 `tmp/legacy-tasks-worker.log`。
- Node／Web 类型、相关 ESLint、生产构建和 Renderer 预算检查通过：`tmp/legacy-tasks-{node-final,web,lint,lint-final,build}.log`。

继续 M2.5：自动确认后的正文补全、原人物／专辑页、设置、TaskCenter 与收件箱。旧页面运行验收仍依赖恢复原 Electron 窗口站权限，届时在同一生产链路补验，不改用无 sandbox 或替代 runtime。随后完成 M2.6 内容验收，以及 M3 分类与版本、M4 评分与 Focus、M5 探索和完整备份发布。
