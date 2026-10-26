# M4.2：统一收藏与自动禁播

2026-10-24。接续 M4.1 的录音／具体发行评分，在原音乐库增加喜欢与禁播，并保留原收藏操作。人工内容、真实桌面、键盘／主题及打包验收仍按用户安排后置。

## 从原页面管理喜欢与禁播

- 歌曲偏好复用原 Track 精确定位的物理录音；专辑偏好复用当前选中的具体发行，不给人工播放版本或整个专辑项目设置同一值。
- 艺人偏好只对明确已确认的艺人身份开放。自动选曲只使用实际主艺人关系，不沿作曲、制作、混音等 credits 扩散禁播。
- `none / favorite / ban` 互斥，独立于星级。喜欢会替换禁播，取消喜欢只取消 `favorite`；取消禁播是明确操作，不由旧 `favorite: false` 顺带执行。
- 原系统收藏页、播放器收藏按钮及批量入口继续使用同一偏好权威；平台点赞／取消点赞保持平台账号操作，不因本地偏好变化发请求。
- 写入后重读核对；失败或结果未知保留操作，要求明确重读，不自动重放。已知 revision 或 Core epoch 变化撤下旧值。

## 收藏只有一个可写权威

旧收藏由完整 `playlists.json` 文档的默认歌单持有。只迁移默认成员、同时继续在 JSON 写完整文档会形成跨存储双写，因此本批将**歌单文档、默认收藏偏好和完成标记在同一 SQLite 事务发布**。普通歌单仍是原有有序 occurrence，使用原 CAS 合同，不改为录音集合。

1. 原仓库连续读取同一个完整、有版本的快照；发生变化不提交。
2. 按 `isDefault` 选原系统收藏；没有标记时新建独立系统列表，不接管同名普通歌单。保留原 ID、名称、排序、快照、缺失条目及普通重复成员。
3. 迁移只保留准确来源，不因收藏补建音乐库成员。原录音等价规则继续服务旧收藏入口，明确设置的录音偏好优先，避免人工播放版本中的其他喜欢遮盖当前录音的禁播。
4. 新文档和偏好提交后，所有歌单消费者通过 Core 仓库适配器读取 SQLite。旧 JSON 保留作恢复材料，不再参与业务写入。重启先读取已发布权威，不重复导入。
5. 外部偏好或身份事务会推进收藏投影 revision；Core 刷新原歌单缓存后才确认偏好操作，公共歌单读取等待该刷新。

同事务保存初始迁移收据，记录原 revision、默认歌单 ID、时间、原始行数、按原录音等价规则计算的逻辑成员数，以及每一行的原位置／Track ID → 精确来源／物理录音／偏好键。缺失快照或不支持的来源逐行保留为待确认，不以去重数冒充迁移行数。逻辑计数使用原人工版本身份规则，缺少快照时按 200 条补读本地 Track；无法解析的旧 ID 独立保留，日后发现来源也不擅自删除或假装已有明确偏好。

初始收据不随后续歌单编辑或偏好变化改写，可经数据库服务私有 `preferencesPlaylistsMigrationReceipt()` 读取；它是本次切换的核对依据，不代表当前收藏成员数。

完整文档继续执行原 20 MiB 容量边界。原 v1 个人备份的歌单导出、预览及恢复改读当前权威；启动恢复日志把歌单步骤转到 SQLite，恢复 ID 与数据同事务提交，结果未知时按 ID 重读，不重写旧 JSON。

## 身份变化先比较偏好

未确认时保留来源实体范围的记录，确认后使用同类型共享身份。合并、替换及历史恢复显示当前与目标偏好；冲突须选择采用当前、采用目标或清除目标，并携带独立的偏好 revision。评分选择与偏好选择分别校验，不能借其中一次选择覆盖另一类冲突。

自动识别遇偏好冲突停在复核。偏好转接、身份与审计同事务提交；解除后恢复原实体记录，共享期间的新值不复制回拆出的来源。

自动判定尊重当前的解除／替换决定：已有精确来源时只读当前录音、发行及主艺人关联，不沿历史原生 ID 重新启用已解除身份。未留存的推荐候选只能按准确平台 ID 查有效身份，不写目录或音乐库。

## 禁播在自动选曲边界生效

个性化及心动推荐的初始批次、后续 refill、自动导航和自然曲终均经过统一批量判定；来源准备完成、提交音频前再次核对。录音、所选发行或明确主艺人任一禁播即排除，专辑禁播优先于曲目喜欢。

- 禁播变化不强停当前曲，不重排已有队列；后续自动选择时检查新值。
- 明确点播、具体队列选择、用户主动播放普通歌单及 liked 列表保留原行为。
- 每次最多检查 100 个已有 occurrence，最多补充一次推荐；全被排除时停止该次选择，不无限重试。
- 私有判定每批最多 200 首，返回逐项对齐的布尔值；不完整响应作为失败，不当作放行。

原生预播不能在跨曲前等待新的数据库判定。因此，已启用此判定器的**自动推荐队列使用单曲 native window，由 Core 在曲终选择并准备下一首，不再使用原 native 预播／gapless**。普通队列的预播及无缝播放合同不变。

心动上下文跟随持久 `queueId + baseQueue`，不跟随实际解码来源。某首平台推荐修复为本地音源后，下一首及自然曲终仍执行禁播和单曲 window；本地当前曲不发送非法的网易云 refill seed。

## schema 24 与接口

新增默认 Profile 的偏好值、历史、歌单权威、恢复收据和 revision 触发器。升级沿用 WAL 一致快照及事务安装；失败不推进版本，不用旧二进制直接打开 schema 24。

- `preferences.targets / detail / history`：`library:read`。
- `preferences.set`：`library:write`。
- 原 `playback.favorite` 继续只要求 `playback:write`；不增加资料源开关、平台登录或 `providers:call` 前提。
- 迁移、恢复、Track 状态与自动判定为私有数据库操作，不加入公共请求。

新 music 域的便携备份仍属于 M5，需包含完整偏好值、明确清除、历史及身份键映射。本批保留原歌单备份合同，不把 v1 歌单导出当作完整新音乐库备份。

## 自动化证据与验收边界

| 范围 | 结果与记录 |
|---|---|
| 最终偏好仓库及旧收藏适配 | 14/14；逐行收据、未解析 ID、身份冲突／解除、同名普通歌单、容量及 v1 恢复，见 [最终定向](D:/Project/Twilight_Echo/tmp/m4.2-preferences-authority-final.log) |
| 原歌单服务与备份恢复 | [歌单 29/29](D:/Project/Twilight_Echo/tmp/m4.2-preferences-playlist.log)、[备份 31/31](D:/Project/Twilight_Echo/tmp/m4.2-preferences-backup.log)；包含与最终定向重叠的仓库用例，不合计数量 |
| 自动播放 | [Session 117/117](D:/Project/Twilight_Echo/tmp/m4.2-automatic-playback-session.log)；跨源心动修复后受影响路径 [20/20](D:/Project/Twilight_Echo/tmp/m4.2-heart-cross-source-regression.log)，复用其余未受影响证据 |
| 偏好与身份交互 | [51/51](D:/Project/Twilight_Echo/tmp/m4.2-preferences-ui-tests-final.log)；包含编译后的组件事件与原评分／资料回归 |
| 升级及真实 worker | [最终接线 3/3](D:/Project/Twilight_Echo/tmp/m4.2-preferences-receipt-wiring.log)；v23 WAL 一致备份／回滚、收据第三参数与读取、Track 状态、禁播及重启持久 |
| Core 权限与旧接口 | 原公共集 60 项有效通过；补齐测试替身及新增刷新等待后 [3/3](D:/Project/Twilight_Echo/tmp/m4.2-preferences-core-public-fixed.log)，共同覆盖当前 63 项；初次记录见 [公共集](D:/Project/Twilight_Echo/tmp/m4.2-preferences-core-public.log) |
| 旧 schema 兼容 | 原迁移集 52 项有效通过，7 项旧版本断言更新为 24 后 [7/7](D:/Project/Twilight_Echo/tmp/m4.2-preferences-prior-schema-fixed.log)；初次记录见 [迁移集](D:/Project/Twilight_Echo/tmp/m4.2-preferences-prior-schema.log) |

最终 [Node 类型检查](D:/Project/Twilight_Echo/tmp/m4.2-preferences-node-final.log)通过；偏好、自动播放、Renderer 和最终生产接线的定向 lint 通过。新增数据库、适配器及 UI 用例已注册到现有测试入口。

全局 Web 类型检查仍有 `DspSignalOverview.vue` 的 14 项既存错误，见 [Web 诊断](D:/Project/Twilight_Echo/tmp/m4.2-preferences-ui-types-final.log)，由 DSP 域在整体验收前处理。本批不修 DSP。人工内容样本、真实桌面、视觉／键盘／主题和打包验收仍未进行；原 Electron sandbox 的窗口站权限依赖保留，不关闭 sandbox 绕过。

## 接续 M4.3

下一开发包为专辑／录音标签、分页成员与集合展开，再推进 M4.4 Focus。M2.6、M3 与本阶段实际界面／内容验收保留，整个 M1—M5 尚未完成。
