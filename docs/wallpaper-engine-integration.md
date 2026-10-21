# Wallpaper Engine 动态壁纸

在包含本桥接的 Twilight Echo 中，通过「设置 → 插件 → 本地安装」安装
`com.twilightecho.tool.wallpaper-engine-2.1.0.tep`，启用插件并重启应用。
打开「设置 → 外观 → 背景与材质」，在上方的「动态壁纸」中选择壁纸并点击「应用」。
新版外观工作区打开「背景与材质」详细设置时，也会显示同一控制块。

找不到壁纸时，在插件的设置面板填写「额外壁纸目录」并刷新列表。
视频和网页由插件静音；网页交互模式通过右上角「退出交互」返回应用。
X/Y/Z 和缩放立即更新；壁纸属性只在应用所选壁纸后加载，修改会实时下发并由插件保存。
「关闭」恢复应用原有背景，不改动已保存的外观设置。
视频首帧就绪后才替换原背景；加载或播放失败时保留原背景并显示原因。
动态壁纸只替换窗口和页面的背景绘制层，保留主题底色、材质透明度和编辑弹窗的实色底板。
外观编辑器的独立预览不继承动态壁纸激活状态，草稿背景与材质仍按预览设置绘制。

### 显示“已应用”却黑屏

更新应用构建后，完整退出 Twilight Echo（包括托盘进程）再启动。
仅刷新页面不能更新主进程的 CSP 响应头。旧响应头仍可能拦截视频、网页和预览图，
即使新的 `index.html` 已允许它们。桥接遇到该错误会提示完整重启；无需重装 TEP。

## 源码与构建

- `resources/we-background.js`：基于用户提供的 2.1.0 TEP 中
  `patch/we-background.js` 合并，作为 Vite public asset 原样复制到
  `out/renderer/we-background.js`。
- `src/renderer/index.html`：在 head 中加载桥文件。源码使用 `/we-background.js`，
  Vite 构建后转换为 `./we-background.js`。
- `src/main/security/electronSecurity.ts`：设置应用文档的 CSP 响应头。
- meta CSP 和响应头的 `frame-src`、`img-src`、`media-src`、`connect-src`
  均允许 `http://127.0.0.1:3100`；没有开放任意 HTTP 来源或 `unsafe-eval`。

桥仅在主窗口运行。未连接到返回有效 `/api/state` 的插件服务时，不插入设置控件，
也不替换应用背景。插件连续不可用约 16 秒后恢复应用背景；服务恢复后重新加载壁纸。
插件本体仍单独通过 TEP 安装，本仓库不内置插件服务或壁纸引擎。

当前主机适配还包括：设置背景伪元素、可见的「背景与材质」锚点、暂停/继续、
关闭后重新应用、实时位置更新，以及无需动态执行脚本的 WE 属性条件解释器。
条件支持属性 `.value`、布尔/数字/字符串、括号、比较、逻辑和基本算术运算；
无法识别的表达式保留属性可见。属性只向当前壁纸 iframe 的固定 loopback origin 下发。

## 验证

```powershell
pnpm run test:wallpaper-engine
```

测试在隔离 Electron profile 中安装真实 CSP 响应头和 meta CSP，使用本地 HTTP
夹具验证静音视频解码、网页/场景 iframe 路径、预览图、实时布局与属性、
暂停/继续、交互退出、关闭后恢复、旧/新外观锚点和附属窗口隔离。
另覆盖首帧前保留原背景、媒体加载失败后重试，以及旧主进程 CSP 拦截和更新后恢复。
检查深浅色和透明窗口下的编辑弹窗底板、共享材质变量保留及材质透明度调节。
隔离会话将固定 `3100` 来源路由到临时端口夹具，不占用或修改正在运行的插件服务。
场景测试覆盖桥接和 CSP，不代替真实 WE `scene.pkg` 的 WebWallGL 渲染验收。

设置 `TWILIGHT_WALLPAPER_EVIDENCE_DIR` 可保存控件截图。
发布前按正常构建流程生成新应用包；无需再对已安装的 `app.asar` 手工打补丁。
