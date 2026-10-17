# 多平台安装包发布

本文说明 macOS 与 Linux 安装包如何由 GitHub Actions 构建并发布到 GitHub Release。
Windows 安装包仍由本地 `pnpm run gate:release:win` 产出，见
[Windows-first Release Gate](windows-release-gate.md)。

## 触发方式

两个打包工作流都支持同样的两种入口：

| 入口 | 行为 |
| --- | --- |
| 推送 `v*` 标签 | 自动构建并发布到该标签对应的 Release |
| `workflow_dispatch` + `release_tag` 输入 | 为已存在的标签重新构建并补齐资源；留空时只构建，不发布 |

标签必须已经存在，发布任务会先查询 `git/ref/tags/<tag>`，不会隐式创建标签。
发布前会校验标签与 `package.json` 的 `version` 一致，例如 `v1.3.1` 对应 `"version": "1.3.1"`。

```powershell
# 手动补发某个标签的 macOS 与 Linux 安装包
gh workflow run "Build macOS packages" -f release_tag=v1.3.1
gh workflow run "Build Linux packages" -f release_tag=v1.3.1
```

## 产物清单

| 工作流 | 运行环境 | 产物 |
| --- | --- | --- |
| Build macOS packages | `macos-15-intel` / `macos-15` | `TwilightEcho-<version>-mac-x64.dmg`、`-mac-x64.zip`、`-mac-arm64.dmg`、`-mac-arm64.zip` |
| Build Linux packages | `ubuntu-24.04` | `.AppImage`、`.deb`、`.rpm`、`.tar.gz`（x64） |

每个安装包都会在发布任务中生成同名 `.sha256` 文件，内容为 `sha256sum` 兼容格式
（`<digest>  <文件名>`），Windows 应用内更新也按同样的约定读取校验和。

## Release 发布门禁

发布任务按平台独立执行，但 Release 只有在全部平台都齐备后才离开草稿状态：

1. 构建任务成功，并且本次运行上传了安装包运行产物；
2. 发布任务下载本平台的运行产物，生成 `.sha256` 同名文件；
3. Release 不存在时以 **草稿** 形式创建，标题为 `Twilight Echo <version>`，
   正文优先使用 `docs/release-notes/<version>.md`；
4. 上传安装包与校验文件；同名资源先删除再上传，重复运行不会留下旧文件；
5. 校验本平台产物完整（macOS 两个架构的 dmg/zip，Linux 四种格式，且每个安装包都有校验文件）；
6. 以 `--platform all` 再校验一次：只有 macOS 与 Linux 全部齐备时才把草稿 Release 正式发布。

草稿 Release 无法通过 `/releases/tags/<tag>` 查询（该接口对草稿返回 404），因此
[`scripts/publish-release-assets.sh`](../scripts/publish-release-assets.sh) 先从 Release 列表里按标签
找到数字 id，再按 id 上传资源并通过 PATCH `{"draft": false}` 发布。

如果其中一端构建失败或被取消，Release 会停留在草稿状态，不会出现只带半套安装包的公开版本。
修复后对同一标签重新运行缺失的那个工作流即可补齐资源；先完成的一侧会保留已上传的文件。

`package.json`、`electron-builder.yml` 与相关工作流的约束由
[`scripts/release-assets.test.cjs`](../scripts/release-assets.test.cjs) 和
[`scripts/release-delivery-policy.test.cjs`](../scripts/release-delivery-policy.test.cjs) 覆盖，
随后者一起由 `pnpm run test:release-artifacts` 执行。打包命令始终带 `--publish never`，
不在 `electron-builder.yml` 中声明 `publish:`，发布动作只发生在工作流的发布任务里。

## 校验安装包

```bash
# macOS
shasum -a 256 TwilightEcho-1.3.1-mac-arm64.dmg
cat TwilightEcho-1.3.1-mac-arm64.dmg.sha256
xattr -dr com.apple.quarantine /Applications/TwilightEcho.app   # 未公证时的首次启动

# Linux
sha256sum -c TwilightEcho-1.3.1.AppImage.sha256
chmod +x TwilightEcho-1.3.1.AppImage
```

Windows 侧继续使用 `Get-FileHash`，并保留发布页的 `.sha256` 附件。

## 平台能力说明

macOS 与 Linux 安装包可以构建、安装和启动，但 CoreAudio 与 ALSA 后端尚未完成与 Windows
同等级的发布验证和真实设备验证。发布说明与 README 必须继续如实标注这一点，不能把
“可以产出安装包”表述为“音频后端已验证”。

## Windows 安装包

Windows 安装包目前仍由本地发布门禁生成：

```powershell
pnpm run gate:release:win
```

产出 `dist/TwilightEcho-<version>-setup.exe` 与同名 `.sha256`，
再作为普通资源上传到同一 Release。应用内更新会优先选择 `*-setup.exe` 并校验 SHA-256，
缺少校验和时拒绝下载。
