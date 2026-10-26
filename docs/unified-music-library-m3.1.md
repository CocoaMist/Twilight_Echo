# M3.1：流派仓库、旧规则迁移与整理入口

日期：2026-10-24。用户要求先推进开发，人工内容样本及桌面验收后置。本批已接通 schema 21、数据库 worker、Core 权限及原流派页的整理面板；M3.2 的歌曲／专辑分类浏览和 M3.3 的版本选源继续按原计划实施。

## 在原流派页整理原词

打开曲库的“流派”，展开“整理流派与未映射原词”：

- 按层级浏览、查找、新建流派，修改中英文名称或上级；列表每页 20 项。
- 选择带来源名的未映射原词，再明确选择现有节点，或一次新建并映射。
- 忽略原词不删除原始标签；勾选“显示已忽略”可以恢复建议。
- 并发修订变化保留输入并禁止旧修订写入，重新读取、核对后再保存。面板默认折叠，展开才查询。

旧流派卡片、字符串导航及 `LibraryQuery.genre` 仍是原来的精确字符串筛选。本批整理的是新的 ID 分类仓库，映射不会改写文件标签，也不将旧筛选偷偷改成子树查询。ID 筛选和新的分类结果页在 M3.2 接入。

## 同库保存事实、映射与人工集合

在原 SQLite 内增加 `music_genre_*` 表，不增加数据库、网络抓取器或第二条资料任务队列。

- 自维护 16 个基础中英节点，稳定 ID、字典版本、单父树。父级修改用递归 CTE 检查完整祖先链；删除必须明确迁往另一节点或转未映射。公共 API 保留 revision 栅栏。
- 别名用版本化 NFKC、大小写和空白规范化，不模糊猜测身份。明确来源映射／忽略优先于旧规则桥接，桥接冲突保持未映射；没有来源决策时再用通用别名。
- 本地证据保存原始字符串及分隔符配置；配置变化分批重算。平台单字符串不推测分隔，受信结构数组入口不再拆分数组元素。
- 人工集合包括多值、明确空集合和 reset。现代人工集合优先；旧人工覆盖保留导入来源；有效来源分类优先于受信外部分类。改映射时从保留证据重新求值，不丢原词。
- `catalog_sources`／真实 membership 触发脏索引，Core 每批合计最多处理 200 个来源或旧专辑 ID，批次之间让出执行。查询不触发背填，更不触发联网。
- 长 Unicode 旧 ID 经编码后仍可公开查询、编辑和覆盖，genre ID 上限统一为 8192；名称上限仍为 512。

## Rhine 只迁真实权威中的分类

当前托管插件的规则位于 `music.metadata` 的 **`value.rules`**，已有 published 主库存储是迁移来源。独立 demo 的 `genre-rules.json` 不属于当前宿主入口，不探测用户目录寻找它。

- 原节点 ID、别名和 `albumOverrides` 保留来历。规则单独存在、没有对应介绍记录的覆盖，也按既定 `legacyExperienceAlbumId(collectionId)` 精确绑定，不按专辑名称猜测。
- 只有显式 `albumOverrides` 转为旧人工覆盖；首曲派生 `genreId` 不冒充专辑人工集合。未绑定覆盖保留原 ID 和证据，后续库内容变化可以重接。
- 旧用户别名桥接到真实本地来源的原始标签，不扩散至云端来源。桥接保存独立导入来源，撤一组规则不影响其他组；现代来源 map／ignore 优先，reset 可以恢复旧规则默认值。
- 旧 `rawGenres` 可能混合本地和历史 MusicBrainz 社区内容，因此完整保留原数组及派生 ID，不默认激活为外部有效分类。
- 原发布、编辑、读取、自动补全和历史恢复接同一适配器。介绍／人员保存不清人工流派。旧单值分类不能覆盖现代多值或明确空集：明确旧分类修改遇到现代人工集合会拒绝并回滚，介绍仍可单独保存。
- 旧 `GenreRules` 单值 DTO 保持原含义，不从现代集合取首项伪装成兼容结果；现代集合的准确详情由新分类 API 提供。新详情页展示归 M3.2。

## 公共入口及主权

查询 `genres.tree`、`genres.unmapped`、`genres.evidence` 使用 `library:read`；`genres.edit`、`genres.map`、`genres.override` 使用 `library:write`。公共分页最多 200；目标只接受准确 source／collection ID，不接受任意路径、抓取 URL、供应商事实或伪造资料快照。

共享 DTO／校验位于 `src/shared/musicGenres.ts`，仓库位于 `src/main/library/libraryDatabaseGenres.ts`，Rhine 适配位于 `libraryDatabaseGenreLegacy.ts`。生产 Core 的 `CoreGenresService` 调度原 worker 的有界背填，worker 按修订发布变更；Renderer 通过既有 Core 连接调用。schema 20→21 先生成一致 SQLite 快照，再在事务中安装分类对象；不完整的当前 schema 拒绝打开。

## 本批代码证据与后续

- 功能定向回归 **60/60**：仓库、Rhine／旧入口、迁移回滚、Core 调度和实际编译 Vue 控制，见 `tmp/genres-final-feature.log`。
- 真实数据库 worker 替换 **1/1**：原词、别名映射、明确空覆盖、reset 及旧精确筛选，见 `tmp/genres-worker.log`。
- Core 新路由的权限／修订测试 **1/1**：`tmp/genres-core-dispatch.log`。原 Core／协议 **56/56**：`tmp/genres-core-wire.log`；旧 Rhine hook 回归 **34/34**：`tmp/genre-legacy-hooks-regression.log`。这些是不同范围的证据，不作为统一总数累加。
- 原迁移用例首跑 42/43，唯一失败是旧“未来版本 21”fixture；已改为未来版本 22，原拒绝语义不变，定向复测 **1/1**，见 `tmp/genres-previous-migrations.log`、`tmp/genres-future-schema.log`。
- Node 类型检查及相关 ESLint 通过：`tmp/genres-node-final.log`、`tmp/genres-lint-final.log`。全局 Web 类型仍有 `DspSignalOverview.vue` 的 10 个既存错误，本批音乐库无诊断：`tmp/genres-web-final.log`，由 DSP 修改负责人恢复全局门槛。

本轮未做真实 Electron 页面、原生键盘、主题、人工 200 条样本或包内验收，也未运行生产构建；这些保留到用户安排的后续验收。原 sandbox 窗口站权限依赖仍在，不改变 sandbox 配置。

后续 **M3.2 已接入**：独立 ID／包含子流派的歌曲与专辑查询、真实库内多来源并集、专辑直接分类与“来自曲目”回退、去重计数、分类详情和实际可用维度，见 [M3.2 实施记录](D:/Project/Twilight_Echo/docs/unified-music-library-m3.2.md)。当前继续 M3.3；人物风格未灌入作品，也未启用新的外部社区分类。评分、收藏／禁播、标签和 Focus 仍归 M4。
