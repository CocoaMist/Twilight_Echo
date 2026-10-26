# M2.5 实施记录：自动补资料与原页面阅读

日期：2026-10-24。状态：**资料阅读与编辑、自动设置、图片／credits、身份复核及原收件箱已接线；TaskCenter 已接持久任务、当前需求与安全取消。历史关联恢复和终态共享补全重新查询已接线。按用户安排先推进 M3，M2.6 内容与真实桌面验收后置。** 本包复用 schema 20，不增加数据库或任务调度器。总路线见[统一音乐库计划](D:/Project/Twilight_Echo/docs/unified-music-library-plan.md)。

## 确认后立即补资料，本地与平台走同一条链路

[实体服务](D:/Project/Twilight_Echo/src/core/library/entityMetadataService.ts)在自动确认和人工确认后唤醒原 Core worker。人物、录音、专辑项目和具体发行分别按已确认的类型及外部 ID 请求资料，不要求先取得每一首录音的身份。

- 已选择 `musicbrainz` 时，可用的 `musicbrainz-details` 和 `public-artwork` 分别补正文／发行属性／credits 与图片；可用层次和使用条件仍由原适配器决定。
- 已选择 `platform.<id>` 时，只调用该平台实际支持且获准缓存的资料方法。平台原生身份不依赖 MusicBrainz 服务许可；未确认的同名本地条目不会读取平台人物的传记。
- 本地与平台确认到同一身份后，同供应商、语言、外部 ID 和账号／许可上下文共用一项持久任务；每个原实体保留自己的自动需求。跨来源展示仍经过已有字段使用范围过滤。
- 人工指定、明确清空及恢复自动沿用原覆盖规则。后台保存事实不会覆盖人工值，空结果也不清除有效旧资料。

自动任务继续受新入库／历史回填、资料源和部署许可共同控制，默认关闭。旧显式查询与刷新不新增这些自动开关作为前置条件。

## 沿用事务 outbox，重启不会漏掉后续任务

[身份仓库](D:/Project/Twilight_Echo/src/main/library/libraryDatabaseIdentification.ts)在确认、增加外部引用和解除关联的同一事务标记原 `metadata_identification_schedule`。新增引用也标记所有已关联来源，让它们发现新可用的供应商。没有原 outbox 的旧实体按历史范围处理，不擅自当成新入库条目。

[原调度器](D:/Project/Twilight_Echo/src/main/library/libraryDatabaseIdentificationSchedule.ts)继续每次最多处理 200 个实体；选择识别或已确认身份的补资料需求，然后在同一事务写任务、需求和 outbox 处理结果。未完成的目录暂存仍等待发布，不把搜索缓存当成真实库成员。

成功、未找到、最终失败或受阻的相同任务不会因每 5 秒轮询、相同重扫或无关资料变化反复重启；用户显式刷新仍可重试。数据库 worker／Core 重启沿用 generation 恢复，旧 generation 不能提交。

## 共享任务只在仍有有效消费者时执行和提交

[任务仓库](D:/Project/Twilight_Echo/src/main/library/libraryDatabaseEntityMetadata.ts)按实际需求判断任务是否完全自动，不靠 batch ID 前缀，也不拿共享 target UUID 当作来源实体 ID。

- 领取和提交都检查真实库成员、当前确认关联及自动配置；共享身份的任意一个有效消费者仍可继续，不取第一条需求代替全部判断。
- 本地文件已从 `tracks` 删除时，即使目录投影尚未追上，也不再领取自动联网任务或写入其迟到结果。
- 关闭自动、切换来源／语言／账号会撤掉相应自动需求；存在显式需求时保留它。运行中的自动请求可取消并恢复仍有效的显式共享任务。
- 解除某一来源不取消其他已关联来源的需求；仅有自动需求时，最后一个消费者失效后不能写回。已保存的共享资料保留供其他有效关联使用。

## 语言与生产接线

原 `musicIdentification` 设置新增可选 `language: zh-Hans | zh-Hant | en`；缺省时不增加持久属性，仍兼容旧设置。生产默认语言通过原 UI `language` 与共享 `resolveLocale` 解析；修改资料语言或默认 UI 语言后重新协调自动任务。

内部 `IdentificationScheduleRequest.enrichment` 为可选字段，旧数据库调用保持原识别合同。最多 16 个选定资料源可展开为 17 个补全适配器：MusicBrainz 正文和公共图片各一项，其余为平台来源。

## 旧页面通过稳定引用读取，不按名称选择首个实体

[分页引用投影](D:/Project/Twilight_Echo/src/main/library/libraryDatabaseCatalogReferences.ts)在原 `LibraryPage.catalog` 中返回与曲目逐项对应的引用，重复 occurrence 保留重复位置，未发布或待重建来源为 null。每曲最多预览 16 项，原人物／专辑 collection 每组最多 8 项，同时保留真实总数。引用只属于页面返回，不进入 Track 标签、歌单快照和播放身份。

原 `catalog.query` 新增可选 `context`：按本地 collection 的既有成员规则、准确的 provider + Track ID，或平台原生人物／专辑 ID 查询完整分页引用。专辑别名沿用原目录合并规则；手工版本读取有效绑定，解除后回到原实体。未提供 context 的查询保持原有 scope；带 context 时不展示已删除或正在重建的旧本地投影。所有选择器为参数化匹配，读取不创建实体或联网任务。

[共用资料面板](D:/Project/Twilight_Echo/src/renderer/src/components/music-metadata/EntityMetadataPanel.vue)已接本地 `SongList` 和平台人物／专辑详情，保留原曲目、曲序及播放动作：

- 唯一引用直接阅读；同名或多人分组按 6 项分页列出，附关联曲目供区分，用户选择后才读取介绍。这里选择的是查看对象，不是确认外部身份。
- 专辑可切换“具体发行”和“专辑作品”，分别显示确认状态；未确认发行标记“具体发行待确认”。现有发行日期、类型、地区及条码按事实显示，缺失不补造。
- 正文和属性附供应商、署名、许可及来源链接；显示实际语言、人工值或历史导入标记。人工清空不回退到平台介绍。新目录读取失败时，已有平台页面介绍仍可独立显示。
- 新 `CoreSnapshot.entityMetadataRevision` 只通知资料变化，不冒充扫描内容 revision。后台补全、覆盖和账号／能力变化使页面重读；播放时钟更新不发资料查询。换页、导航、语言切换和卸载取消旧请求，迟到响应不能串页。

## 在原设置页管理自动范围、资料源和语言

入口为“设置 → 媒体库与存储 → 音乐库资料”，使用 [MusicMetadataSettings](D:/Project/Twilight_Echo/src/renderer/src/components/settings-page/MusicMetadataSettings.vue)；四项均接原设置搜索及 disclosure 定位。新入库和历史回填分别控制，默认关闭；语言可选简体、繁体、英文或跟随界面，跟随时移除可选属性，不持久化一个伪默认语言。

写入沿原 `useSettingsStore.updateSettings` 队列和 Core 设置文件。保存中禁用同组编辑，值以确认设置为准；错误显示并保留已确认值。关闭范围保留已取得资料，不清理手动值或添加第二套 Renderer 调度。

原 `metadata.entity.policy` 增加可选 `sources` 投影，枚举实际注册的识别与补资料能力，按实体层次分别给出可用性与原因。MusicBrainz 选择关联结构化资料和公共图片，但文字与图片仍各按许可执行；平台可识别不代表已批准缓存介绍。公共服务受限不禁用独立可用的平台来源。不可用但已选的来源保留并可取消，不默默删除用户配置；新增选择需当前可用，最多 16 个。

启用选择旁明确说明发送名称、外部 ID、必要曲序与时长，不上传音频、本地路径或播放历史。能力查询只读，不测试远端网络，不返回账号配置或凭据；插件、设置、资料权限和 Core epoch 变化使其重读，播放时钟不触发查询。

## 手动介绍、明确清空与恢复自动分别提交

原本地／平台人物和专辑共用面板接 [IntroductionEditor](D:/Project/Twilight_Echo/src/renderer/src/components/music-metadata/IntroductionEditor.vue)，继续使用已有 `metadata.entity.override` 与 `library:write` 权限，不新增写入口。未确定唯一条目时先选择，不以名称发写命令。

- 编辑只预填既有手动值，不把外部或导入正文自动转成无出处的手动文案。正文上限 20,000 字符，支持显式语言；空白不等同清空。
- 清空和恢复自动各需确认。清空保留明确标记，抑制自动、历史及旧平台介绍；恢复自动只删除手动覆盖，重读已有资料，不发起联网任务。
- 草稿绑定当前实体、来源／层次／语言／Core epoch 和读取 revision。后台重读保留草稿，但不会自动提升它的 revision；冲突后先重读，由用户核对并显式接受新 revision，再另行保存。
- 保存结果未知时保留草稿并读取核对，不重放写命令。成功也只通过当前来源／账号上下文重读，不直接展示写命令的原始返回内容。切换对象或上下文后，旧响应不能更新新页或提交旧草稿。
- 编辑／确认进入相应控件，取消或成功后回到编辑按钮；切换页面时不把焦点拉回旧条目。模板处理和焦点调用由 Vue 自定义 host 测试覆盖，真实桌面键盘体验仍需 Electron 验收。

## 人物与专辑页显示已有图片，保留实际层次和出处

原共用资料面板接 [EntityArtwork](D:/Project/Twilight_Echo/src/renderer/src/components/music-metadata/EntityArtwork.vue)，消费 Core 按当前身份及许可返回的会话图片句柄，复用 `CoverImg`；不向 Renderer 暴露数据库中的资源 URL，也不替换播放封面。

- 人物图片、具体发行封面和专辑作品图片分别标记，附署名、许可及来源；项目图片取自某一关联发行时，显示该发行的明确 ID 和外部链接，不将其称为当前具体发行。
- 加载失败不显示默认歌曲封面冒充人物；提供“重新读取图片”，通过原详情查询重新取得有效句柄，不循环重试或新增补资料任务。
- 图片到达使用期限时移除已绘制的图像，不只依赖协议拒绝新请求。身份、来源或账号变化仍由原资料 revision 观察器清除旧详情并重读。

## 歌曲信息按录音身份展示参与人员，不借用专辑名单

本地与平台共同使用的原 [TrackInfoDialog](D:/Project/Twilight_Echo/src/renderer/src/components/TrackInfoDialog.vue)接 [TrackCreditsPanel](D:/Project/Twilight_Echo/src/renderer/src/components/music-metadata/TrackCreditsPanel.vue)。按共享 `getTrackSource` 和原 Track ID 查询准确的录音引用；唯一引用直接读取，多项先选择，未确认录音身份时不展示外部名单。

发行的 credits 集可能同时包含整张专辑、多个录音和关联作品的关系，因此歌曲入口只查询自身已确认录音的集合，不回退到发行集合或按曲名选一首。录音响应中通过明确 work ID 取得的关系保留“作品级”标记和外部目标链接。尚未单独确认录音时，即使发行集合中已有相关资料，此入口也不将其当作该录音的人员名单。

人员每页 20 项，沿原 `metadata.entity.credits` 在 SQLite 分页；新增可选 `entityRevision`，第一屏也核对详情的身份 revision，后续同时核对 credits revision。旧调用不要求新字段，原查询和权限合同不变。身份解除、条目／来源切换、Core 重连与卸载均取消旧请求；迟到成功或错误不能回填，冲突需重读而不静默切换身份。

角色显示中文名称并保留原角色、方向、属性、日期和署名连接符；未知角色及正向关系不改义。同名但不同人物 ID 不合并，人员和作品目前只打开经限定的 MusicBrainz 外部链接，库内参与内容导航仍在 M5。打开信息和“重新读取”均只读，不启动联网补全，不随播放时钟查询；原标签编辑、版本入口及关闭行为保留。

## 原资料页和收件箱直接复核已保存的候选

人物／专辑资料区与原歌曲信息共用 [IdentityReviewPanel](D:/Project/Twilight_Echo/src/renderer/src/components/music-metadata/IdentityReviewPanel.vue)。候选每页 6 项，选择后显式比较当前与候选的类型化 ID、相符／缺少／冲突依据、出处及不完整状态；不自动选择同名首项。

- 确认、替换、拒绝、重新确认已拒绝候选和二次确认解除，沿用原 `identification.preview/decide/detach`。提交携带保存的 candidate revision 和当前关联 revision；过期或冲突禁确认，收到版本冲突先重读，不自动换新版本再提交。
- 打开、换页和重新读取仅查询本地资料。只有“联网重新识别”调用原 `identification.start`；回执未知先核对持久状态，不重放写命令。
- 来源／实体／层次／Core epoch 变化及卸载会隔离迟到响应；播放时钟不发资料查询。手动正文与原 Track／队列身份保持原合同。

原“曲库整理收件箱”保留默认文件问题范围，新增“音乐资料复核”。新只读 `identification.inbox` 按真实库成员、实体类型和候选状态分页，20 个实体一页，给出真实总数、候选数和来源曲目样例。已删除本地条目、missing 来源及待重建目录不进入复核列表；不用每个 Track 制造一个资料问题。批量标记、文件问题索引与标签编辑仍归原范围。

确认后可继续查看当前处理对象；库成员或 Core epoch 变化清除旧选择。通用历史关联恢复现已接入，见下节；任意外部 ID 输入仍未提供通用表单，原明确人物 ID API 保留。

## 原任务中心读取持久状态，取消只影响选中的需求

原通知下拉中的 [TaskCenter](D:/Project/Twilight_Echo/src/renderer/src/components/TaskCenter.vue)接 [MetadataTaskList](D:/Project/Twilight_Echo/src/renderer/src/components/music-metadata/MetadataTaskList.vue)，继续使用 Core 唯一队列。新增只读 `metadata.entity.tasks` 和 `metadata.entity.demands`，经共享校验、权限、Core、数据库 worker 接到原 SQLite；不建立 Renderer 执行队列。

- 任务每页 10 项；显示资料层次、供应商、语言、实际状态、完成／未找到／部分结果、失败原因、尝试次数和下次重试时间。“进行中”包含排队／运行／等待重试，“需处理”包含待复核／受阻（含鉴权失败）／失败。
- 全库状态计数独立于当前页、筛选和需求批次。关闭下拉继续读取资料 revision；领取 running 也发布 revision，显示运行状态不必等远端请求完成。播放时钟不触发查询。
- 当前需求每页 6 项，可查看该需求批次关联的任务。自动需求依据原 outbox 的真实 demand ID 判定，不能凭 `auto:` 前缀把用户显式需求当成自动任务。
- 新取消动作携带 generation，仅允许仍处于排队／运行／等待重试的非 legacy 任务；在数据库原事务内校验。恢复后的旧 generation、已完成任务不能被旧按钮改成取消。旧调用省略 generation 时保持原使用条件。
- 取消只撤此任务的该项需求，其他消费者继续；最后一个消费者取消才取消任务，已保存事实保留。回执未知只重读，不重放取消；清空通知不删除持久任务，列表仍可查看。
- 只有准确的真实来源 catalog ID 才提供“核对身份”。共享补全 target UUID 不冒充 catalog ID；legacy 任务仍从原专辑资料入口操作，不能绕过其批次及权限合同。

这里的批次关联来自**当前保留的需求**，不是完整取消历史。终态共享补全重新查询已接下述入口；身份识别继续使用原面板显式重新识别，legacy 继续原专辑查询，等待重试不提前执行。

## 先比较关联历史，再恢复有依据的确认

原身份面板新增默认折叠的 [IdentityHistoryPanel](D:/Project/Twilight_Echo/src/renderer/src/components/music-metadata/IdentityHistoryPanel.vue)。`identification.history` 每页 6 项，读取真实 `metadata_identity_history` 的确认、替换、拒绝和解除记录；打开、翻页和预览均只读，不重新召回候选。

“比较并恢复”通过 `identification.restorePreview` 展示当前与恢复后的类型化 ID；`identification.restore` 在原事务重新校验真实成员、当前 inputVersion／linkRevision、历史确认快照、目标引用和父专辑成员依据。输入已变化或缺完整快照的旧记录不作为可恢复凭据。恢复增加新的确认审计和 `restoredFrom`，同步原 suppression、兼容投影和 outbox，不修改原历史，不重新发布旧候选。手动内容与 Track／CUE／队列引用保留。候选写入与历史恢复互锁；未知回执只重读。

## 重新查询先选择当前有效来源，批次只提交明确选集

原 TaskCenter 的 [MetadataRequeryPanel](D:/Project/Twilight_Echo/src/renderer/src/components/music-metadata/MetadataRequeryPanel.vue)为已完成、失败、受阻或取消的 enrich 任务提供“重新查询资料”。身份识别任务继续原复核面板；进行中、等待重试、待复核及 legacy 不进入通用重新查询。

- 只读 `metadata.entity.sources` 每页 6 个真实、非 missing／pending 的当前确认关联。共享 target UUID 不作为 catalog ID；多个关联不默认选择第一项。来源标记为当前可用关联，不冒称原请求者。
- `metadata.entity.requery` 接受本页最多 10 个明确选择、原 generation／inputVersion／linkRevision 及调用方预生成的 demandId。选批次时逐项核当前需求归属；任一过期则整批不改。选集存在读取错误时整批禁提交，不静默跳过。
- Core 检查实际能力、许可和账号上下文；数据库原事务核目标、typed ID、输入和真实成员。新 generation 保留旧事实和人工覆盖；新需求是显式重新查询，不复活删除的需求，也不把自动需求改为显式。
- 新路径在原 job payload 持久保存所选消费者，领取和提交都复核。显式消费者失效时，仅仍获当前配置授权的真实自动消费者可继续；全部失效取消本代，最后新需求取消会中止在途请求。旧完成任务的需求不授权本次联网。
- 账号上下文变化不把旧 task key 偷换成新账号；重新查询须从当前来源按新上下文建立正常请求。原 `metadata.entity.enrich` 的显式入口仍按原合同独立授权共享目标，可清除之前遗留的新路径栅栏；自动 enqueue 不能解除该栅栏。原显式入口的账号恢复合同保持不变，新路径执行及提交均检查持久上下文。
- 保留原 host 调度和 Retry-After，重新查询不提前执行冷却。回执未知时按已知 demandId 查询是否已保存，不重放命令。公共命令仅返回批次和数量，不暴露内部消费者快照或账号上下文。

## 旧 v14 曲库启动修复

用户报告窗口显示“Core 初始化未完成：Core is not available”。实际启动日志中的根因是曲库检查报 `Unrecognized or incomplete music library database`：早期 v14 库尚无 `metadata_identification_inputs` 表及 `metadata_identification_input_changed` 触发器，后续同版本代码却已将二者列为必需对象。该库的 SQLite 完整性检查正常。

[数据库打开与升级](D:/Project/Twilight_Echo/src/main/library/libraryDatabase.ts)现只对 **v14 且两个对象同时缺失**的旧布局补迁移；其余必需对象、application ID 和完整性检查仍执行。迁移先用原 `VACUUM INTO` 保存一致备份，再在原升级事务中安装输入版本表、触发器及索引，继续升至 v20。部分缺失、丢失身份数据及新版残缺库仍拒绝打开；后续 DDL 失败会回滚，保留旧版本和备份。

- 真实升级前备份的副本包含 **294 首歌曲、588 条队列记录、44 张原有表**；升级前后逐表比较全部原行一致，完整性、外键和重开检查通过：`tmp/core-startup-v14-copy.log`。
- 相关迁移、身份、曲库、队列与目录回归 **84/84**，包括新增旧 v14 兼容、事务回滚及残缺库拒绝测试：`tmp/core-startup-v14-regression.log`。Node 类型与相关 ESLint 通过：`tmp/core-startup-v14-{node,lint}.log`。
- 当前开发实例已消费该修复，自动生成 `music-library.sqlite.v14-backup-35cfab6d-382f-4e0e-847f-414969203ef1.sqlite`；启动日志确认 Core／数据库／音频服务启动，窗口完成 Core 连接。沿用现有开发启动方式，没有改变 sandbox 配置；这不替代下述受阻的 sandbox 生产验收。

## 验证与剩余工作

- 新增自动补资料测试 **26 项**，覆盖同名隔离、跨源共享、四层类型、事务回滚、重启、关闭／切换／取消、人工覆盖和失败停止重排。实际平台适配器验证“原生 ID 自动确认 → 人物／专辑正文”，没有外部 HTTP 调用。
- 最终相关组合 **93/93**：`tmp/automatic-enrichment-final-tests.log`。本批前一候选的完整 Core 回归 **1065/1065**：`tmp/automatic-enrichment-core.log`；随后语言值收紧校验及来源上限修正由上述最终组合覆盖。
- 真实数据库 worker 经两次替换，确认 outbox、补全上下文和 generation 继续有效：`tmp/automatic-enrichment-worker.log`。
- Node／Web 类型、相关 ESLint、生产构建与 Renderer 预算记录在 `tmp/automatic-enrichment-{node-final,web,lint,build}.log`。

本批稳定引用与阅读新增 21 项测试：数据库 9 项、Renderer 阅读模型 11 项、真实 worker 替换 1 项；并扩展原 Core 读投影和资料权限／修订验证。相关回归 **104/104**（`tmp/catalog-references-final-tests.log`）、Core 自动任务与平台回归 **79/79**（`tmp/catalog-references-core.log`），worker **1/1**（`tmp/catalog-references-worker.log`）。Node／Web 类型、ESLint 和生产构建／预算记录在 `tmp/catalog-references-{node-final,web-final,lint,build}.log`。这些是数据库、Core、Renderer 模型和构建证据，实际页面外观／键盘／窄窗口检查仍待 Electron 环境恢复。

本批管理入口新增 **21 项**测试：实际适配器能力投影 2 项、介绍编辑模型及真实 SQLite 9 项、设置模型及原文件重载 8 项、编译后的实际 Vue 控件 2 项。相关组合 **107/107**（`tmp/metadata-management-final-tests.log`），Core application／读投影 **23/23**（`tmp/metadata-management-core.log`）。Node／Web 类型检查、相关 ESLint、生产构建及 Renderer 预算记录在 `tmp/metadata-management-{node-final,web-final,lint-final,build}.log`。自定义 host 不验证实际屏幕外观或原生焦点行为。

本批图片与人员名单新增 **10 项**测试：真实 SQLite 分层／首屏身份栅栏 1 项、分页阅读模型 5 项、编译后的实际 Vue 控件 4 项；后者覆盖真实图片组件、授权到期、录音选择／分页及原歌曲信息对话框的本地／平台和标签编辑模式。相关回归 **71/71**（`tmp/metadata-artwork-credits-regression.log`）；随后补正具体发行图片的来源提示，实际控件复验 **6/6**（`tmp/metadata-artwork-credits-controls-final.log`）。Node／Web 类型、ESLint、生产构建和 Renderer 预算记录在 `tmp/metadata-artwork-credits-{node,web-final,lint-final,build}.log`；自定义 host 验证模板与处理器，不替代桌面布局和原生键盘验收。

身份复核批次相关回归 **133/133**（`tmp/identity-review-regression.log`），真实 worker 替换 **1/1**（`tmp/identity-review-worker.log`），覆盖候选／决定、手动介绍及原 Track 引用。新任务批次增加数据库 **7 项**、阅读模型 **5 项**和实际 Vue 控件 **2 项**；受影响组合首跑 **178/179** 通过，唯一失败是格式化后控件静态文本计数未去空白的断言（`tmp/metadata-tasks-regression.log`）。修正该断言后实际控件 **11/11**（`tmp/metadata-tasks-controls-final.log`）。

扩展真实 worker 替换用例 **1/1**（`tmp/metadata-tasks-worker.log`），覆盖分页投影、批次关联、共享需求、再次打开及单需求取消。Node 类型与相关 ESLint 通过（`tmp/metadata-tasks-node-final.log`、`tmp/metadata-tasks-lint.log`）；生产构建及 Renderer 预算通过（`tmp/metadata-tasks-build.log`）。全局 Web 类型检查仍失败于工作区已有 `DspMonitor.vue`、`DspSignalOverview.vue` 的 import／字段类型错误，本批音乐库无诊断（`tmp/metadata-tasks-web-final.log`）；交由 DSP 修改负责人修复后恢复全局类型门槛。

历史／恢复批次新增 **42 项**：历史数据库 6、历史模型 4、实际历史控件 1、重新查询数据库／Core／HTTP／真实 worker 24、重新查询模型 5、实际重新查询控件 1、Core 协议权限与载荷 1。最终受影响恢复／原控件组合 **50/50**（`tmp/metadata-recovery-final-changes.log`）；历史与既有身份组合 **30/30**（`tmp/identity-history-regression.log`）；上下文／平台补全组合 **38/38**（`tmp/metadata-recovery-context-final.log`）。这些组合有重叠，不相加充当覆盖率。

较早完整受影响组合 **291/292**（`tmp/metadata-recovery-regression.log`），唯一失败发现新持久账号栅栏错误套用到原显式入口的恢复合同。已将新增条件限定自动及新重新查询路径，原账号切换恢复用例与新链路在上述 **38/38** 通过。独立审查另外修复旧补资料入口被遗留栅栏阻断、错误来源读取导致静默缩小选集和取消后请求不中止，均有最终回归。

扩展原真实数据库 worker 替换用例 **1/1**（`tmp/metadata-recovery-worker.log`），覆盖历史预览／恢复、新需求持久化及手动介绍。最终 Node 类型与相关 ESLint 通过（`tmp/metadata-recovery-node-final.log`、`tmp/metadata-recovery-lint-final.log`），生产构建／Renderer 预算通过（`tmp/metadata-recovery-build.log`）。Web 类型检查仍失败于当前工作区 `DspSignalOverview.vue` 的 10 个既存类型错误；本批音乐库无诊断（`tmp/metadata-recovery-web-final.log`），由 DSP 修改负责人恢复全局门槛。

实际 Vue 历史／重新查询组件已在浏览器 fixture 渲染，检查当前／历史 ID 比较、本地／平台选择、选择前禁提交及 400px 无水平溢出；该 fixture 使用模拟 Core，不替代实际 Electron 页面与原生键盘验收。可复现预览源码为 `tmp/metadata-recovery-preview.mjs`。用户已于 2026-10-24 将人工内容与桌面验收后置，先推进 [M3.1 分类](D:/Project/Twilight_Echo/docs/unified-music-library-m3.1.md)；M2.6 保留待办。“重新读取资料任务”仍只读，不跳过重试冷却。

M2.6 的 200 条人工核对样本及实际页面验收仍未完成。Electron 生产验收仍需桌面环境恢复 Windows sandbox 窗口站创建权限，恢复后执行原 `node --test scripts/core-headless.test.cjs`；不通过关闭 sandbox 绕过。
