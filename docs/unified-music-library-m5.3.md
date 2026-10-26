# M5.3：全库只读对账与混合音乐库性能

2026-10-25。全库只读对账、真实数据库 worker 的后台任务读取探针，以及默认收藏 occurrence 修复已接入。十万条原轮与同库复测均已完成：本地分页和后台读取显著改善，Catalog／Genre／Focus 仍有秒级延迟，**M5.3 性能尚未通过**。worker 曾观测到 28.49 秒打开耗时，完整健康检查与启动分段诊断见下。schema 29 已修复旧文件日期补读的窄合并与取消合同。人工内容与实际桌面／键盘／主题／Windows 包验收仍按用户安排后置。

## 对明确选择的数据库生成报告

在项目目录运行；以下输入、输出路径是示例，换成明确选取的文件：

```powershell
Set-Location 'D:/Project/Twilight_Echo'
node --experimental-strip-types scripts/music-library-reconciliation.ts `
  --database 'D:/SelectedProfile/music-library.sqlite' `
  --core-state 'D:/SelectedProfile/core-state.sqlite' `
  --examples 10 --output 'D:/Reports/music-library-audit.json'
```

也可使用已注册的 `audit:music-library` 脚本。工具只读 schema 28／29，不执行升级、回填、联网或磁盘／账号探测。输出文件必须不存在；可以省略 `--output` 写 stdout。

优先以生产 `--core-state` 对照 `core_state` 的 versions 域及真实 revision。若只核对备份快照，改用 `--versions <json>` 和可选 `--versions-revision <n>`，报告会标为 `snapshot`。两种输入互斥；未提供版本输入则明确保留首选版本跨存储未核对的缺口。两个数据库各有自己的只读一致快照；编辑版本期间出现暂态差异，等正常发布完成后重跑。

报告的 `checks` 给出完整 SQL 计数和有界 ID／状态样例，默认 10 条、最多 100 条，`--examples 0` 仍计算全量。样例不输出正文、图片或会话 URL；没有把全库 Track DTO 读进 JS。版本权威读取另受 8 MiB／60,000 行预算约束。

先看 `summary.state`：

- `needs-repair`：存在结构、值域或引用错误，CLI 返回 2；按具体检查定位，不自动修复。
- `needs-review`：没有 error，但有待索引、未归属资料或覆盖缺口，CLI 返回 0。
- `consistent`：本次检查范围内没有 error／pending。

`errorChecks` 和 `pendingChecks` 是非零检查类别数，类别可能交叠，不能相加当作受损歌曲数。合法离线引用、非成员目录缓存、明确清空、身份解除和旧收藏重复 occurrence 分列保留状态，不误报为损坏。

## 核对成员、个人整理和资料引用

实现见 [对账模块](D:/Project/Twilight_Echo/src/main/library/libraryDatabaseReconciliation.ts)和 [CLI](D:/Project/Twilight_Echo/scripts/music-library-reconciliation.ts)。

- 实际成员、多个 owner 的来源并集、缓存非成员、本地待索引与真正缺失的 tracks 权威。
- 精确 provider／来源键／Track 映射、录音别名、实体种类、专辑项目分层及 SQLite 外键。
- 个人评分及明确清除、`none / favorite / ban`、相关历史与稳定实体目标。
- 默认收藏保存的顺序、重复及离线 occurrence，偏好覆盖后的保留顺序和新增 favorite 候选身份；标签成员和流派引用。
- 手工版本、版本族与首选关系，以及给定版本权威与目录投影的 revision／ID／来源／首选差异。
- 人工介绍、图片、资料首选、身份解除及 Rhine 精确正文出处、旧 ID 未归属与已有冲突。

默认收藏报告没有物化最终追加列表，候选身份数不等于最终追加 occurrence 数；普通歌单不在本报告范围。没有迁移前的真实基线时，也不据此宣称完成迁移前后全量一致性证明。当前尚未选择或读取用户生产曲库。

## 用真实入库与查询方法复现十万条负载

```powershell
Set-Location 'D:/Project/Twilight_Echo'
node --expose-gc --experimental-strip-types scripts/benchmark-unified-music-library.ts `
  50000 'D:/Reports/music-library-100k.json'
```

已注册等价的 `benchmark:unified-music-library` 脚本。`50000` 是每种来源的数量：50,000 本地、50,000 平台成员，另有 1,000 条缓存非成员。默认记录每项首次调用和 3 次后续采样；`MUSIC_BENCHMARK_ROUNDS` 可设为 1—10。临时数据库通过生产入库与维护方法建立，正常结束时清理自身临时目录；不读取真实音频或账号。

fixture 中 5,000 对来源有明确的合成 recording 身份关联，因此 Catalog／Genre 按原播放绑定计 100,000 条库内录音，而 Focus 按已确认资料身份计 95,000 条。Jazz 分别为 50,000 和 47,500。这个计数差异来自既有合同，不是丢数据或同等工作量的性能对比。部分身份通过有效 SQL fixture 建立，未冒充真实在线识别结果。

runner 按精确预期核对总数、50 条有界返回、末页 offset、目录 scope、评分、禁播、专辑标签和分面，再保存实际生产 SQL 的 `EXPLAIN QUERY PLAN`。同机原 `queryTracks` 是仅本地 50,000 条的基线，新统一查询覆盖混合来源；首项调用仍可能复用前面步骤与 SQLite／系统缓存，不叫冷启动。报告中 RSS／heap／external 和进程 peak RSS 属于 benchmark 父进程，不是含 worker／Electron 的全应用内存。

同库复测支持 `--reuse-fixture=<已有合成库的绝对目录>` 和 `--ingestion-evidence=<原入库报告>`：以 query-only 模式核对库存并运行查询，不重新入库、不执行 worker 写入，也不删除该目录。本次 worker 在查询进程结束后另行串行运行，留下 2 个 completed jobs 和 1 个 fact。继续复用此库需显式传入 `--expected-completed-metadata-jobs=2 --expected-metadata-facts=1`，runner 按实际任务状态及事实数核对并单列库存；默认仍期望 0，不能删除任务来伪装初始状态。

生产构造发生在 `query_only=ON` 之前，可能升级 schema 并生成备份，不是只读连接。runner 另存 `fixture.schema.beforeOpen/afterOpen/upgradedOnOpen`；本轮最终报告为 29→29，没有首次升级。此前 v28 备份保留，不据此推断升级发生者。重跑上述 post-worker 库的命令为：

```powershell
node --expose-gc --experimental-strip-types scripts/benchmark-unified-music-library.ts `
  50000 'D:/Reports/music-library-100k-follow-up.json' `
  --reuse-fixture=D:/Project/Twilight_Echo/tmp/m5.3-retained-100k `
  --ingestion-evidence=D:/Project/Twilight_Echo/docs/audit-evidence/m5.3-unified-library-100k.json `
  --expected-completed-metadata-jobs=2 --expected-metadata-facts=1
```

## 同库复测有改善，交互性能仍未通过

[原轮完整报告](D:/Project/Twilight_Echo/docs/audit-evidence/m5.3-unified-library-100k.json)记录 50,000 本地＋50,000 平台成员及 1,000 缓存非成员。入库共 308.24 秒；查询、全库对账和真实 worker 探针均执行完成。对账 `errorChecks=0`，外部 HTTP 为 0，队列与曲库 revision 不变；交互延迟仍不达标。

[查询 checkpoint](D:/Project/Twilight_Echo/docs/audit-evidence/m5.3-unified-library-100k-checkpoint.json)、[分类／流派候选](D:/Project/Twilight_Echo/docs/audit-evidence/m5.3-unified-library-100k-selective.json)及上一轮 [Focus 分页投影](D:/Project/Twilight_Echo/docs/audit-evidence/m5.3-unified-library-100k-focus-page.json)均复用原合成库，完成精确库存、查询语义及对账断言，外部 HTTP 为 0。后两轮保留真实任务库存。下表为截至分页投影轮的三次后续采样 p50；首次调用另存。三样本的 p95 等于最大样本，不能据此判断长尾稳定性。

| 操作 | 原轮 p50 | checkpoint p50 | Focus 分页投影轮 p50 |
|---|---:|---:|---:|
| 原本地分页首屏，50,000 条 | 4,775.59 ms | 71.92 ms | 74.52 ms |
| Catalog 首屏，100,000 条 | 1,377.38 ms | 1,414.38 ms | 1,348.66 ms |
| 爵士流派首屏，50,000 条 | 27,811.32 ms | 4,527.10 ms | 3,550.29 ms |
| 流派格式分面 | 37,690.12 ms | 7,793.44 ms | 7,045.59 ms |
| Focus 首屏，95,000 条 | 16,821.84 ms | 8,629.04 ms | 5,209.95 ms |
| Focus 爵士筛选，47,500 条 | 21,864.43 ms | 10,990.36 ms | 8,441.18 ms |
| Focus 平台分面 | 34,471.25 ms | 4,326.75 ms | 4,743.69 ms |
| 同项目发行首屏，60 个发行 | 4,143.68 ms | 1,522.91 ms | 1,660.15 ms |
| 发行来源入口，含先读取发行页 | 7,982.21 ms | 3,583.89 ms | 4,433.46 ms |

分页投影轮的 Catalog 首屏需 1.35 秒，深页 2,177.35 ms；Genre／Focus 仍不足以交互验收。该轮 Focus 将仅用于显示的年份、返回来源排名和 sourceCount 后移到实体分页之后，完整匹配、准确总数、年份筛选／排序及播放含义不变。与分类候选相比，Focus 首屏 7,847.27→5,209.95 ms，深页 9,229.50→7,330.10 ms。其他未改查询的跨轮波动不全部归因于这项优化。

真实两条 completed 任务的资料任务页在分页投影轮 p50 为 2,976.10 ms，前一个分类候选为 2,708.93 ms；与 checkpoint 的空任务页工作量不同，不能相除判断退化。这个约三秒的两任务页已单独定位并修复，见下节。原轮父进程 peak RSS 为 1,735,112 KiB，checkpoint 为 247,556 KiB，分页投影轮为 227,696 KiB；原轮含入库高峰，后两轮没有该轮入库，不能据此推断纯查询内存降低相同比例。checkpoint 打开与库存核对耗时 17.09 秒，分页投影轮为 1.07 秒；原轮 308.24 秒入库只在 `ingestionEvidence` 中关联，没有重复测量。

本次正式复测已消费以下修复，生产临时存储配置仍为 `temp_store=FILE; temp.cache_size=-8192`：

- **有界页资料引用**：从本页的精确 provider／Track ID 开始索引查找，只展开选中来源的录音、发行、人物与项目；避免读取一个 Track 也物化全库 UNION 引用视图。保留重复 occurrence、总数、手工版本和原有返回上限。
- **发行与来源页**：关系物化只携带必要列；一次 SQL 同时生成页、准确总数、项目标题和当前发行，来源详情只展开有界页。空页或超过末页仍保留完整标题、总数与 provider 统计，不通过删字段或改变身份／播放版本含义换速度。
- **Genre／Focus**：按实体种类及实际请求维度缩小关系和字段，合并 total／page／facet 的重复构图；只为有界页读取来源 payload，保留身份分组、同源条件、人工清空、许可与到期语义。SQL 捕获改为记录首次真实调用，不再为取得计划重复执行整次查询。
- **本轮分类与流派**：Classification 只生成请求维度所需的资料实体层／字段，无相关事实时不展开映射；普通流派有效值不再强制物化完整目标层关系，仍保留人工明确清空、source／external 优先级及来源级匹配。
- **本轮 Focus 页内投影**：完整 matched groups 负责计数和筛选；返回页的全部匹配来源负责来源排名、数量及显示年份。按年份排序仍先算全量年份，facets 和播放保持原完整关系。

Catalog 成员时间维护已从逐曲扫描旧 owner 成员改为精确来源索引查找。首次入库中止的 [诊断记录](D:/Project/Twilight_Echo/docs/audit-evidence/m5.3-ingestion-aborted.json)仅给出约 179.4 秒内完成 8,800 来源的进度下界，不是一次完整入库计时。

原轮、checkpoint 和分页投影轮对账分别为 14.59／19.07／15.89 秒，均 `errorChecks=0`、`pendingChecks=0`、`consistent`；均未提供 Core state，`versionsAuthority=false`，首选版本的跨存储权威一致性仍待核对。Catalog、Genre 分面、Focus 全量分组、发行来源与启动缓存条件仍保留待办。

### 窄匹配轮：显示与播放字段按需补全

[共同正式报告](D:/Project/Twilight_Echo/docs/audit-evidence/m5.3-unified-library-100k-focus-matched.json)已完成全部 15 个查询 case、库存及语义断言。仍是同一 100,000 成员／1,000 缓存非成员库，保留 2 completed jobs／1 fact，schema 29→29。三次后续采样的 p50 如下，单位 ms；首次与 p95 见原报告。

| 操作 | 上轮 Focus 分页投影 | 本轮窄匹配关系 |
|---|---:|---:|
| Focus 首屏 | 5,209.95 | 4,375.25 |
| Focus 深页 | 7,330.10 | 4,858.44 |
| Focus 爵士筛选 | 8,441.18 | 6,892.93 |
| Focus 平台分面 | 4,743.69 | 3,663.78 |
| 真实两任务页 | 2,976.10 | 0.18 |

Focus 的完整 scope 现在直接读取物理来源，不预先展开 `catalog_bindings`、版本偏好和成员加入时间；匹配桥只物化 source ID、group key 和 provider。选出实体页后，才为该页所有匹配来源补齐来源排名与显示字段；完整播放候选仍按原版本偏好、成员时间、碟／曲顺序和真实成员条件补全。confirmed 身份分组、代表实体、history、条件编译和同源范围算法没有改变，准确 total、完整排序及筛选来源播放合同保留。provider facet 的实际计划不再消费版本偏好与成员时间。

同进程顺序单样本[诊断](D:/Project/Twilight_Echo/tmp/m5.3-focus-matched-100k-diagnostic.json)对照上一轮实际 SQL，首屏 6,439.71→4,047.95 ms，完整页 SQL 结果相同。另测的 history seek／scoped physical 候选在 2,000 条、空／5%／50% 历史诊断中没有稳定收益，因此未进入生产。

本轮未改本地分页的首屏 p50 也从 74.52 变为 162.29 ms，Catalog 首屏从 1,348.66 变为 3,679.24 ms；生产打开与库存验证共 29.52 秒，不能拆作纯打开或纯健康检查耗时。缓存与运行状态未受控，短时[主机采样](D:/Project/Twilight_Echo/tmp/m5.3-focus-matched-host-load.json)未确定原因，保留全部样本，不将所有跨轮差异归因于本轮代码或同期 UI 工作。

该轮对账 14.75 秒、`errorChecks=0`／`pendingChecks=0`、`consistent`，外部 HTTP 为 0；`versionsAuthority=false` 仍保留。父进程 peak RSS 为 248,332 KiB，不据此外推全应用内存。该轮结束时，流派格式分面 7,306.22 ms、Focus 爵士筛选 6,892.93 ms，M5.3 未通过；后续目录与分面修复见下一节。

### 当前轮：目录按实体种类查询，技术分面一次产生有效值与 unknown

[目录／分面共同报告](D:/Project/Twilight_Echo/docs/audit-evidence/m5.3-unified-library-100k-catalog-facets.json)完成 15 个查询 case、精确库存与全部语义断言。仍复用同一 100,000 成员／1,000 缓存非成员库，保留 2 completed jobs／1 fact，schema 29→29。三次后续样本的 p50 如下，单位 ms；首次、p95 和其余操作见报告。

| 操作 | 窄匹配轮 | 当前目录／分面轮 |
|---|---:|---:|
| 本地原分页首屏 | 162.29 | 75.93 |
| Catalog 首屏 | 3,679.24 | 890.59 |
| Catalog 深页 | 2,436.01 | 1,589.73 |
| 爵士流派首屏 | 3,697.58 | 3,677.04 |
| 爵士流派深页 | 4,606.84 | 3,967.34 |
| 流派格式分面 | 7,306.22 | 5,254.25 |
| Focus 爵士筛选 | 6,892.93 | 6,729.38 |
| 发行来源入口，含先读取发行页 | 3,653.14 | 3,650.76 |

目录查询现在只读取一份来源关系：录音只解析 tracks 手工版本，发行／项目只解析 albums，人物直接沿来源人物关系。匹配集合仅保存 ID、标题和来源计数，按原排序分页后再读取完整实体。默认成员浏览与 context 查询的 pending／missing 差异、native 原生发行选择、有效手工绑定、准确 total 和来源筛选后的 sourceCount 均保持原含义。[同进程配对诊断](D:/Project/Twilight_Echo/tmp/m5.3-catalog-source-diagnostic.json)中，两页完整 SQL 行与旧查询一致，首屏单样本 1,796.47→986.69 ms、深页 2,433.02→1,771.14 ms；它与正式轮共同支持减少重复来源及无关版本关联的方向。

format／bitDepth／sampleRate 原本分别生成已知值，再为缺值来源重复读取 payload。现在每个来源用一次 CASE 直接产生有效值或 unknown；非法类型、空值、范围与整数规则不变。录音查询不涉及发行维度时不携带无用 release／播放偏好列，实际格式分面计划只解析 tracks 绑定；请求或筛选地区、年份、专辑类型及资料管理状态时仍保留完整发行／项目事实层。账户上下文、跨来源许可和到期检查沿原路径。[配对诊断](D:/Project/Twilight_Echo/tmp/m5.3-genre-narrow-100k-diagnostic.json)中，窄列本身未改善流派首屏；格式分面从 7,783.39→5,675.40 ms，完整结果一致。额外后置 facet subset 更慢，未采用。

未改的本地分页也从 162.29 变为 75.93 ms，跨轮缓存与主机状态未受控，不能把全部变化归因于代码。当前生产打开与库存验证共 22.43 秒，不拆作纯打开耗时；父进程 peak RSS 为 265,748 KiB。对账 14.79 秒，`errorChecks=0`／`pendingChecks=0`、`consistent`，外部 HTTP 为 0；未提供 Core state，`versionsAuthority=false`。两任务页仍为毫秒级（p50 0.26 ms）。

**M5.3 仍未通过**：格式分面 5.25 秒、Focus 爵士 6.73 秒、流派首屏 3.68 秒；默认 Focus 首屏／深页也需 3.61／4.64 秒。2026-10-25 用户要求暂停性能优化，保留当前实现、证据及未通过状态。恢复后由音乐库域负责人处理 Focus 爵士筛选与流派全量构图。Catalog 深页、发行来源、worker 首组长尾与受控启动条件继续保留；人工内容、UI 和包内验收仍后置。

## 资料任务页只检查页内实体，不再展开全库来源

[单项诊断](D:/Project/Twilight_Echo/docs/audit-evidence/m5.3-metadata-tasks-diagnostic.json)在同一十万条库中保留 2 个 completed jobs 和 1 个 fact。修复前一次 `metadataTasks({ limit: 50 })` 用时 3,098.65 ms，其中 3,095.42 ms 落在带 live 子查询的任务页 SELECT：SQLite 展开整个 `catalog_entity_sources` UNION 并建立自动索引，连不提供复核入口的共享 enrich target 也承担这项工作。

现在先分页 jobs，再只为该页可复核的实体查来源。人物按 `catalog_artist_sources` 索引，录音／发行按原生 ID 索引，项目先按唯一关系定位发行。原生来源仍应用手工版本遮盖；所有未命中的手工版本在**一页一次**的批处理中解析，并按精确 source_key／album_key 索引找到来源，不对每个任务重复遍历版本 links。页内重复实体与项目／发行共享检查；enrich／legacy 不做 live 检查。

移除来源、非成员缓存、pending 本地投影和同 ID 跨平台均不产生陈旧复核入口。全状态计数、筛选、准确 total、需求数、返回字段与隐私投影保持原合同；没有新增迁移或持久缓存。单项诊断的最终候选首次为 10.93 ms，后续三次为 0.32／0.28／0.27 ms，返回 DTO 与修复前逐字段一致。首次包含逐语句计划采集，缓存未控制。共同正式轮的首次为 1.25 ms、p50 为 0.18 ms、p95 为 0.23 ms；该库没有大规模手工版本任务页，不能据此代表所有任务组合的延迟。

## 后台补资料时，冻结队列仍可读取

[探针](D:/Project/Twilight_Echo/scripts/unified-music-library-worker-probe.ts)使用生产 `LibraryDatabaseServiceClient`、真实 Node IPC 数据库 child 和 `CoreEntityMetadataService`，建立一首真实本地 Track 的冻结队列。受控 provider 分别暂停 resolve 和 enrich，暂停期间队列／Track 读取必须先返回，再释放 provider；随后与真实 facts 发布交错读取。

四个阶段各 12 组，每组并发 `getLibraryQueue`、`readLibraryQueue(1)` 和 `getTracksByIds(1)`，记录整个三请求组的延迟样本与实际 IPC method counts。原轮各阶段 p50 为 4.33—4.52 秒；[同库 worker 复测](D:/Project/Twilight_Echo/docs/audit-evidence/m5.3-unified-library-100k-worker-checkpoint.json)完成 48 组读取：

| 阶段 | 复测 p50 | 复测 p95 |
|---|---:|---:|
| idle | 105.11 ms | 1,318.08 ms |
| resolving，provider 暂停 | 109.41 ms | 1,175.70 ms |
| enriching，provider 暂停 | 95.06 ms | 112.99 ms |
| publishing，与事实提交交错 | 93.29 ms | 111.51 ms |

12 样本的最近秩 p95 仍是最大值；idle 和 resolving 的首组分别为 1.32／1.18 秒。`workerOpenMs` 原轮为 1,282.85 ms，同库复测为 **28,491.79 ms**；两轮没有控制文件缓存，不能直接归因为代码退化，也不能只用约 100 ms 的读取中位数宣布完成。

结束后 occurrence／队列及 library revision 不变，资料已发布，metadataEvents=8。provider dispatch 是受控 fixture 的 resolve 1 次＋enrich 1 次，外部 HTTP 为 0。实际原生音频连续性、真实服务限流和 UI 体验仍由后续验收覆盖。

### 打开延迟主要落在完整健康检查，后续重读约一秒

[启动诊断证据](D:/Project/Twilight_Echo/docs/audit-evidence/m5.3-database-open-diagnostic.json)记录同一 schema 28 合成库的生产构造路径：打开 22,521.76 ms，其中完整 `PRAGMA quick_check` 为 22,511.05 ms；schema 校验、既有索引和队列恢复均仅数毫秒，随后 `getMetadata` 为 1.50 ms。

接着在只读连接中逐表诊断，总计 1,013.20 ms、各表均为 ok；再执行完整检查，2 MiB 和 32 MiB page cache 分别为 962.92、1,043.88 ms，增加缓存没有改善。观测顺序与原始数据保存在同一证据文件。后续查询可能复用系统文件缓存，未清缓存、未控制存储状态，不称冷启动，也不将逐表检查作为生产健康门槛的替代。生产完整检查、缓存配置和超时均保持不变。

探针现另记父进程观测到的 fork→ready→opened→首个 metadata 响应分段，并提供 `probeMusicLibraryWorkerStartup`，只发一条 `getMetadata`，不创建队列或资料任务；生产打开仍正常校验、迁移及恢复。[同库单次启动观测](D:/Project/Twilight_Echo/docs/audit-evidence/m5.3-unified-library-100k-startup.json)为 schema 29→29，总计 1,284.24 ms：请求到 fork 0.27 ms，fork→ready 320.70 ms，ready→opened 960.56 ms，opened→metadata 2.72 ms。它发生在既有查询与健康检查之后，缓存未控制，不能据此宣布此前长打开已修复；分段包含进程和 IPC 开销，并非 worker 内部纯函数计时。

## 对账同时修复了默认收藏恢复

原默认收藏的合法重复 occurrence 曾被 v2 校验拒绝，并在恢复或来源回归时去重。现在在线／离线恢复、再次导出及精确来源回归均保留原顺序与重复；`none` 按偏好隐藏全部相应 occurrence。

本地快照从原 `tracks` 权威读取，不再使用不含路径的公开目录 payload。相同 Track ID 来自不同 provider 时保留独立离线锚点及原引用，不覆盖另一来源快照或误播同 ID 本地歌曲。详情及回归见 [M5.2 补记](D:/Project/Twilight_Echo/docs/unified-music-library-m5.2.md)。

## 已完成的定向检查

- **当前目录／分面候选**：[Catalog／引用 28 项](D:/Project/Twilight_Echo/tmp/m5.3-catalog-source-tests.log)、[Genre／分类／Focus／runner 62 项](D:/Project/Twilight_Echo/tmp/m5.3-genre-single-pass-tests.log)、[Catalog lint](D:/Project/Twilight_Echo/tmp/m5.3-catalog-source-lint.log)、[分面 lint](D:/Project/Twilight_Echo/tmp/m5.3-genre-single-pass-lint.log)及[整合 Node 类型检查](D:/Project/Twilight_Echo/tmp/m5.3-catalog-facets-types.log)通过。目录新增四种实体／七状态原视图差分与实际计划回归；[独立审查](D:/Project/Twilight_Echo/tmp/m5.3-catalog-source-review.md)直接提取 HEAD 原方法，1,876 次完整结果差分一致。分面新增技术字段单值／unknown 边界、实际绑定层计划、手工发行／项目维度、同源筛选、明确清空及账户许可／到期回归。
- **窄匹配候选**：[Focus／分类／流派／runner 57 项](D:/Project/Twilight_Echo/tmp/m5.3-focus-matched-tests.log)、[捕获器修复后单项](D:/Project/Twilight_Echo/tmp/m5.3-focus-matched-instrumentation-test.log)、[scoped lint](D:/Project/Twilight_Echo/tmp/m5.3-focus-matched-lint.log)与[完整 Node 类型检查](D:/Project/Twilight_Echo/tmp/m5.3-focus-matched-types.log)通过。测试捕获器改用 defineProperty，修复整合类型检查发现的 namedParameters overload 缺口。
- [资料任务页 13 项](D:/Project/Twilight_Echo/tmp/m5.3-metadata-tasks-tests.log)和[scoped lint](D:/Project/Twilight_Echo/tmp/m5.3-metadata-tasks-lint.log)通过，覆盖四种实体、手工绑定与重置、成员／pending／移除、同 ID 跨平台、页内去重、enrich／legacy 跳过，以及原生 ID 和手工来源的实际索引计划。独立审查发现的逐实体遍历版本 links 已改为页内一次批处理；[复核记录](D:/Project/Twilight_Echo/tmp/m5.3-metadata-tasks-review.md)的 33 实体／7 状态差分与原视图一致。
- **上一轮分页投影候选**：[Focus／分类／流派／runner 56 项](D:/Project/Twilight_Echo/tmp/m5.3-focus-page-query-tests.log)、[schema 报告 runner 4 项](D:/Project/Twilight_Echo/tmp/m5.3-focus-page-runner-tests.log)通过；[scripts 类型检查](D:/Project/Twilight_Echo/tmp/m5.3-focus-page-types.log)和[相关 lint](D:/Project/Twilight_Echo/tmp/m5.3-focus-page-lint.log)通过。
- [启动与后台探针 3 项](D:/Project/Twilight_Echo/tmp/m5.3-startup-probe-tests.log)及[scoped lint](D:/Project/Twilight_Echo/tmp/m5.3-startup-probe-lint.log)通过，覆盖分段和总耗时一致、startup-only 仅发概况请求，以及原后台队列／事实发布链路。
- [整合 Node 类型检查](D:/Project/Twilight_Echo/tmp/m5.4-node-typecheck-final.log)通过；初轮发现的排除 fixture 字段不符合 DTO 已按真实类型修正。没有修改或验收同期 UI 重构。
- [对账 8 项](D:/Project/Twilight_Echo/tmp/m5.3-reconciliation-tests-final.log)：完整跨域 fixture、损坏引用反例、有界样例、只读 CLI、生产 versions revision，以及完整 music-only 离线恢复；后者实际保留重复收藏。
- [读取与恢复消费 8 项](D:/Project/Twilight_Echo/tmp/m5.3-root-consumption-final.log)：新 worker 探针 2 项、原恢复 3 项、重复／碰撞 2 项，以及原真实 worker 收藏回归事件 1 项。
- [有界引用 10 项](D:/Project/Twilight_Echo/tmp/m5.3-page-references-tests.log)：跨 provider 同 Track ID、重复 occurrence、准确引用总数，以及实际执行计划使用 provider／Track 索引而非全库引用视图。[相关 lint](D:/Project/Twilight_Echo/tmp/m5.3-page-references-lint.log)通过。
- [专辑浏览 15 项](D:/Project/Twilight_Echo/tmp/m5.3-album-query-final.log)：原身份／版本／排序／许可合同，新增空页与超尾统计、每次只构建一个 graph 的检查。[相关 lint](D:/Project/Twilight_Echo/tmp/m5.3-album-query-lint.log)通过。
- [worker 进度回调 2 项](D:/Project/Twilight_Echo/tmp/m5.3-background-progress-final.log)：采样循环外的可选进度通知不改变队列、读取或发布行为；与上面的探针用例重叠。
- [checkpoint 查询候选 41 项](D:/Project/Twilight_Echo/tmp/m5.3-query-candidate-checkpoint-tests.log)：Genre／Focus 和混合 fixture／复用，覆盖空页／超尾 total、来源与专辑人工分类、成员及身份计数；在正式 checkpoint 前通过。[scripts 独立类型检查](D:/Project/Twilight_Echo/tmp/m5.3-benchmark-types-final.log)及[查询 scoped lint](D:/Project/Twilight_Echo/tmp/m5.3-query-lint-final.log)通过。
- 对账、探针及收藏修复的 scoped ESLint 分别见 [对账 lint](D:/Project/Twilight_Echo/tmp/m5.3-reconciliation-lint-final.log)、[探针 lint](D:/Project/Twilight_Echo/tmp/m5.3-background-worker-lint.log)和 [收藏 lint](D:/Project/Twilight_Echo/tmp/m5.3-favorite-repair-lint.log)。

这些日志按实际对象复用，不将重叠轮次相加。M2.6 的人工 200 条内容、真实应用交互、生产构建及 Windows 包内验收仍待完成。

## 日期补读已窄化，普通扫描取消合同保留

schema 29 为非 full 扫描的未变化旧文件增加 date-only 暂存。文件须有可播放记录、可信且未变化的 identity，且 `metadata_version < LOCAL_LIBRARY_METADATA_VERSION`；包括旧 JSON 迁移后保留的可信 pending v0 记录。batch 只保存日期与进度，成功 `finishScan` 才在同一事务内合并所有逻辑 Track 的 `releaseDate`、缓存中的日期和成功 marker。无有效日期也完成一次补读，失败则保留旧日期及重试资格。

发布前以最多 256 行的两遍分页验证全部文件、依赖、权限和 content version；任一冲突使整轮日期暂不发布，重新读取冲突项。并发手工标题、封面、歌词、身份与平台匹配不被替换，不创建网上补全任务。暂停保留暂存；取消、失败、中断恢复与 reset 均不泄漏暂存日期或 marker。ISO 沿原 native reader 只读年份，CUE／ISO 逻辑身份不重建；日期入口保留整体解析期限，不等待封面。普通新增／变化文件及 full 扫描沿旧流程，取消仍保留其已提交批次。

[新增 SQLite 合同用例](D:/Project/Twilight_Echo/src/main/library/libraryDatabaseReleaseDate.test.ts)共 15 项，已注册既有 `test:library-database`。有效证据包括[扫描及 worker 回归 79 项](D:/Project/Twilight_Echo/tmp/m5.4-date-only-regression.log)、[后补 reset／真实中断恢复 2 项](D:/Project/Twilight_Echo/tmp/m5.4-date-only-recovery.log)、[期限修复后真实 worker 4 项](D:/Project/Twilight_Echo/tmp/m5.4-date-only-worker-deadline.log)、[迁移 36 项](D:/Project/Twilight_Echo/tmp/m5.4-date-only-migrations.log)及[注册保护 15 项](D:/Project/Twilight_Echo/tmp/m5.4-date-only-registration.log)，轮次重叠不相加。v28 升级前生成原 SQLite 一致备份；只读对账继续支持 28／29。

实现入口及使用说明见[扫描与补全文档](D:/Project/Twilight_Echo/docs/local-library-metadata-enrichment.md)。十万条查询报告不包含十万个旧文件的日期补读／最终发布耗时，该负载及真实桌面验收仍后置，不能用有界分页宣称完成事务恒定耗时或后台性能已达标。
