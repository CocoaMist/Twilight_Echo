# 多协议网络音乐源架构与接口

网络音乐源用于浏览、入库和播放 NAS、远程服务器及家庭媒体服务器中的音乐。
当前共享类型以 [networkSources.ts](../src/shared/networkSources.ts) 为准，
IPC 接口以 [networkSourcesApi.ts](../src/preload/domains/networkSourcesApi.ts) 为准。

## 协议与职责

支持 WebDAV、FTP、FTPS、SFTP、SCP、SMB、NFS 与 DLNA。
系统命令和挂载类协议依赖目标平台的工具、权限及环境；
AFP 共享可通过系统挂载后作为本地目录使用。

- `src/main/network/profileStore.ts`：配置校验、凭据存储和渲染层摘要。
- `src/main/network/sourcesManager.ts`：协议适配、连接与浏览、播放解析和生命周期。
- `src/main/network/adapters/`：协议实现。
- `src/main/network/networkLibrary.ts`：虚拟媒体库。
- `src/main/network/networkMetadata.ts`、`networkCover.ts`：元数据与封面。
- `src/main/network/networkCache.ts`：网络媒体缓存。
- `src/main/network/networkIpc.ts`：主进程 IPC 边界。

## 配置与凭据

`NetworkSourceProfile` 保存稳定 ID、协议、名称、主机、端口、根路径、
连接/传输超时、并发选项和书签。WebDAV 的传输协议通过 `webdavScheme` 指定。

创建/更新配置使用 `NetworkSourceProfileInput`，认证输入可为匿名、密码或私钥。
口令类数据仅作为主进程输入，落盘由安全存储加密；配置中的凭据使用引用。
渲染层读取 `NetworkSourceProfileSummary`，其中不含口令或凭据密文。

凭据持久化、参数校验和系统安全存储不可用时的行为以
`profileStore.ts` 及其回归测试为准。网络源参数通过受控 IPC 传入，
网络请求和系统命令在主进程执行。

## 浏览与媒体库

`NetworkEntry` 包含所属 profile、稳定条目 ID、远程路径、条目类型，
以及可选的文件大小、修改时间、标签和封面路径。
支持目录、文件、音频和播放列表条目。

当前 preload 提供配置增删改查、`listDirectory`、`testConnection`、
`scanDirectory`、`listLibrary`、`removeLibraryEntry` 和元数据读取等接口。
从虚拟媒体库移除条目与删除服务器文件是不同操作。

路径规范化、条目所属来源、文件名和下载目标的校验由主进程承担，
错误使用共享的 `NetworkSourceErrorCode` 表达。

## 播放与缓存

`resolvePlayback(profileId, entry)` 返回 `NetworkPlaybackPlan`：

- `direct-url`：使用协议适配器提供的可播放地址。
- `local-cache`：使用经过缓存处理的本地媒体文件路径。

渲染层将解析结果交给现有播放链路。网络源不建立独立播放内核。
缓存通过受管音乐缓存目录统计和清理；元数据与封面保留各自缓存职责。
凭据、连接失败和缓存失败不应改变其他来源的配置与媒体身份。

## 验证

```powershell
pnpm run test:network-sources
```

自动化回归覆盖 profile、路径、缓存、元数据、适配器与页面行为。
实机验证使用 [网络音乐源验证清单](./network-music-sources-verification.md)，
覆盖浏览/播放/入库、错误凭据、超时与断网、缓存清理和会话释放。
