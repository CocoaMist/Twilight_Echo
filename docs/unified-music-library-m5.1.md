# M5.1：从参与人员继续探索人物、作品与演绎

2026-10-24。人物／作品探索已接入原歌曲资料、人物资料和全部歌曲搜索。功能开发与定向验证记录在此；人工内容、真实桌面、视觉／键盘／主题及 Windows 包验收按用户安排后置。

## 从歌曲或搜索结果打开

- 打开本地或平台歌曲的信息，点击参与人员姓名进入内置探索；“来源”仍可打开原出处。作品级名单提供“探索作品”，不再只跳到外部网站。
- 已确认 MusicBrainz 身份的人物资料页可展开参与内容。默认只显示实际入库内容，按演唱、演奏、词曲、制作、混音等角色分页；可切换为本机已缓存目录。目录浏览不导入歌曲，也不发起联网补全。
- 全部歌曲页沿同一个搜索输入显示人物、作品和演绎结果，支持分页和库内／目录范围。未确认的旧同名艺人分组不会伪装成精确人物结果。
- 作品页显示明确的 work→recording 关系。需要组织一个跨乐章演绎时，建立人工演绎，逐条选择确切录音、调整顺序并命名；同一作品的多次演绎分别保存。删除演绎只移除人工关系，保留录音和稳定锚点。

## 身份靠引用，参与靠关系

新增独立 `MusicExplorationKind`，保留旧 `CatalogKind`、识别器和平台能力范围。人物／作品／演绎使用稳定目录锚点；精确引用由 provider、kind、idType、value 共同确定。读取不建立锚点、不按姓名选择首个结果、不自动确认本地身份。

MusicBrainz 现有详情适配器在原 HTTP 调度下收集明确的录音→作品 performance 关系，保存为 work→recording。该关系只证明此录音演奏了该作品，不生成“完整演绎”实体。人物 credits 的原角色、方向、署名连接符、属性、时间和出处保留；正向献辞等关系可在通用关系页查看，不作为人物参与内容或库内参与数量。

真实库内参与依赖当前成员、有效本地记录和明确的已确认身份映射。解除身份后重新求值；相同标题或人工播放等价版本不构成资料身份。没有演绎实体时直接展示已知录音；没有关系时保持空结果。

关系按来源集原子替换并标注截断，图投影限制 500 个节点、1,000 条关系及字节预算。原最多 2,048 条 credits 仍完整保存在原表中，不因探索投影裁剪而丢失。现有旧缓存按持久游标分批回填，每次最多 100 个来源集，Core 每批独立等待 worker；重启续跑，停止不启动后续批次。回填只消费已有 MusicBrainz 资料，不补造旧缓存中从未保存的作品→录音关系。

当前生产图来源为 `musicbrainz-details` 和人工演绎。没有权限上下文的其他旧 credits 不投影成全局图。关系读取检查 display／cache／crossSource、账号上下文及到期时间；Core 拒绝在查询中途切换账号或过期的回复。窗口在许可到期时撤下可见结果，不自动联网重查。

## 人物和作品复用原个人整理

人物／作品使用原标签和偏好仓库。作品仍是独立整理对象；其“不推荐”不传播到任意参与歌曲。人物自动禁播仍只使用原已确认主艺人规则，不能因制作、作曲或献辞关系扩散。评分继续只面向录音和具体发行。

精确人物与已确认身份共享偏好；原图锚点已有值时，身份确认／恢复沿原冲突预览明确选择，保留清除记录与历史。同名不同 ID 不共享个人值。标签保留确切成员引用；人物／作品参与数量是读取当时有效关系下的展示值，不改变成员总数、排序或标签播放选择。标签播放仍只展开原录音／发行引用。

人工演绎使用 revision CAS。保存／删除回复未知时保留草稿、要求重新读取并人工核对，不自动重复写入。

## 存储与接口

schema **27** 增加 `music_exploration_state/refs/sets/relations`，含关系索引、修订触发器及旧 credits 回填游标。引用变化同时失效偏好 CAS；关系变化推进目录修订，使原标签／Focus 查询失效。个人偏好 values/history 只扩展 `work` 类型约束，保留历史序号高水位、清除记录、歌单迁移收据及唯一权威。

Core 快照取目录索引和探索服务已观察到的最大目录修订。因此即使目录索引处于暂停状态，人工演绎编辑／删除后也会撤下标签参与数量和 Focus 旧结果，保留草稿，不自动查询或重启索引；迟到回复不会回退修订。

旧库先保存包含 WAL 的一致快照，再在同一迁移事务安装；失败回滚。旧版本二进制回退应使用匹配的升级前快照，不直接打开 schema 27。

公共操作：

- `exploration.query/lookup/detail/relations/participation`：`library:read`，分页最多 100 条。
- `exploration.performance.save/delete`：`library:write`，只编辑明确人工关系。

ingest、credits 同步／回填和账号上下文留在私有 worker/Core 通道。原 shared 校验、worker/client、CoreApplication、生产入口和 Renderer 均已接通；公开结果不包含文件路径、全量曲库、播放 URL 或凭据。

## 定向证据与后续

日志均在 `D:/Project/Twilight_Echo/tmp/`，重复定向运行不累加为独立用例：

| 范围 | 有效证据 |
| --- | --- |
| 探索仓库 | 18 项不同用例；`m5.1-exploration-repository.log` 与 `m5.1-exploration-forward-fix.log`、`m5.1-exploration-credits-final.log`、`m5.1-exploration-preference-fence.log` 合并，覆盖同名隔离、成员、方向、分页、截断、人工有序演绎及 CAS |
| Core／资料源／真实完成事务 | `m5.1-exploration-service-tests.log`、`m5.1-exploration-provider-tests.log`、`m5.1-provider-budget.log`；账号与到期竞争、明确 MB 关系、原完成事务及字节预算 |
| 实际分发／启动／重启 | `m5.1-exploration-dispatch-tests.log`、`m5.1-exploration-startup-backfill-tests.log`、`m5.1-exploration-worker-tests.log` |
| 图事务到现有界面失效 | `m5.1-revision-projection.log` 两项：原目录合同回归，以及实际删除演绎→Core 广播→标签／Focus observer；删除不改偏好、标签成员或保存筛选修订，仍撤下旧结果、保留草稿且不重查 |
| schema 27 与旧迁移链 | `m5.1-integration-ui-schema.log` 的迁移两项；`m5.1-prior-schema.log` 21 项及 `m5.1-prior-migration-smoke.log` 中已通过的 v23 升级，覆盖原 22 项迁移选择；原标签／Focus 迁移仍有效 |
| 探索界面／整理／搜索 | `m5.1-exploration-ui.log`、`m5.1-exploration-personal-refinements.log` 的到期精修、`m5.1-exploration-preference-identity-regression.log` 的 46 项偏好／确认／恢复回归；`m5.1-metadata-search-regression.log`、`m5.1-search-controls.log`、`m5.1-credits-entry-fix.log`。首次 credits 按钮断言失败已由后者修复并通过 |

新用例加入原 `test:core`／`test:library-database`，不建立第二套执行入口。Node 类型检查 `m5.1-node-revision-projection.log`、Web 检查 `m5.1-web-final.log` 均无诊断；相关 lint 通过，包括收尾的 `m5.1-revision-projection-lint.log`。原 Electron sandbox 窗口站环境依赖未恢复，生产构建、真实界面和打包验收未运行，仍归后置验收。

下一开发包为 **M5.2 完整个人备份 v2／music 域**，纳入人物／作品标签偏好、人工演绎、有序关系与恢复所需锚点。现有 v1 歌单备份不包含这些完整资料；M5.3 全库／十万条性能和 M5.4 实际发布验收继续保留。
