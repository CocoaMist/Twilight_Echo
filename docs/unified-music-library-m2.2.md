# M2.2 实施：通用身份、持久召回与可靠证据确认

日期：2026-10-24。状态：**分层身份、自动调度、历史恢复及跨实体查询共享的后端实现已齐，生产 Electron 验收待恢复**。正文、图片、credits 与原页面消费继续按后续工作包接入。执行依据：[M2.2 细案](D:/Project/Twilight_Echo/docs/unified-music-library-m2.2-plan.md)。

## 已经落地的能力

- 内部目标保持 UUID，外部身份由 `provider + kind + idType + value` 独立映射。平台人物可以没有 MBID；同名、不同平台、不同实体层次和不同 ID 类型不会自动合并。
- 人物、录音、专辑项目和具体发行分别关联。目录新增 `album_project` 及发行到项目的来源关系；M1 的 `release` 和手工版本仍保留原含义。历史项目索引每批最多处理 200 项，游标可重启续跑。
- 多候选保存稳定 candidateId、原始依据、匹配／缺失／冲突项、截断标记、matcherVersion、输入版本、候选版本及关联版本。确认结论只作用于该来源实体，不传播给同名人物。
- 复核可以预览当前与建议目标，分别确认或拒绝；解除使用 linkId 和 revision。替换与解除保留原目标及事实，不搬移人工值，不改变播放版本或来源。
- 拒绝、替换和解除按来源／层次／外部引用持久抑制；改名、换算法或重启不解除抑制。重新采用需要人工明确确认。拒绝其他候选不会清除已经选定的关联。
- 一个候选引用到多个已有目标，或在同一命名空间包含矛盾 ID 时，预览报告冲突并阻止吞并。纠正来源时可选择目标的独立候选重新关联，旧目标及其资料仍保留。
- 人工正文覆盖不使身份候选失效；有关名称修改即使后来改回，也使旧输入失效。无关目录修改不废弃候选，仅剩 missing 来源的实体不能接受迟到识别结果。

实现：[DTO](D:/Project/Twilight_Echo/src/shared/musicIdentification.ts)、[身份仓库](D:/Project/Twilight_Echo/src/main/library/libraryDatabaseIdentification.ts)、[Core 资料服务](D:/Project/Twilight_Echo/src/core/library/entityMetadataService.ts)。继续由原 CoreMetadataService 持有，不新增后台队列或 JSON 权威。

## 第二批已接入扫描与候选输入的依据

现有扫描 worker 在本来需要解析的文件上顺带采集可选 `identityTags`，不增加音频读取，也不提升 `LOCAL_LIBRARY_METADATA_VERSION`。旧库不会因为这批代码被强迫全量重读。实现：[观察值模型](D:/Project/Twilight_Echo/src/shared/trackIdentification.ts)、[标签采集](D:/Project/Twilight_Echo/src/main/library/trackIdentityTags.ts)、[实际扫描入口](D:/Project/Twilight_Echo/src/main/library/libraryScanService.ts)。

- 分别保留曲目艺人／专辑艺人及其多人姓名、MusicBrainz artist／album-artist ID；保留数组顺序和重复值，不按数组位置推定姓名与 ID 对齐。专辑艺人不能冒充已观察到的曲目表演者。
- recording、release-track、release、release-group ID 分开，另存 ISRC 数组、条码、目录号、原始流派、曲号／碟号及各自总数。原始小数时长独立于旧界面取整的 duration。
- 新读取的字段标音频标签、CUE 或文件名推断。旧缓存／已有显示字段在识别输入中标 `legacy`，不反推成原始标签；人工或外部补全后的显示字段与原始观察值分别保留。
- CUE 子轨使用区间时长和 CUE 标题／艺人／曲号，匹配时长排除虚拟 PREGAP 静音，原展示 duration 仍保留原来的播放时长；不继承父音频的录音、release-track、ISRC 或曲目艺人 ID。父音频依据继续存在原 `audio_metadata` 缓存中。保留专辑层 ID，不把当前 CUE 的最后一轨当作整张专辑总轨数。
- 目录私有快照白名单保存这些字段，限制文本与数组大小并标记截断。识别输入最多加载 64 个有效来源、约 256 Ki 字符；先分页取来源 ID 再读取 payload。未取全时 `sourcesTruncated=true`，不能作为完整专辑或完整人物证据。
- 平台人物的 `artistIndexes` 由原目录 alias 与实际返回的结构化 credit 定位；同名但不同 native ID 的人物不会按名称对齐。此字段没有把本地旧补全的 artists.id 升格成平台原生证明。

候选输入现在包含当前显示字段、来源命名空间、实际歌曲／专辑／人物引用及原始观察值，仍仅在 Core → 数据库私有接口传递。标签 ID、曲序、艺人或有效来源变更递增单调版本，改了又改回也使迟到结果失效；未加载的第 65 个以后来源同样参与失效。手工版本分组变更分别使受影响录音／发行／项目失效。重复扫描、相同分组以及封面／歌词更新不反复废弃候选。

这些输入现由下一节的 Core 召回生产者消费；采集本身不触发联网。

## 第三批：显式发起的候选召回已接入原持久任务

`identification.start({ entityId, batchId })` 选择已索引实体。调用方保留稳定 batchId，重试使用相同 ID；返回 `{ batchId, jobs }`，取消继续使用 `metadata.entity.cancel({ jobId, batchId })`。每个适配器在原 `metadata_jobs/metadata_demands` 中生成一个 `identify` 任务，重复需求共享任务，不创建另一套队列。第三批只接入显式召回；第七批增加可选的入库调度与历史回填，仍未新增 UI。

- [召回适配器](D:/Project/Twilight_Echo/src/core/library/musicIdentificationProvider.ts)：MB 的 artist、recording、release-group 和 release 分层查询已有 ID；没有相应 ID 时按名称／艺人搜索。release-track 不当录音 ID，album-artist 不当曲目艺人，不能按位置对齐多人 ID。错误 ID／返回类型记明原因，不用同名搜索掩盖。
- 每次 MB 任务最多 4 次明确 ID 查询，或一页 10 项搜索；完整专辑另有第四批的有界验证。复用原公共 HTTP 白名单、host 预算、取消、Retry-After。搜索文本按 Lucene 字面值转义。超限、输入／响应截断和无效项保留 incomplete，不把当前页当唯一结果。
- 平台适配只消费实际注册且启用、声明相应方法的平台。artist／recording／release 可使用索引中同平台的结构化原生 ID；本地旧 artists.id 不升级为原生证明。名字搜索分别调用 `searchArtists/searchSongs/searchAlbums`，不要求平台必须同时支持歌曲搜索。平台专辑引用保留在自身来源的 release 层，不强造 MB 项目或压片。
- 候选记录名称／完整艺人文本比较、缺项、冲突和原始精度时长比较（容差 2 秒）；不拆合作艺人字符串。第三批先保存所有候选，第四批再按结构化证明自动确认。
- 候选和任务完成在同一事务发布。任务 generation、输入版本、关联 revision、matcherVersion、供应商启用状态与运行期间配置上下文共同限制提交。确认后关闭相应召回会话；拒绝最后一个候选后关闭待复核任务。拒绝／解除的持久抑制继续生效，不自动恢复关联。
- Core 重启恢复 running 任务并递增 generation。领取／完成响应丢失时，退避后读取并恢复实际持久状态，不重放数据库写请求；已完成结果不再执行远端召回。start 回执丢失仍向调用方报错，已落盘的需求继续执行。
- 网易云的 searchSongs、searchArtists 和 fetchArtistIntro 已将 requestContext 传到实际 HTTP 出口；有活动请求和预取消 fixture。歌曲／歌手搜索也区分服务错误、无效响应和真正空结果。

联网总开关仍默认关闭。平台识别受总开关及平台启用／方法能力限制，不继承 MB 公共服务许可前提；MB 路径继续要求公共服务许可与应用联系地址。自动识别的来源、新入库和历史设置见第七批。介绍正文、图片与 credits 仍在 M2.3，不因身份候选存在就复制平台正文。

## 第四批：可靠 ID 与完整专辑验证

`evidence.verification` 区分 `typed_id / provider_native / album_tracks / platform_album_tracks`，保存对应引用、实际来源 ID 和验证输入。名称、时长、搜索分或 matches 文案不能触发自动采用。第六批增加 `album_member` 子证明，当前 MB matcher 为 `mb-verify-v3-duration-2s`，平台为 `platform-verify-v4-duration-2s`。

- 明确 MBID 经固定类型端点查询，核对返回 ID、类型及已知名称／艺人／时长／ID 矛盾；多人 ID 未对齐或同层多个 ID 仍待复核。平台实际索引的 ID 可确认自己的命名空间，平台 album 不升级成 MB 项目或压片。强 ID 可以确认部分专辑中的相应实体，不必凑齐整张专辑。
- 数据库 `finish` 在原 generation／输入／关联版本事务中发布候选、检查结构化证明与当前来源 ID、持久抑制及 preview 冲突，再确认并完成任务。自动确认只作用于 unresolved，不替换已确认身份、不恢复 detached、不清除拒绝。只有人工确认可明确重新采用。关联读回 `confirmation.mode`，历史另存自动规则和原证据，旧关联标 legacy。
- 本地完整性要求：64 轨以内、来源／标签未截断、同一实际文件目录、明确曲号／碟号及各自总数、无重复位置、所有碟和曲目齐全，标题／艺人／时长有音频标签、CUE 或人工来历。目录由 canonical source selector 在数据库内比较，仅输出不透明 cohort；旧快照仍不保存路径。跨目录（包括 CD1／CD2 分目录）、未知总数或仅 legacy 字段仍保留候选。
- 一页完整 MB 搜索后，最多浏览 4 个项目、总共读取 4 个完整 release，最坏 9 次请求。核实独立返回的 release 总数和每碟 track-count，逐轨比较位置、完整标题、全部有序艺人、原始小数时长（≤2 秒）、录音／release-track／人物／项目／发行 ID 及已知 ISRC。CUE 使用不含虚拟 PREGAP 的区间。远端 pregap／data-tracks 暂未纳入验证时记为不完整。超限、缺少可比较字段、分页未取全或响应无效均阻止自动确认。
- 多个压片匹配同一项目时可以确认项目；具体 release 即使只有一个完整曲序候选，也须条码／目录号匹配且在完整候选集中唯一，或另有已验证的明确 release ID。第四批只确认专辑层；第六批接入有独立证明的录音／人物关联，仍不改变手工版本和播放来源。
- 自动确认后，该实体其他旧 revision 的 queued 任务在领取时取消，running 结果在 finish 被拒绝。旧 `fetchAlbumTracks(): TrackData[]` 不能证明取全，原接口及调用方不变；平台的可选身份能力见第五批。

实现：[本地完整性与逐轨验证](D:/Project/Twilight_Echo/src/shared/musicAlbumValidation.ts)、[ID 证明与校验](D:/Project/Twilight_Echo/src/shared/musicIdentificationVerification.ts)、[MB 有界曲序获取](D:/Project/Twilight_Echo/src/core/library/musicIdentificationAlbum.ts)。

## 第五批：平台完整专辑身份与网易云接入

新增可选 `fetchAlbumIdentity(albumId, context?)`，同步 SDK、共享方法白名单、宿主实际 handler、Core 路由与生产接线。旧插件无需实现，旧 `fetchAlbumTracks` 和原生已索引 ID 的识别路径不增加任何前提。平台 matcher 升级会使旧算法任务与新输入分开，不复用旧搜索结果作为新证明。

- [身份 DTO](D:/Project/Twilight_Echo/src/shared/musicPlatformAlbum.ts) 为 v1，独立于 MB release DTO 和播放 Track：原生专辑／曲目 ID、完整标题、结构化有序艺人、服务独立总轨数、取全标志、原始精度时长、实际碟号／曲号、已知 ISRC。限制 64 轨及每组 64 个 credit；未知保留空值或 null，严格白名单拒绝额外载荷，不携带路径、URL 或凭据。
- 网易云复用 `/album` 和既有可匿名、可取消的请求出口。总数只取 size／songCount，冲突或未知不能证明取全；重复曲目 ID、缺轨、超限和歌曲的显式专辑 ID 不符均标不完整。曲序只读 no／cd，毫秒转换为小数秒；不使用展示 Track 的取整时长，不按返回数组顺序猜曲号，不把缺失碟号猜成 1。无名 credit 保留未知项，不静默丢掉合作人物。
- 搜索新增可选 `incomplete` 标志。网易云过滤无效项或没有独立 albumCount 时保留原显示总数合同，同时明确结果不能用于唯一性判断。Core 也检查搜索总数、重复 ID、截断和字段长度；一页 10 项之后最多 4 次详情请求。预算命中、任何可能匹配项缺少比较字段或取全依据时，整个集合保留待复核。
- [平台逐轨比较](D:/Project/Twilight_Echo/src/shared/musicPlatformAlbumValidation.ts) 复用本地单目录及显式总数约束，先由独立服务总数证明取全，再用实际连续碟号／曲号推导各碟数量。逐项比较完整标题、全部有序曲目艺人、可用专辑艺人、各碟总数、原始时长（≤2 秒）及本地已有 ISRC；合辑的 Various Artists 不代替曲目表演者。搜索展示艺人可以缩略，最终由完整结构化名单比较。
- 唯一完整匹配提供 `platform_album_tracks` 证明，数据库在原 finish 事务内重验当前来源与完整曲序后确认 **该平台的 release 引用**。这不证明具体压片，不制造 MBID／album_project；已有 MB 标签与平台原生 ID 不跨命名空间比较。多个同曲序平台专辑仍待复核，不采用搜索第一名。已有确认、拒绝和解除保持，不改本地播放源；子录音／人物在第六批按各自证据关联。

实现：[平台有界验证](D:/Project/Twilight_Echo/src/core/library/musicIdentificationPlatformAlbum.ts)、[网易云适配](D:/Project/Twilight_Echo/resources/plugins/ncm-provider/index.mjs)、[插件契约](D:/Project/Twilight_Echo/docs/twilight-echo-plugin-spec.md)。本批没有新增 SQLite 迁移，仍为 schema 16。

## 第六批：完整专辑到录音／人物的分层证明

只有本次完整专辑证明通过并自动确认父专辑后，数据库才在同一个 `finish` 事务中为实际成员生成子候选、逐层决定并保存历史。可靠 ID 快路径仍只确认自身层次；人工采纳有歧义的专辑候选也不隐式传播。

- 录音按已验证曲序的实际碟号／曲号对应远端录音 ID。人物先用目录 alias 的 `artistIndexes` 定位来源 credit，再核对原始标签的完整有序名单与远端结构化姓名／ID；不拆合作展示串、不把专辑艺人当曲目表演者，也不按位置配对未对齐的标签姓名和 MBID 数组。同名合作 credit 不能仅按位置分配人物 ID。
- MB 证明保存全部匹配压片。所有压片对子录音或人物 ID 一致且无缺项时，该层才可自动确认；ID 分歧生成待复核候选，某压片缺少 ID 也不能采用另一压片的 ID。父项目及其他明确子层仍可确认。旧证明若只保存多个压片 ID、没有全部内容，不取第一个压片传播。
- 只检查父专辑实际来源绑定的成员。子实体还有父专辑之外的来源时保留复核，不做全库同名关联；无关同名人物完全不触碰。平台身份 DTO 的曲目服务 ID 转成原有 recording 引用格式 `provider:id`，例如 `101 → ncm:101`，与已入库平台歌曲复用目标；人物和专辑仍使用各自的原生 ID。加前缀后超出既有 512 字符引用上限时，跳过该子身份并记录原因，不阻塞有效父专辑或其他成员。
- 领取任务时有界捕获最多 **200** 个子实体的独立输入版本和关联 revision，提交时逐个重验。子实体改了又改回、人工确认／拒绝／解除或有效来源变化，只跳过或阻止对应子层，不废弃仍有效的父专辑和其他成员。缺少某层 ID 也只影响该层。
- `album_member` 证明引用父专辑的不可变确认历史及关联 revision，原始验证内容只保留在父历史。普通适配器提交这个证明不能触发自动采用。父解除、重新关联或输入变化后，未确认子候选的预览报告过期；已经独立确认的子身份不随父解除级联删除。
- 原父任务的 `identification.members` 返回每个成员的 `confirmed / needs_review / skipped`、candidateIds 和原因，`membersTruncated` 报告捕获上限。父子候选、关联、历史及任务完成同事务提交，任何子写入失败全部回滚。复用原队列及现有远端响应，不新增 HTTP 请求或迁移，SQLite 仍为 schema 16。

实现：[成员证明与提议](D:/Project/Twilight_Echo/src/shared/musicAlbumMembers.ts)、[身份事务](D:/Project/Twilight_Echo/src/main/library/libraryDatabaseIdentification.ts)、[任务领取／完成](D:/Project/Twilight_Echo/src/main/library/libraryDatabaseEntityMetadata.ts)。身份关联不物理合并来源、不搬移人工值；介绍、图片及 credits 的获取与合成仍按 M2.3 接入。

## 第七批：真实入库增量、历史回填与自动识别设置

本地目录投影和平台真实成员发布现在通过 SQLite 事务记录待调度实体，Core 无窗口推进，身份任务仍只在原 `metadata_jobs/metadata_demands` 执行。

- 新增 `metadata_identification_schedule` outbox 与状态表。输入版本及真实 membership 的触发器在原事务标记受影响实体，不逐首重复调度人物。平台 staging 未 commit／abort、本地 pending 或历史目录投影未完成时等待；搜索缓存和未发布成员不进入自动识别。
- 每次最多处理 **200 个实体**，只为当前实际成员且有非 missing 来源、尚未 confirmed／detached 的实体调度允许的适配器。输入版本、配置、需求和进度同事务保存，任何写入失败整笔回滚。重复扫描不重排；开历史或增加另一供应商不重跑未变化供应商的已完成任务。
- 历史首次启用时保存 catalog 实体 rowid 的起始上界，按单调游标枚举真实成员，不使用 OFFSET 或读取全库 Track。暂停、Core 重启与数据库 worker 替换后沿原 cursor／horizon 继续；后来新增实体走增量，不扩大这次历史上界。
- 每个 outbox 实体持有私有随机 demand ID。移出库、关闭自动识别或移除来源选择，只撤销对应自动消费者，保留人工及其他共享消费者。公共调用者既有的 `auto:*` batchId 仍按显式需求处理。已完成回执不改写成取消。
- 领取顺序为人工／当前详情 → 自动新入库 → 历史，同一自动层级中专辑先于成员。每第 4 次领取，等待至少 60 秒的纯自动任务获得一次优先机会。领取前和提交时检查实际成员；在途关闭设置或移除最后成员不能发布纯自动结果，途中加入的人工共享需求仍按显式合同处理。
- 服务启动、目录发布、供应商清单及设置变化唤醒调度，另有 5 秒数据库对账兜底。配置关闭可中止纯自动 HTTP，恢复 running generation 后对账；窗口关闭不撤销持久需求。

### 在现有 Core 设置中开启

`AppSettings.musicIdentification` 默认如下，保存在原 `settings.json`，没有第二份设置权威：

```json
{ "newImports": false, "history": false, "sources": ["musicbrainz"] }
```

先用 `settings.state({})` 读取当前 revision，再通过 `settings.edit`（`settings:write`）提交以下 payload；示例中的 `revision` 使用刚读到的值：

```js
const payload = {
  revision,
  patch: {
    musicIdentification: {
      newImports: true,
      history: false,
      sources: ['musicbrainz', 'platform.ncm']
    }
  }
}
```

`newImports` 控制增量自动识别；`history: true` 开始或恢复持久历史回填。`sources` 为识别适配器 ID，最多 16 个，去重并过滤 URL；`platform.ncm` 仍要求该平台实际启用且支持对应能力。这些选择只控制自动识别，不给旧 `identification.start` 或人物 resolve／enrich 增加新前提。

自动开关不能越过原部署 `TWILIGHT_METADATA_ENABLED`、MB 公共服务许可与应用联系地址要求；平台识别不要求 MB 许可。介绍语言随 M2.3 正文消费接入，原设置页入口随 M2.5 接入。

`identification.status({})`（`library:read`）返回 `{ pending, history: { cursor, horizon } }`。pending 是尚待处理的 outbox 实体数，不是远端任务总数；cursor／horizon 是持久扫描位置，不代表资料已补齐的数量。执行结果仍从 `metadata.entity.jobs` 和分层身份接口读取。

实现：[自动设置与状态 DTO](D:/Project/Twilight_Echo/src/shared/musicIdentificationSchedule.ts)、[事务调度与历史游标](D:/Project/Twilight_Echo/src/main/library/libraryDatabaseIdentificationSchedule.ts)、[Core 调度接入](D:/Project/Twilight_Echo/src/core/library/entityMetadataService.ts)。实体内任务去重由持久队列负责，跨实体响应共享由第八批接入。

## 第八批：同查询共享响应，逐实体校验证据

导入许多标注同一歌手的文件时，各来源人物仍独立存在，但不再串行重复请求同一页搜索。Core 的[识别响应缓存](D:/Project/Twilight_Echo/src/core/library/identificationResponseCache.ts)同时覆盖在途共享和短时结果复用，原公共 HTTP 层继续拥有 host 预算、大小限制和 Retry-After。

- 缓存键为供应商、使用／配置上下文、方法和完整参数。MB 保留完整 URL、实体端点、分页、查询及请求格式；平台保留方法、原查询、limit／offset 和不含凭据的会话上下文。只复用完全相同的查询，不为提高命中率合并姓名、大小写或不同账号。
- 每个缓存池最多 **128 项／8 MiB**，单响应最多 **2 MiB**。有效结果保留 5 分钟，明确空结果与单 ID 的 404 保留 60 秒；命中不延长有效期，LRU 超限逐项淘汰。超大响应仍按原接口返回，只不保留。HTTP 错误、取消、无效页结构和无效平台专辑 DTO 不产生可复用完成项，原重试和限流继续生效。
- MB 的有类型 ID、搜索、项目发行列表和完整发行响应均可共享；平台歌曲／人物／专辑搜索及可选 `fetchAlbumIdentity` 可共享。平台搜索先投影成识别所需标量字段，不缓存 Track 中的播放 URL、文件路径、歌词或凭据。
- 每个消费者取得独立副本及原始 retrievedAt；候选生成、完整曲序验证、来源 ID、版本、拒绝／解除与 finish 事务仍逐实体执行。缓存不保存候选、匹配结论或确认状态。原搜索总数、缺项和截断标记继续参与唯一性判断，复用不会把待复核变成已确认。
- 一个消费者取消只解除自身等待，最后一个离开才中止共享 I/O；即使远端忽略取消，迟到响应也不能写入缓存。资料源上下文失效会中止该来源全部等待者并清除对应完成项，其他来源不受影响。
- [插件管理器](D:/Project/Twilight_Echo/src/core/plugins/manager.ts)在登录／退出、插件设置写入／删除、安全 QR 凭据变更和重新注册时推进不含凭据的会话 revision。生产 Core 将它纳入平台上下文；变化时清除该平台响应、取消受影响的在途识别并恢复 generation，再按新上下文执行原持久需求。

缓存只在当前 Core 会话内保留，重启后原 SQLite 需求及游标照常恢复，需要的响应重新读取；缓存不是第二个任务或身份权威。本批没有新增公共权限、UI、数据库表或 schema 迁移，仍为 schema 17；原 Track 补全、显式识别和人物接口保持原入口与条件，自动识别仍默认关闭。

实现：[识别适配器](D:/Project/Twilight_Echo/src/core/library/musicIdentificationProvider.ts)、[MB 专辑消费](D:/Project/Twilight_Echo/src/core/library/musicIdentificationAlbum.ts)、[平台专辑消费](D:/Project/Twilight_Echo/src/core/library/musicIdentificationPlatformAlbum.ts)、[Core 恢复与生产接线](D:/Project/Twilight_Echo/src/main/coreProcess/entry.ts)。

## 迁移与旧接口

SQLite 第一批升至 schema 14，第二批为 schema 15；第四批升至 schema 16，新增 canonical source selector 的单调输入栅栏和按关联查询历史的索引，第五／六批沿用此 schema。**第七批升至 schema 17**，增加自动识别 outbox、游标与事务触发器。移动目录再移回也使旧候选失效。升级前沿用 `VACUUM INTO` 一致备份，DDL 失败整笔回滚。M2.1 目标 UUID、事实、人工值、旧关联历史、任务 generation 和批次需求保持；有效旧待复核任务投影到通用候选，已过期的依据不会在迁移时被刷新成可确认候选。

新增表为外部引用、分层关联、候选、抑制、关联历史和单调输入版本，以及目录的发行／项目关系。`metadata_entities` 旧 provider／external_id 列仅保留创建来历，不再承担身份查找或供应商准入。原人物接口通过同一身份仓库写入关联，不产生第二个关联权威。

`metadata.entity.resolve/decide/enrich/detail/override/detach` 保持原明确 MBID 用法。新复核接口消费旧候选时，同事务完成对应旧任务，不留下另一份待复核状态。已确认平台人物没有 MB 引用时，百科 enrich 明确返回尚未关联，不制造 MBID。目标之后获得可核实 MB 引用时，其其他来源人物也能沿用原 enrich 路径。原 Track metadata API 不变。

## Core 消费入口

| 操作 | 输入 | 权限 |
|---|---|---|
| `identification.start` | entityId、稳定 batchId；返回 batchId、jobs | library:write |
| `identification.status` | 空对象；返回 pending 与 history cursor／horizon | library:read |
| `identification.detail` | entityId | library:read |
| `identification.candidates` | entityId，可选 state／offset／limit（最多 100） | library:read |
| `identification.preview` | candidateId、revision、linkRevision | library:read |
| `identification.decide` | 同上及 confirm／reject | library:write |
| `identification.detach` | linkId、revision | library:write |

候选生产使用私有 Core → 数据库的 `identificationEnqueue/Input/Publish`、`identificationSchedule` 和原任务 claim／finish；识别请求不能上传供应商响应、外部引用、供应商列表或任意网址。自动来源选择仅通过原 settings 写权限修改。原 M2.1 明确 ID 查询的候选也可从新分页入口读取。可靠 ID、完整专辑及其录音／人物的分层确认和入库调度已接入；界面消费仍待接入。

## 验证与继续条件

测试入口：[身份及迁移测试](D:/Project/Twilight_Echo/src/core/library/musicIdentification.test.ts)、[真实扫描 worker 测试](D:/Project/Twilight_Echo/src/main/library/libraryScanService.test.ts)、CUE 派生、原人物测试、Core dispatch 和真实数据库 worker 替换测试。身份测试已加入 `test:core`。生产 headless fixture 增加项目及通用身份查询，使用实际带人物／专辑标签的 fixture。

第一批（schema 14）的验证记录：

- `test:core`：**647 项通过**，含新增 12 项通用身份／迁移测试。
- 受影响的主库、历史 schema 迁移、目录及真实 worker 测试：**158 项通过**。新增新旧复核联动后，真实 worker 的人物资料／替换测试也已针对性通过。
- Node／Web 类型检查、三个新增 TS 文件的 ESLint、`electron-vite build` 通过。完整数据库套件此前仍有 23 项失败（见 M2.1 记录），本批未重跑完整套件。

第二批依据采集的新增验证：`test:core` **653 项通过**（身份测试现为 18 项），真实扫描／CUE **26 项通过**，队列与历史队列迁移 **56 项通过**。固定 FLAC Vorbis-comment 样例经过实际 worker，检查 MB ID 类型、Various Artists、ISRC、条码和小数时长；同一音频的 CUE 子轨检查区间精度及父录音 ID 隔离。另覆盖 ID 改后恢复、手工分组往返、截断来源以及 schema 14 → 15 成功／DDL 失败回滚。Node／Web 类型检查、新增两个 TS 文件 ESLint 与 `electron-vite build` 通过。

第三批召回验证：`test:core` **678 项通过**，其中新增 [召回测试](D:/Project/Twilight_Echo/src/core/library/musicIdentificationRecall.test.ts) **25 项**，包含四层 ID、错误类型、多人／Various Artists、部分专辑、搜索截断、原始精度时长、共享取消、配置栅栏、拒绝后再查，以及领取／完成／start 回执丢失对账。Core dispatch＋召回＋网易云组合 **127 项通过**（追加的 4 项对账测试另已通过并纳入 678 项）；人物资料与通用识别的真实数据库 worker 重启组合 **2 项通过**。本批不重复真实服务联网抽样。

第三批最终 Node／Web 类型检查、涉及的 7 个身份／召回 TS 文件 ESLint 和 `electron-vite build` 通过。SQLite 仍为 schema 15，本批复用原任务表，没有新增迁移。

第四批验证：`test:core` **725 项通过**，含新增[自动确认及整专辑测试](D:/Project/Twilight_Echo/src/core/library/musicIdentificationAlbum.test.ts) **47 项**。覆盖四层明确 ID、平台原生身份、同曲序多压片、条码唯一发行、两个不可区分项目、缺轨／未知总数／混合目录、多碟与 CUE 区间、完整艺人及 Various Artists、版本／时长／ISRC／ID 冲突、分页和请求预算、远端截断／无效 credit、取消、原子回滚及重启、人工抑制和外部目标冲突。schema 15 → 16 的备份、成功迁移和 DDL 回滚均有固定样例。

真实数据库 worker 的人物、通用识别及新增原生自动确认／解除／替换恢复组合 **3 项通过**。受影响迁移定向检查先有 31 项通过；未来 schema 拒绝样例更新为 17 后单项通过，复用其余未变化样例的有效结果。初次 Core 并发运行有一项既有网络任务等待超时，该文件单独 9 项及最终完整 725 项均通过，未改动网络任务实现。Node／Web 类型检查、身份相关 9 个 TS 文件 ESLint 和构建通过。日志保存在 ignored `tmp/identification-auto-*.log`。

第五批验证：完整 `test:core` **770 项通过**，新增平台完整专辑用例 **45 项**，覆盖唯一匹配、旧插件及原生 ID 兼容、缺总数／轨序／时长／艺人、无名合作 credit、重复 ID／位置、版本与小数时长边界、ISRC、多碟、合辑、多个同曲序专辑、未知搜索总数与请求上限、取消、人工决定重启保留、finish 原子回滚及当前输入重验。首次组合中新增原生兼容 fixture 错把平台轨写入本地文档入口，改用实际 catalogSync 后单项及完整 Core 均通过。

网易云真实插件的可选方法、旧播放方法兼容、取全与原始字段、无总数／过滤行标记、无效响应和实际请求取消，以及宿主方法路由测试通过。另以固定 HTTP 响应运行 **实际 NCM 插件 → Core 平台适配器 → 真实数据库 worker → 替换恢复**，验证平台专辑自动确认、原始小数时长保留及本地来源不变；这是协议／恢复集成证据，没有将 fixture 当成真实服务覆盖率。Node／Web 与 SDK 类型检查、相关 11 个 TS 文件 ESLint、`electron-vite build` 及 diff 空白检查通过。日志保存在 ignored `tmp/identification-platform-*.log`。生产 Electron 门槛仍见下述环境依赖。

第六批验证：完整 `test:core` **798 项通过**，相对第五批新增 **28 项**分层关联用例。覆盖 MB 单／多压片逐子 ID 一致、冲突、缺项和旧证明，结构化合作名单与同名 credit、标签姓名／ID 不对齐、合辑及无关同名人物，子来源超出专辑，独立输入往返与人工拒绝／解除／另选目标，父证明过期，伪造子证明不能自动确认，目标命名空间冲突，子写入失败全事务回滚及幂等重放，最多 200 子快照与截断。另验证本地录音复用既有 `ncm:101` 流媒体目标，以及服务 ID 加前缀后恰好达到／超出引用长度上限时只影响对应子层。

扩展的 **实际 NCM 插件 → Core → 真实数据库 worker → worker 替换恢复**用例通过：父平台专辑与 4 个子实体自动确认，录音引用沿用 `ncm:101 / ncm:102`、人物引用为 `7`，任务成员结果及子关联重启后保持，本地播放来源不变。Node／Web 类型检查、涉及的 10 个 TS 文件 ESLint、`electron-vite build` 与 diff 空白检查通过。Core 与构建日志位于 ignored `tmp/identification-members-*.log`；本批没有新增 HTTP、队列或 schema 迁移。

第七批验证：当前工作区完整 `test:core` **942 项通过**，本批新增[调度测试](D:/Project/Twilight_Echo/src/core/library/musicIdentificationSchedule.test.ts) **19 项**。覆盖默认关闭与设置持久化、本地真实目录／平台 staging 和 abort、重复扫描及输入往返、240 实体历史分页与上界、暂停／重启恢复、事务失败回滚、成员移除与共享取消、在途配置／成员栅栏、公共 auto 前缀兼容、优先级及历史防饥饿、配置变更不重跑完成任务、v16 → 17 备份／DDL 回滚、进度接口、Core 自动调度与回执丢失对账。实际平台适配器还验证已保存网易云原生歌曲／人物无需 MB 许可即可自动确认。

真实数据库 worker 替换用例与优先级组合 **2 项通过**，其中替换用例验证持久自动需求、cursor／horizon、running generation、拒绝旧 work 和恢复完成不重建任务；定向迁移 **12 项通过**。Node／Web 类型检查、相关 TS 文件 ESLint 和 `electron-vite build` 通过；收尾的派发／设置定向 **2 项通过**。日志位于 ignored `tmp/identification-schedule-*.log`。

生产 Electron 门槛仍未通过：本机 `--version` 在业务 JS 前以 `EXCEPTION_BREAKPOINT` 退出。断点反汇编对应 Chromium sandbox 初始化的 alternate window station 创建检查；独立 Win32 探针在相同窗口站 DACL 下调用 `CreateWindowStationW`，两种请求权限均返回 **Win32 5 / ERROR_ACCESS_DENIED**。未关闭沙箱或更换运行时。需要在窗口站创建权限正常的桌面执行环境恢复原 `node --test scripts/core-headless.test.cjs` 验收。

第八批新增[共享响应测试](D:/Project/Twilight_Echo/src/core/library/musicIdentificationSharing.test.ts) **16 项**和[平台上下文测试](D:/Project/Twilight_Echo/src/core/plugins/providerIdentityContext.test.ts) **5 项**，均已加入 test:core。固定 100 个同查询实体分别只发一次 MB／平台搜索，证据各自生成；两份同名完整专辑复用 MB 搜索／项目浏览／发行详情共 3 次请求，或平台搜索／详情共 2 次请求，曲序冲突的一份保持未确认。另覆盖正负缓存时效、LRU／字节限制、副本与获取时间、错误不缓存、共享取消、忽略取消的迟到结果、人工拒绝、账号切换、插件重注册及在途 generation 恢复。

最终验证：Core **963 / 963** 通过；Node／Web 类型检查、相关 TypeScript ESLint 和生产构建通过。共享响应没有新增公共权限、数据库 schema 或第二个任务队列。

接下来进入 M2.3，接入介绍语言、百科／平台正文、图片及 credits；原设置页与 TaskCenter／收件箱在 M2.5，流派分类和个人评分仍由各自后续工作包交付。生产 Electron 继续由上述原检查收尾。
