# M2.1：人物资料后端已实现，生产无窗口验收待完成

日期：2026-10-24。对应 [M2 细案](D:/Project/Twilight_Echo/docs/unified-music-library-m2-plan.md)。本阶段交付人物资料纵向链路；专辑识别、自动回填、图片、分类、评分和界面仍按后续工作包推进。

## 本地与平台人物分别确认，再共用资料

1. 从 `catalog.query(kind: artist)` 取得来源人物 ID。
2. 提交明确 MB Artist ID 的 `metadata.entity.resolve`，Core 保存任务和候选。
3. 读取 `needs_review` 候选，以 jobId／generation 人工确认；同名不会自动关联。
4. 调用 `metadata.entity.enrich`。多个来源确认到同一 MB Artist 后，共用目标及同语言任务；介绍只存一份。
5. `metadata.entity.detail` 返回共享事实及当前来源的人工覆盖。确认不迁移人工值；解除关联后原值仍在。

没有外部 ID 的条目仍可按原方式播放；自动候选与入库触发在 M2.2 实现。

## 数据、出处和恢复

- SQLite **schema 13**。升级前 `VACUUM INTO` 保存包含已提交 WAL 的一致快照；DDL 失败回滚。资料写入不改变扫描 content revision。
- `metadata_entities` 保存唯一外部人物；`metadata_subjects`、`metadata_link_history` 保存确认、拒绝、解除及证据，不删除原来源实体。
- `metadata_facts` 独立于扫描重建的 `catalog_facts`，保存字段、语言、供应商、页面、获取时间、修订号、署名和许可。中文维基同时记录原语言 `zh` 和 variant 转换。
- `metadata_overrides` 区分指定值、明确清空和 reset 恢复自动。清空阻止其他语言回退。
- `metadata_jobs`、`metadata_demands` 分别保存任务和持久需求。去重键为目标／供应商／语言／类型／外部 ID；取消一批需求不取消其他批次仍需要的任务。
- Core 重启将未提交的 running 重新入队并递增 generation；事实和完成状态同事务提交。取消后的迟到结果不能写入。来源身份／名称／关联版本变化使旧候选失效，无关资料更新不影响任务。
- Retry-After 持久保存，允许超过五分钟本地退避上限；最多尝试五次。404 为 not_found，策略关闭／鉴权为 blocked，身份矛盾为 needs_review。
- SQLite 完整备份包含新表。个人 JSON 备份尚未增加这些字段，完整个人导出／迁移仍在 M5；清缓存不能代替备份。

实现位置：[仓库](D:/Project/Twilight_Echo/src/main/library/libraryDatabaseEntityMetadata.ts)、[实体任务服务](D:/Project/Twilight_Echo/src/core/library/entityMetadataService.ts)、[资料适配器](D:/Project/Twilight_Echo/src/core/library/entityMetadataProvider.ts)、[共享 HTTP 调度](D:/Project/Twilight_Echo/src/core/library/metadataHttp.ts)、[DTO 与校验](D:/Project/Twilight_Echo/src/shared/entityMetadata.ts)。任务由原 `CoreMetadataService` 拥有。

## 明确 ID 查询与部署开关

接入路径：**MB Artist → MB 的 Wikidata 关系 → P434 反向核对 → sitelink → Wikipedia 页面 QID 核对**。消歧义页和矛盾身份不采用；无正文时可以返回有出处的 Wikidata 简述。MusicBrainz 只读取核心人物字段，不取用户评分和流派。

新资料出口与 Core Rhine 的 MB／百科请求共用 host 调度：初始间隔 1.1 秒，同 host 并发 1。相同 HTTP 请求共享，单个消费者取消不影响其他消费者。固定 HTTPS host、禁止重定向、响应上限 2 MiB；不上传音频、路径或曲库快照。旧 Rhine 存储迁移仍在 M2.4，此阶段只统一其网络预算。

当前为部署配置，尚无用户设置页；默认不联网。启动 Core 前显式设置：

```powershell
$env:TWILIGHT_METADATA_ENABLED = '1'
$env:TWILIGHT_METADATA_PUBLIC_SERVICE_APPROVED = '1'
$env:TWILIGHT_METADATA_WIKIPEDIA_TEXT = '1'
$env:TWILIGHT_METADATA_CONTACT = 'https://github.com/Px-asen/Twilight_Echo'
```

`PUBLIC_SERVICE_APPROVED` 由发布负责人在核实当前部署的公共 API 使用资格后设置，不自动授予商业服务资格。`WIKIPEDIA_TEXT` 单独控制新正文获取；关闭时仍可取得获准的结构化资料。现有资料可离线读取，许可和署名随事实返回。应用默认项目联系方式，无需每个用户填写邮箱。

## 新 Core API

沿用现有 Core 会话和权限，不增加裸 IPC。原 `metadata.start / cancel / status / candidates / apply / clear` 的本地 Track 含义不变。

| 操作 | 输入重点 | 用途 |
|---|---|---|
| `metadata.entity.policy` | 空对象 | 启用状态、阻塞原因 |
| `metadata.entity.resolve` | entityId、mbid、language、batchId | 持久查询明确 ID 候选 |
| `metadata.entity.jobs` | 可选 entityId／jobId，limit ≤ 100 | 状态和候选 |
| `metadata.entity.decide` | jobId、generation、confirm／reject | 确认或拒绝 |
| `metadata.entity.enrich` | entityId、language、batchId | 补充共享资料 |
| `metadata.entity.detail` | entityId、language | 有效介绍、事实、覆盖、出处、revision |
| `metadata.entity.override` | entityId、revision、mode、language、可选 value | 指定、清空、reset |
| `metadata.entity.detach` | entityId、revision | 撤销来源关联 |
| `metadata.entity.cancel` | jobId、batchId | 撤销批次需求 |

语言为 `zh-Hans / zh-Hant / en`。查询需 `library:read`，变更需 `library:write`。客户端不能上传事实、任意 URL 或目标快照；断开客户端不取消任务。

## 证据与剩余门槛

- 新增实体测试 **11 项通过**：本地／平台共享介绍、磁盘重开和任务恢复、覆盖／清空／reset、拒绝／解除、共享取消与迟到结果、输入版本、事务回滚、Retry-After、策略变化、语言／出处、HTTP 去重及预算。
- 新增 Core dispatch 测试通过：权限、断开后继续任务、旧 metadata API。真实数据库 worker 的新方法传输、替换恢复及扫描 revision 不变测试通过。
- `test:core` 运行时 **632 项通过**；随后新增的两项恢复／策略测试和 dispatch 测试，已分别针对性通过。Node／Web 类型检查、`electron-vite build` 通过。
- 真实公开样例：周杰伦，MB Artist `a223958d-5c56-4b2c-a30a-87e357bc121b` → Wikidata `Q238819` → 中文维基。取得简中介绍；Wikidata 修订 `2546726179`、正文修订 `94518052`、正文许可 CC-BY-SA-4.0。该样例验证接入，不替代整库识别质量验收。
- 完整 `test:library-database`：1153 项，1130 通过、23 未通过。失败集中在 Renderer 旧存储／旧接口断言、window 模拟及仍按 schema 10 编写的 v6 fixture。本次受影响的数据库版本断言已更新并针对性通过；完整套件仍未全绿。
- **生产 Electron 无窗口集成未通过**：本机 Electron 43.7.0 在测试 JS 执行前以 `0x80000003 / EXCEPTION_BREAKPOINT` 退出；独立 `electron --version` 同样崩溃，Node 模式可运行。未更换运行时、关闭沙箱或修改通过判定。原 headless fixture 已加入新 API、持久覆盖和重启断言。

**本包保持“实现已落地、生产验收待完成”。** 后续定位到 sandbox 初始化的 alternate window station 创建检查；独立 Win32 探针以相同窗口站 DACL 创建窗口站，标准和缩减权限请求均返回 Win32 5 / ERROR_ACCESS_DENIED。需要恢复桌面执行环境的窗口站创建权限，再运行原 `node --test scripts/core-headless.test.cjs`。

期间已推进可独立验证的 [M2.2 第一批仓库与候选接口](D:/Project/Twilight_Echo/docs/unified-music-library-m2.2.md)，并升级至 schema 14；这不代表 M2.1 的生产验收已经通过。
