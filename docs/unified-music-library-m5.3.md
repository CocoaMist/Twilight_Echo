# M5.3：全库只读对账与混合音乐库性能

2026-10-25。全库只读对账、真实数据库 worker 的后台任务读取探针，以及默认收藏 occurrence 修复已接入。十万条原轮与同库复测均已完成：本地分页和后台读取显著改善，Catalog／Genre／Focus 仍有秒级延迟，worker 打开耗时退化至 28.49 秒，**M5.3 性能尚未通过**。本轮先保存已测候选与证据；人工内容与实际桌面／键盘／主题／Windows 包验收仍按用户安排后置。

## 对明确选择的数据库生成报告

在项目目录运行；以下输入、输出路径是示例，换成明确选取的文件：

```powershell
Set-Location 'D:/Project/Twilight_Echo'
node --experimental-strip-types scripts/music-library-reconciliation.ts `
  --database 'D:/SelectedProfile/music-library.sqlite' `
  --core-state 'D:/SelectedProfile/core-state.sqlite' `
  --examples 10 --output 'D:/Reports/music-library-audit.json'
```

也可使用已注册的 `audit:music-library` 脚本。工具只读 schema 28，不执行升级、回填、联网或磁盘／账号探测。输出文件必须不存在；可以省略 `--output` 写 stdout。

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

同库复测支持 `--reuse-fixture=<已有合成库的绝对目录>` 和 `--ingestion-evidence=<原入库报告>`：以 query-only 模式核对库存并运行查询，不重新入库、不执行 worker 写入，也不删除该目录。本次 worker 在查询进程结束后另行串行运行。它留下 2 个 completed jobs 和 1 个 fact；当前 runner 的任务页仍期望 0，下一轮复用该库前须显式处理既有任务库存或另建 fixture，不能直接当成未运行 worker 的初始状态。

## 同库复测有改善，交互性能仍未通过

[原轮完整报告](D:/Project/Twilight_Echo/docs/audit-evidence/m5.3-unified-library-100k.json)记录 50,000 本地＋50,000 平台成员及 1,000 缓存非成员。入库共 308.24 秒；查询、全库对账和真实 worker 探针均执行完成。对账 `errorChecks=0`，外部 HTTP 为 0，队列与曲库 revision 不变；交互延迟仍不达标。

[查询 checkpoint](D:/Project/Twilight_Echo/docs/audit-evidence/m5.3-unified-library-100k-checkpoint.json)复用原合成库的一致快照，以相同库存和查询语义完成全部断言及对账，外部 HTTP 为 0。下表为各轮三次后续采样的 p50；首次调用另存。三样本的 p95 等于最大样本，不能据此判断长尾稳定性。

| 操作 | 原轮 p50 | 同库复测 p50 |
|---|---:|---:|
| 原本地分页首屏，50,000 条 | 4,775.59 ms | 71.92 ms |
| Catalog 首屏，100,000 条 | 1,377.38 ms | 1,414.38 ms |
| 爵士流派首屏，50,000 条 | 27,811.32 ms | 4,527.10 ms |
| 流派格式分面 | 37,690.12 ms | 7,793.44 ms |
| Focus 首屏，95,000 条 | 16,821.84 ms | 8,629.04 ms |
| Focus 爵士筛选，47,500 条 | 21,864.43 ms | 10,990.36 ms |
| Focus 平台分面 | 34,471.25 ms | 4,326.75 ms |
| 同项目发行首屏，60 个发行 | 4,143.68 ms | 1,522.91 ms |
| 发行来源入口，含先读取发行页 | 7,982.21 ms | 3,583.89 ms |

Catalog 首屏没有改善；深页仍为 2,346.53 ms，Genre／Focus 的改善也尚不足以交互验收。两千条诊断不能替代十万条实测。原轮父进程 peak RSS 为 1,735,112 KiB，复测为 247,556 KiB；前者含入库高峰，后者没有本轮入库，不能据此推断纯查询内存降低相同比例。复测打开与库存核对耗时 17.09 秒，原轮 308.24 秒入库只在 `ingestionEvidence` 中关联，没有重复测量。

本次正式复测已消费以下修复，生产临时存储配置仍为 `temp_store=FILE; temp.cache_size=-8192`：

- **有界页资料引用**：从本页的精确 provider／Track ID 开始索引查找，只展开选中来源的录音、发行、人物与项目；避免读取一个 Track 也物化全库 UNION 引用视图。保留重复 occurrence、总数、手工版本和原有返回上限。
- **发行与来源页**：关系物化只携带必要列；一次 SQL 同时生成页、准确总数、项目标题和当前发行，来源详情只展开有界页。空页或超过末页仍保留完整标题、总数与 provider 统计，不通过删字段或改变身份／播放版本含义换速度。
- **Genre／Focus**：按实体种类及实际请求维度缩小关系和字段，合并 total／page／facet 的重复构图；只为有界页读取来源 payload，保留身份分组、同源条件、人工清空、许可与到期语义。SQL 捕获改为记录首次真实调用，不再为取得计划重复执行整次查询。

Catalog 成员时间维护已从逐曲扫描旧 owner 成员改为精确来源索引查找。首次入库中止的 [诊断记录](D:/Project/Twilight_Echo/docs/audit-evidence/m5.3-ingestion-aborted.json)仅给出约 179.4 秒内完成 8,800 来源的进度下界，不是一次完整入库计时。

原轮与复测的全库对账分别为 14.59／19.07 秒，均 `errorChecks=0`、`pendingChecks=0`、`consistent`；两轮未提供 Core state，`versionsAuthority=false`，首选版本的跨存储权威一致性仍待核对。下一处查询优化优先缩小分类所需的 metadata 实体层／字段和流派有效目标关系，并单独定位重新打开数据库的成本；本轮提交不将这些待办标记完成。

## 后台补资料时，冻结队列仍可读取

[探针](D:/Project/Twilight_Echo/scripts/unified-music-library-worker-probe.ts)使用生产 `LibraryDatabaseServiceClient`、真实 Node IPC 数据库 child 和 `CoreEntityMetadataService`，建立一首真实本地 Track 的冻结队列。受控 provider 分别暂停 resolve 和 enrich，暂停期间队列／Track 读取必须先返回，再释放 provider；随后与真实 facts 发布交错读取。

四个阶段各 12 组，每组并发 `getLibraryQueue`、`readLibraryQueue(1)` 和 `getTracksByIds(1)`，记录整个三请求组的延迟样本与实际 IPC method counts。原轮各阶段 p50 为 4.33—4.52 秒；[同库 worker 复测](D:/Project/Twilight_Echo/docs/audit-evidence/m5.3-unified-library-100k-worker-checkpoint.json)完成 48 组读取：

| 阶段 | 复测 p50 | 复测 p95 |
|---|---:|---:|
| idle | 105.11 ms | 1,318.08 ms |
| resolving，provider 暂停 | 109.41 ms | 1,175.70 ms |
| enriching，provider 暂停 | 95.06 ms | 112.99 ms |
| publishing，与事实提交交错 | 93.29 ms | 111.51 ms |

12 样本的最近秩 p95 仍是最大值；idle 和 resolving 的首组分别为 1.32／1.18 秒。`workerOpenMs` 从原轮 1,282.85 ms 退化至 **28,491.79 ms**，尚未定位到打开、健康检查或 IPC 的具体阶段，不能只用约 100 ms 的读取中位数宣布完成。

结束后 occurrence／队列及 library revision 不变，资料已发布，metadataEvents=8。provider dispatch 是受控 fixture 的 resolve 1 次＋enrich 1 次，外部 HTTP 为 0。实际原生音频连续性、真实服务限流和 UI 体验仍由后续验收覆盖。

## 对账同时修复了默认收藏恢复

原默认收藏的合法重复 occurrence 曾被 v2 校验拒绝，并在恢复或来源回归时去重。现在在线／离线恢复、再次导出及精确来源回归均保留原顺序与重复；`none` 按偏好隐藏全部相应 occurrence。

本地快照从原 `tracks` 权威读取，不再使用不含路径的公开目录 payload。相同 Track ID 来自不同 provider 时保留独立离线锚点及原引用，不覆盖另一来源快照或误播同 ID 本地歌曲。详情及回归见 [M5.2 补记](D:/Project/Twilight_Echo/docs/unified-music-library-m5.2.md)。

## 已完成的定向检查

- [对账 8 项](D:/Project/Twilight_Echo/tmp/m5.3-reconciliation-tests-final.log)：完整跨域 fixture、损坏引用反例、有界样例、只读 CLI、生产 versions revision，以及完整 music-only 离线恢复；后者实际保留重复收藏。
- [读取与恢复消费 8 项](D:/Project/Twilight_Echo/tmp/m5.3-root-consumption-final.log)：新 worker 探针 2 项、原恢复 3 项、重复／碰撞 2 项，以及原真实 worker 收藏回归事件 1 项。
- [有界引用 10 项](D:/Project/Twilight_Echo/tmp/m5.3-page-references-tests.log)：跨 provider 同 Track ID、重复 occurrence、准确引用总数，以及实际执行计划使用 provider／Track 索引而非全库引用视图。[相关 lint](D:/Project/Twilight_Echo/tmp/m5.3-page-references-lint.log)通过。
- [专辑浏览 15 项](D:/Project/Twilight_Echo/tmp/m5.3-album-query-final.log)：原身份／版本／排序／许可合同，新增空页与超尾统计、每次只构建一个 graph 的检查。[相关 lint](D:/Project/Twilight_Echo/tmp/m5.3-album-query-lint.log)通过。
- [worker 进度回调 2 项](D:/Project/Twilight_Echo/tmp/m5.3-background-progress-final.log)：采样循环外的可选进度通知不改变队列、读取或发布行为；与上面的探针用例重叠。
- [当前查询候选 41 项](D:/Project/Twilight_Echo/tmp/m5.3-query-candidate-checkpoint-tests.log)：Genre／Focus 和混合 fixture／复用，覆盖空页／超尾 total、来源与专辑人工分类、成员及身份计数；在正式 checkpoint 前通过。[scripts 独立类型检查](D:/Project/Twilight_Echo/tmp/m5.3-benchmark-types-final.log)及[查询 scoped lint](D:/Project/Twilight_Echo/tmp/m5.3-query-lint-final.log)通过。
- 对账、探针及收藏修复的 scoped ESLint 分别见 [对账 lint](D:/Project/Twilight_Echo/tmp/m5.3-reconciliation-lint-final.log)、[探针 lint](D:/Project/Twilight_Echo/tmp/m5.3-background-worker-lint.log)和 [收藏 lint](D:/Project/Twilight_Echo/tmp/m5.3-favorite-repair-lint.log)。

这些日志按实际对象复用，不将重叠轮次相加。M2.6 的人工 200 条内容、真实应用交互、生产构建及 Windows 包内验收仍待完成。

## M5.4 前仍需修复日期回填合同

旧文件的 date-only 回填要求只补发行日期与成功标记，取消时不发布本轮日期和完成标记，不改人工标题、封面、歌词、身份或平台匹配，也不触发联网补全。当前 SQLite 扫描将 `metadata_version < 1` 的未变化文件放进普通解析和批次提交，可能覆盖非日期字段，取消后已提交标记仍保留。

音乐库域负责人将在性能修复后修正这一缺口，同时保留普通增量扫描“取消仍保留已提交批次”的原合同。该问题记录在[扫描与补全文档](D:/Project/Twilight_Echo/docs/local-library-metadata-enrichment.md)，当前未标记修复。
