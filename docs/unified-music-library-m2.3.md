# M2.3 实施：正文、图片与基础人员资料

日期：2026-10-24。状态：**正文、发行属性、credits、CAA／Commons 图片后端已接入；下一项 M2.4 Rhine 迁移**。原页面消费在 M2.5，生产 Electron 验收仍待窗口站权限恢复。路线见[后续交付细案](D:/Project/Twilight_Echo/docs/unified-music-library-delivery-design.md)。

## 第一批：无 MBID 也能补平台人物与专辑正文

已确认的本地来源和平台来源，可以沿同一个平台原生身份取得正文，不再要求先绑定 MusicBrainz。原 `metadata.entity.enrich` 省略 provider 时，继续走原明确 MB 人物资料链路；新增可选 `provider: 'platform.<id>'` 使用当前实体已经确认的原生引用。客户端不能提交外部 ID、响应正文、账号上下文或待抓取 URL。

- [平台资料适配器](D:/Project/Twilight_Echo/src/core/library/platformMetadataProvider.ts)复用原 Core 持久任务、批次需求、取消与 generation。按共享目标、供应商、语言和使用上下文去重；本地／平台人物同一目标只跑一份任务。
- [资料仓库](D:/Project/Twilight_Echo/src/main/library/libraryDatabaseEntityMetadata.ts)从人物扩展到现有稳定的专辑项目、发行与录音主体。当前平台文字能力支持人物和平台 release；平台专辑 ID 仍不是具体压片身份。指定、清空、reset、revision 与解除关联沿用原入口。
- 正文保留来源语言。优先简中／繁中／英文，最后才用 `und`；`zh-CN`、`zh-TW`、`en-US` 等参与对应语言回退，返回时不改写供应商原语言。同语言本地共用正文优先百科，平台来源优先自己的资料，各份正文不拼接。
- 每条平台正文保存页面、署名、来源修订、获取时间、`display / cache / crossSource / export` 和可选期限。插件可以缩小权限，不能扩大部署已经核准的范围。没有缓存许可时不发出新的持久补全请求；旧人物页的直接简介调用不增加此前没有的条件。
- 受限正文只在真实的该平台来源上下文读取。传入 `sourceProvider: 'ncm'` 不能让一个本地目录实体获得平台原页权限；允许跨源的正文仍需先确认身份。缓存到期后停止展示并删除对应自动事实，Core 原任务计时器负责有界回收；人工值和身份记录保留。增加了到期表达式索引，schema 仍为 17。
- 平台禁用、登录／配置变更和迟到响应继续受当前上下文与取消栅栏约束。可持久缓存使用现有插件配置文件的文件系统 epoch；重启后保持有效，账号／配置写入后失效，不解密、读取或计算凭据摘要。账号切换时原在途任务恢复后查询新上下文。

## 平台可选接口已贯通 SDK、宿主和网易云

新增 `fetchArtistMetadata`（library）和 `fetchAlbumMetadata`（playlist），都需要实际注册 handler。共享[文字 DTO](D:/Project/Twilight_Echo/src/shared/musicMetadata.ts)与[SDK](D:/Project/Twilight_Echo/packages/plugin-api/src/index.ts)定义 `PlatformMetadataResult`，分别表示 `ok / not_found / not_provided / unsupported`；请求错误仍走原 RPC 错误路径。最多 8 条、每条 20,000 字符，来源页面不能含凭据或授权查询参数。

网易云新方法使用可匿名读取的专用 endpoint：人物先核对 `/artist/detail` 的 ID，再读取 `/artist/desc` 的简介和正文段落；专辑从 `/album` 核对原生 ID 后取 description／briefDesc。传递原 requestContext／AbortSignal，不把 Track、播放 URL 或曲目表塞进正文。来源未说明语言时为 `und`，不把中文平台默认当成简体中文。

旧 `fetchArtistIntro(): string`、`fetchAlbumTracks(): Track[]` 和 `fetchAlbumIdentity()` 均保留。只有已有规范来源页面、且部署许可允许时，旧人物字符串才包装为持久事实；存在新方法时优先新方法。未找到或缺正文不会清除以前的有效事实。

## 部署时分别批准平台文字用途

平台文字不会因插件已启用而自动获得跨源／缓存权限。发布负责人核对实际条款后，通过 `TWILIGHT_METADATA_PLATFORM_USAGE` 提供供应商到 `MetadataUsage` 的 JSON 映射；未配置的供应商显示 `platform_metadata_cache_not_approved`，不向后台资料仓库复制正文。该配置是经审定权限的输入，不构成对任何平台条款的授权。

独立的 `TWILIGHT_METADATA_ENABLED` 仍控制新资料请求。平台文字不依赖 `PUBLIC_SERVICE_APPROVED`、Wikipedia 正文开关或 MB 联系方式；这些原有条件只继续约束相应公共资料能力。`metadata.entity.policy` 增加每个平台的人物／专辑能力及阻塞原因。

## 本批验证

- 新平台资料 **14 项**覆盖无 MBID 的本地／平台共用持久任务、实际数据库 worker 重启读取、专辑覆盖／清空／恢复／解除、来源上下文、语言／百科选择、逐字段许可／期限、旧字符串适配、空响应不清空、账号切换任务恢复、取消及 wire／权限合同。
- 网易云新增 3 项实际适配器用例；插件设置新增 1 项不解密凭据的持久上下文用例。SDK 新方法的类型使用样例已通过构建。
- 实际数据库 worker、原人物资料和新平台资料组合 **55 项通过**；网易云／平台／设置早期组合 **115 项通过**，随后新增的恢复与期限用例已单独通过。
- 第一批 Core **977 / 977**、Node／Web 类型检查、相关 ESLint 和生产构建通过；随后新增的实际 worker 用例随平台资料 **14 / 14** 单独通过。完整 Core 使用现有测试入口，移除了一处重复的共享测试路径。

## 第二批：专辑项目百科、发行属性和有目标的 credits

`metadata.entity.enrich` 新增 `provider: 'musicbrainz-details'`，只使用当前实体已确认的类型化 MBID。专辑项目沿 release-group → Wikidata QID → P436 反向核验 → Wikipedia 取得背景介绍；人物原 P434 路径保持。首次发行日期／项目类型与具体发行日期／地区／条码分开，发行不借用项目介绍充当自身介绍。录音读取自己的关系，作品先保存外部引用，导航留给 M5。

[credits 解析](D:/Project/Twilight_Echo/src/core/library/musicBrainzCredits.ts)保存人物 ID、显示姓名、规范角色与原始角色、关系类型 ID、目标层次及引用、顺序／joinphrase、方向、属性、起止时间和出处。arranger、mix、vocal 不改成 producer；同名人物不合并，credits 不自动确认子身份。

schema **18** 新增 credits 集合与明细表；沿原一致备份升级，事实、credits 和任务完成同事务发布。内部单份上限 2048；详情仅预览前 64 条，`metadata.entity.credits` 从 SQLite 分页（每页最多 200），保留 total、源截断标记及 revision，旧分页快照在刷新后失效。

真实限流抽样：《OK Computer》项目 `b1392450-e666-3926-a536-22c65f834433` 经 Q202996 得到 zh-Hans 正文，中文页面 revision 94590756、Wikidata revision 2513268894；首次发行日 1997-05-21。发行 `1834eae1-741b-3c03-9ca5-0df3decb43ea` 返回 JP、1997-05-21、条码 4988006729254，以及 **440 条 credits，未截断**，目标包括发行、项目、录音与作品。样本证明原 256 条上限会截断常见专辑，故改为有界存储加数据库分页。证据：`tmp/metadata-details-live-complete.log`，不计为 M2.6 人工核对样本。

第二批验证：新 details **9 项**、相关组合 **162 项**、完整 Core **987 / 987** 通过；迁移组合 32 项加未来版本拒绝单项通过；Node／Web 类型检查、相关 ESLint、生产构建及 Renderer 资源预算通过。

## 第三批：CAA 封面与 Commons 人物图片

[公开图片适配器](D:/Project/Twilight_Echo/src/core/library/publicArtworkProvider.ts)通过 `metadata.entity.enrich({ provider: 'public-artwork', … })` 进入原持久队列，使用实体已确认的类型化 MusicBrainz ID。`metadata.entity.policy` 返回人物／发行／项目图片能力和原因。

- CAA 先取精确发行的已批准正面封面；没有精确封面时，沿 MB 的明确 release→release-group 关系查项目回退。`scope: release / album_project`、带供应商／类型／MBID 的 `targetRef` 和实际供图发行 ID 分开返回，图片命中不确认任何新发行。
- CAA JSON 实测为 CAA → `archive.org/download/mbid-…/index.json` → IA 的 us／ca 存储节点。共享 HTTP 只放行该 JSON 索引链，最多三跳，后续保持同一供图发行；拒绝任意文件、外部 host、凭据、降级和未知查询。仍有共享预算、取消、Retry-After、20 秒请求限时和 2 MiB 元数据上限。图片二进制继续走原媒体链路的五跳、25 MiB 和 MIME 限制。
- Commons 只沿人物 MB→QID→P434 反向核验→P18 查询，最多三个优先候选；逐文件读取作者／指定署名、credit、许可 URL 和图片修订时间。当前接受明确 CC BY／BY-SA、CC0 及有明确标记链接的公共领域记录；缺作者、缺许可链接或不支持的许可不用。即使 Commons 标为 `pd`，也不凭一个字符串放行所有地区版权条件。
- 实际 Commons 接口使用 `thumb.wikimedia.org` 和 `upload.wikimedia.org`，并附 `utm_*` 统计参数；只移除已观察的三种统计字段，其他查询拒绝。资源只接受这两个官方 host 的 Commons JPEG／PNG／WebP，不把原 SVG 当可加载图片。署名转纯文本，保留来源页和许可链接。
- 新资源放入现有 `metadata_facts` 的独立 artwork 字段；正文查询排除该字段，schema 保持 **18**。私有数据库 `metadataArtwork` 在真实 worker 中读取受控资源记录；公开详情只返回原 `artwork.present` 签发的图片句柄及出处，不返回 CDN 地址／内部上下文，不保存会话 token。正文和图片读取核对同一主体／关联 revision，变化则刷新。
- 有效且无期限的图片使用原磁盘媒体缓存；重启重签后可离线读取已缓存字节。有期限的批准内容不进入通用图片磁盘／浏览器缓存，句柄有绝对截止时间，重签不能延长；到期后原资料计时器有界删除自动资源。新查询不会修改 Track 的内嵌／人工封面，旧图片为空、缺许可或刷新失败也不清空人工值。

### 图片部署配置

`TWILIGHT_METADATA_COMMONS_IMAGES=1` 启用上述受支持的逐文件许可路径；仍需原公共服务资格和联系方式。CAA 单独通过 `TWILIGHT_METADATA_CAA_USAGE` 提供完整 `MetadataUsage` JSON；没有 display／cache／crossSource 批准时不发新的共享图片资料请求。CAA 不因 MusicBrainz CC0 或 Wikipedia 正文许可获得图片权利；部署值须来自实际使用条件。两种图片不要求开启 Wikipedia 正文。

平台现有 Track／人物封面继续使用原来源图片入口和媒体授权，不被这次外部图片请求改写；新平台文字 DTO 没有凭空扩充不存在的图片／credits 能力。原页面选择有效本地／人工／平台图，再用外部补缺，在 M2.5 接线。

### 实际抽样与检查

真实 CAA 抽样取得《OK Computer》精确发行封面 18174904878（edit 48753629）和项目供图发行 `30702389-5c67-4438-9ea0-2351c8de0f1d` 的封面 43287476628（edit 134151197），层次分开。Commons 经 Taylor Swift 的已确认人物 ID 取得图 `Taylor Swift at the 2023 MTV Video Music Awards (3).png`，作者 iHeartRadioCA，CC-BY-3.0，修订时间 2025-10-16T05:26:29Z。Beatles 三个 P18 文件缺明确许可 URL，因此保持未提供；不把这个负结果包装为已补图。原始证据分别在 `tmp/metadata-artwork-live.log`、`tmp/metadata-artwork-portrait-live.log` 和 `tmp/metadata-artwork-commons-live.log`；未下载图片二进制，这些不是 M2.6 覆盖率样本。

新增图片 **14 项**，覆盖层次／许可、实际重定向、当前 Commons URL、共享请求、故障／取消、真实数据库 worker、重启、到期清理、人工封面保留和跨关联快照。本批完整 Core **1002 / 1002** 通过，最终图片／授权／投影组合 **35 / 35** 通过；原媒体授权与磁盘缓存组合 **23 项通过**。Node／Web 类型检查、相关 ESLint、生产构建及 Renderer 资源预算通过。证据分别为 `tmp/metadata-artwork-core.log`、`tmp/metadata-artwork-final-tests.log`、`tmp/metadata-artwork-cache.log` 和对应类型／构建日志。

## 继续实施

1. M2.4 切换 Rhine 资料权威，保留旧 ID、导入及未归属资料，避免主库与 JSON 双写。
2. M2.5 接原页面、设置、TaskCenter 和收件箱。自动身份确认后的资料补全需求与用户语言在这一链路接通，不将当前显式后端请求称为已交付自动页面。
3. M2.6 人工核对内容与恢复验收，然后继续 M3—M5。

原生产 Electron 检查的恢复条件与命令见[M2.1 实施记录](D:/Project/Twilight_Echo/docs/unified-music-library-m2.1.md)；本批没有重复启动失败的运行时。
