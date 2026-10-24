# M4.3：专辑／歌曲标签与集合播放

2026-10-24。接续 M4.2，在原音乐库加入标签管理、精确实体成员和库内歌曲展开。人工内容、真实桌面、视觉／键盘／主题及打包验收仍按用户安排后置。

## 从原曲库和详情管理标签

- 全部歌曲页提供折叠的“管理标签”入口，不依赖当前歌曲、库成员或平台登录。移出全部来源后，仍可查看标签、改名、移出离线引用和确认删除。
- 原歌曲信息与当前选定具体发行下可为准确目标添加／移除标签。没有选定实体时只管理集合，不显示“加入当前条目”。
- 标签列表、原始成员和当前库内歌曲分别分页；原始成员显示是否仍在库，展开歌曲显示库内来源数量。集合可从头或从本页指定歌曲起播，准备过程可取消。
- 名称、成员分别编辑；冲突保留草稿并要求重读，结果未知先核对，不自动重放写入或播放。删除需要二次确认。

## 标签保留原引用，播放采用当前身份

标签由服务端固定的默认 Profile 持有，保存精确的物理录音／发行引用。人物、专辑项目和人工播放版本不是本批标签目标；人物／作品扩展属于 M5，首版无嵌套标签。

为专辑加标签不复制当前曲目，为歌曲加标签也不标记其全部所属专辑。确认、替换或解除外部身份时，成员引用不搬迁；移出库不删除引用。这样用户的整理不被识别结果或离线状态隐式改写。

播放时才展开实际 `catalog_memberships`：缓存目录不算入库，本地来源还必须有当前 Track 且不在待投影集合。之后加入该发行的实际库内曲目会自然进入下次展开。按**当前同类型已确认录音身份**去重；未确认时按物理录音 ID，不按标题、歌手名或人工播放版本合并。

原普通歌单仍是有序 occurrence，重复项、快照及原播放入口不改为标签集合。

## 独立修订与完整快照

- 名称按 NFKC、首尾／连续空白及大小写归一判同名，输入最多 80 字符。
- 创建检查全局 `tagsRevision`；改名只检查 `nameRevision`；增删成员只检查 `membersRevision`，幂等操作不推进成员修订；删除同时检查两者。
- 每页最多 100 条。`MusicTagsToken` 包含标签、目录、内容和录音身份关联四类 revision；后续页与播放使用同一 token，变化则要求刷新。
- 公共页面只给稳定实体／来源引用及展示字段，不传文件路径、旧 Track ID、Track 快照或播放 URL。私有数据库播放分页才解析当前播放对象。

## 集合准备后冻结为原队列

每个录音只在当前集合候选中选来源：明确首选优先，其次按首次实际入库时间、稳定来源 ID 排序，不默认偏爱本地。起播锚点是当前展开页返回的精确 `sourceId`，缺失时不擅自从另一首开始。

Core 在进入现有 `fromPages` 时先捕获播放意图，再异步读状态，每批最多 100 首直接流入原隐藏 SQLite 队列 builder。逐页、准备完成和采用前核对快照及取消；准备阶段空集、过期、锚点丢失、取消或权限不足不替换旧队列。较慢的标签读取也不能覆盖之后的播放操作。

新集合条目标记 `sourceSelection: 'explicit'`，不沿旧的标题／艺人恢复路径跳到集合外来源。采用后队列冻结，之后修改标签、身份或库成员不重排当前队列。平台 URL 仍由原 Session 按需获取，不为构建集合预取全库播放链接。

标签查询需 `library:read`，整理写入需 `library:write`；集合播放需 `playback:write` 和 `library:read`，实际包含平台来源时才额外检查 `providers:call` 与当前平台能力。本地整理与本地播放不要求资料补全开关或平台登录。

## schema 25 与备份分工

原 SQLite 增加标签、成员及状态表、索引和录音身份修订触发器。v24→25 沿原 WAL 一致快照／事务升级，保留评分、收藏权威、初始迁移收据、普通歌单重复项与原目录；安装失败回滚，当前版本缺对象时拒绝继续。不能用旧二进制直接打开 schema 25。

生产链路已贯通共享校验／权限、数据库 worker／client、Core application／入口及 Renderer。持久事件传完整标签 token，Core 快照按读取权限暴露标签和关联修订。

SQLite 一致备份包含新增表；现有 v1 歌单备份仍只履行原歌单合同，不包含标签。完整 music 域的便携导出、引用映射及恢复归 M5.2。

## 自动化证据与剩余验收

各行存在重叠，不合计为一次完整套件：

| 范围 | 有效证据 |
|---|---|
| 标签仓库 | [域测试](D:/Project/Twilight_Echo/tmp/m4.3-tags-domain-tests.log)中仓库 11/11，覆盖独立 CAS、精确引用、离线保留、动态展开、当前身份去重及排序 |
| 最终播放服务 | [8/8](D:/Project/Twilight_Echo/tmp/m4.3-tags-service-frozen-sources.log)，覆盖分页、取消／过期、起播锚点、较慢读取和精确来源冻结；修正快照类型后受影响 [3/3](D:/Project/Twilight_Echo/tmp/m4.3-tags-domain-type-fixes.log)，复用其余未变证据 |
| 升级／回滚 | [2/2](D:/Project/Twilight_Echo/tmp/m4.3-tags-schema.log)，含 WAL 一致 v24 备份、重启、原个人数据及失败回滚／不完整 schema 拒绝 |
| 原 schema 回归 | [原选择](D:/Project/Twilight_Echo/tmp/m4.3-tags-prior-schema.log)中 21 项有效；未来版本测试修正 fixture 断言后 [1/1](D:/Project/Twilight_Echo/tmp/m4.3-tags-future-schema-fixed.log) |
| 真实数据库 worker | [1/1](D:/Project/Twilight_Echo/tmp/m4.3-tags-worker.log)，包含私有接口、完整 token 事件、内容变化过期、重启持久及删标签不删歌曲 |
| 公共合同／Core 权限 | [公共 DTO](D:/Project/Twilight_Echo/tmp/m4.3-tags-core-public.log) 1 项有效；[最终 Core](D:/Project/Twilight_Echo/tmp/m4.3-tags-core-public-fixed.log) 1/1，使用真实 SQLite 验证本地离线与平台权限 |
| Renderer | 全局模式接入后的 [原标签 23/23](D:/Project/Twilight_Echo/tmp/m4.3-tags-ui-global-initial.log)、[新增全局 5/5](D:/Project/Twilight_Echo/tmp/m4.3-tags-ui-global-regression.log)；[原评分／偏好入口 17/17](D:/Project/Twilight_Echo/tmp/m4.3-tags-ui-entry-regression.log)；含真实 SongList 模板空库入口及编译后的控件事件 |

独立合同审查发现的“全部来源移出库后没有全局标签入口”已修复并由新增全局测试覆盖；身份展开、来源冻结及普通 occurrence 边界没有其他具体发现。[最终 Node 类型检查](D:/Project/Twilight_Echo/tmp/m4.3-tags-node-final.log)、[生产接线 lint](D:/Project/Twilight_Echo/tmp/m4.3-tags-root-lint.log)、[全局入口 lint](D:/Project/Twilight_Echo/tmp/m4.3-tags-ui-global-lint.log)和[最终域修正 lint](D:/Project/Twilight_Echo/tmp/m4.3-tags-domain-type-fixes-lint.log)通过。新用例已注册到原 `test:core` 和 `test:library-database` 入口。

全局 [Web 检查](D:/Project/Twilight_Echo/tmp/m4.3-tags-ui-global-types.log)仍有 `DspSignalOverview.vue` 的 14 项既存诊断，由 DSP 域在整体验收前处理。真实桌面、视觉／键盘／主题、人工内容样本和打包验收尚未执行；原 Electron sandbox 的窗口站权限依赖保留，不关闭 sandbox 绕过。本批未做生产构建。

## 接续 M4.4 Focus

下一开发包实现版本化查询 AST、保存查询、分面与原列表入口；列表、计数及冻结播放共享一套查询语义和 token。M2.6、M3 及本阶段实际验收保留，整个 M4 与 M1—M5 尚未完成。
