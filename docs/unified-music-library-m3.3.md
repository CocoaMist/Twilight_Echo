# M3.3：专辑发行、播放版本与统一选源

2026-10-24。功能已接入实际页面和生产 Core；人工内容、真实桌面、主题／键盘及打包验收按用户安排后置。schema 仍为 22。

## 从原专辑页使用

本地和流媒体专辑页共用 `EntityMetadataPanel`，其中新增“发行与音源”：

- 专辑项目 → 具体发行／待识别本地专辑 → 库内音源。默认当前发行，发行每页 6 项、音源每页 20 项。
- 资料发行按来源的 physical `release_id` 和已确认资料身份组织；同名、ISRC、版本族不构成合并依据。不同压片即使同属人工播放版本，仍保留不同发行。
- 人工专辑播放版本、版本族及其自身的资料关联单独显示，身份冲突提示复核；资料识别不改写原手工版本服务。人工关系横跨多个项目时分别保留，不造共同项目。
- “明确播放此音源”仍调用原 `catalog.play`；“统一播放此曲”调用新 `catalog.playUnified`。原分类浏览来源区也提供这两个独立入口。
- 逐曲统一播放只读取原 `tracks` 明确等价及偏好，不从专辑关系猜歌曲对应关系。原版本管理按首选专辑来源读取整张专辑曲目的播放入口继续保留。
- 来源顺序可在页面选择默认／本地优先／流媒体优先，仅作用于当前页面的统一播放。人工首选来源优先于供应商顺序。平台列表超过 128 时保留总数、禁用不能完整表达的流媒体优先选项。

当前只枚举实际库内发行；外部发行列表能力标为不可用。浏览不增加成员，也不触发联网补全。

## 统一播放先准备，再提交一次

1. 以 opaque source ID 锚定曲目，读取原手工 track version 和族内首选版本。
2. 在选定播放版本内，按首选来源、用户供应商顺序、首次实际目录成员发布时间、稳定 source ID 排序。无明确等价关系只尝试锚定来源。
3. 专辑和分类入口携带冻结查询范围；数据库重新判定候选归属。筛选为本地／具体规格或具体发行时，来源偏好不能越过该范围。
4. 每个候选最多准备一次，走原供应商输入解析、本地访问／媒体授权、URL 有效期和 source lease 链。准备失败可尝试同一播放版本的下一来源，保留各自原因；权限拒绝、取消、修订或范围失效立即停止。
5. 准备完成后再次校验版本、成员、冻结范围和有效期，再提交一次队列。native 提交失败保留原失败路径和所选来源，不跨版本重试，不在播放中途换源。

新增 `CorePlaybackSession.fromUnifiedTrack` 复用原 stage/load 提交链；旧 `fromTrack` 与明确来源操作保持原含义。统一准备失败不替换正在使用的队列。外层 source lease 覆盖准备到提交，避免嵌套 lease 及维护 barrier 相互等待。

### 入库顺序使用真实发布记录

原 `Track.addedAt` 不作为目录成员加入时间。既有 `catalog_state` 中的 `membership_added:<sourceId>` 记录来源首次实际目录成员发布时刻；只有本地成员发布／平台 commit 写入，append、缓存和取消不写。复扫、重投影、移除后重加保留首次值。

升级前缺少历史的成员保持 unknown，不填写升级时间，也不借用文件／平台日期。未知时间最后使用稳定 ID。记录与成员发布同事务持久化，无新增 DDL；后续 M5 备份／恢复需保留或明确映射该记录。

复扫回归还修复了源 UPSERT 与分类 pending 触发器冲突：已存在来源明确 UPDATE，新来源 INSERT，重复导入不再触发 pending 唯一键错误。

## 接口与失效处理

- 公共读：`albums.browse`、`albums.sources`，权限 `library:read`；分页上限 200。
- 新播放：`catalog.playUnified`，权限 `playback:write`，另检查库读取及实际候选需要的 `providers:call`。纯本地播放不新增平台权限前提。
- 私有 worker：`albumsContainsSource`、`genresContainsSources`、`catalogPlaybackSources`。source key、本地路径和平台授权上下文不进入新增公共 DTO。
- 原 worker/client、Core application、生产 entry、公共校验和 renderer 调用均已接线；只读请求不写成员。
- 沿用完整 token：genres/catalog/content/metadata 修订、冻结时钟、过期点和不透明账号上下文。分页、候选准备后及提交前重新校验。页面在修订、账号变化或到期时撤下结果／计数，保留选择并要求明确重读；取消及迟到响应不回填旧页面。

## 自动化证据

以下记录有部分覆盖重叠，不相加作为独立测试总数。

| 检查 | 结果与记录 |
|---|---|
| 专辑仓库／身份分层／分页／到期 | 13/13，`tmp/m3.3-album-browse-repository.log` |
| 原 catalog＋成员时间／事务／重开 | 15/15，`tmp/m3.3-membership-publication.log` |
| 统一版本选择／等价回退／范围 | 12/12，`tmp/m3.3-unified-service.log` |
| 新 session 准备路径及旧显式／recovery／transport | 新增 6 项及旧路径定向回归，`tmp/m3.3-unified-final-tests.log` |
| 原授权链拒绝与缺失区分 | 17/17，`tmp/m3.3-unified-authorization.log` |
| 专辑 VM／编译 Vue 及原资料入口 | 22/22，`tmp/album-versions-ui-tests.log` |
| 分类统一播放 VM | 10/10，`tmp/m3.3-genre-ui.log` |
| 分类编译控件／新播放按钮 | 原 5 项及新增 1 项，`tmp/m3.3-genre-controls.log`、`tmp/m3.3-genre-unified-controls.log` |
| 私有分类冻结范围／原仓库 | 18/18，`tmp/m3.3-root-repository.log`；其中私有来源最新实现由下一行覆盖 |
| 最终私有来源＋真实数据库 worker | 3/3，`tmp/m3.3-playback-worker-final.log` |
| 真实 Core dispatch／权限及原明确来源入口 | 2/2，`tmp/m3.3-core-dispatch.log` |
| Node 类型 | 通过，`tmp/m3.3-node-final.log` |
| 定向 ESLint | 通过，root final、album、membership、unified 各 `tmp/*lint.log` |
| 全局 Web 类型 | 仍有 `DspSignalOverview.vue` 原有 10 个诊断，本批文件无诊断，`tmp/m3.3-web-final.log` |

新增测试已加入原 `test:core`／`test:library-database`，未创建另一个测试平台。

## 下一步

继续 M4 的录音／发行独立个人评分、资料评分机制，再推进偏好／收藏、标签与 Focus。M2.6 人工样本和 M3 真实页面验收仍待进行；未将整个 M3 或 M1—M5 标记验收完成。本批未运行生产构建或打包；原 Electron sandbox 窗口站权限依赖未变。
