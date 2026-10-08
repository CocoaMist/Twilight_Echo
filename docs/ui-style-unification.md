# UI 风格统一（Style Unification）

> 状态：全量落地（token 契约 + 按钮 / 开关 / 徽标 / 字段 / 菜单 / 对话框）· 2026-10-09
> 关联：`docs/apple-music-inspired-hifi-player-design-system.md`、`output/ui-inventory-before/`、`output/ui-inventory-after/`

---

## 1. 背景

用 CDP 驱动真实应用做了一次全量 UI 元素盘点（见 `output/ui-inventory/`），确认了几类明显分歧：

1. **开关**：`.toggle-switch` 40×20、`.deck-switch` 40×22、`.onb-toggle` 42×22，滑钮 16/16/18 三套值。
2. **按钮**：`.primary-button` 甚至没有基础样式（只在 `pureWhite` 下拿到背景色）；`.pill-action` 在设置页与网络源页各写一套；`.soft-button` / `.icon-button` / `.brand-soft-button` / `.danger-soft-button` / `.selection-btn` / `.deck-btn` / `.stage-btn` / `.studio-icon-button` 等数十个族的圆角、高度、内边距、字号、过渡时长各自手写。
3. **徽标**：`.badge` 在插件页是 12px/600/100px，在电台页是 10px/750/999px；`.stat-badge` / `.library-tools-badge` / `.workshop-badge` 又各一套。
4. **表单字段**：高度在 30–38、圆角在 4–10 之间漂移。
5. **菜单**：`.menu-item`（右键菜单）padding 10/12、圆角 10；`.provider-switcher-option` 圆角 9；`.palette-row` 圆角 8；`.library-tools-option` padding 8/10。
6. **对话框**：实际渲染圆角在 8–20 之间跳动。

## 2. 统一原则

- **单一事实来源**：所有交互控件的几何与语义色都落在 `assets/base.css` 的
  `--te-control-*` / `--te-switch-*` / `--te-badge-*` token 上。
- **不新增硬编码颜色**：组件样式只消费 token；颜色仍由主题运行时注入，浅色 / 深色 /
  主题预设全部照常工作（`themeColorAudit` 守卫）。
- **组件作用域优先**：跨组件的类只在定义处改成 token，不引入 `!important`，不用全局
  覆盖去压倒 scoped 样式。`base.css` 只补「未被任何组件样式覆盖时的兜底几何」。
- **尺寸归一到刻度，而非一刀切**：每个控件吸附到最近的 token 档位（`sm/md/lg/field`），
  保留各 surface 的合理大小差异，同时消除「26/30/32/33/34/36/38/40/42/46」这类随手值。

## 3. Token 契约

定义位置：`src/renderer/src/assets/base.css` 的 `:root`。

### 3.1 通用控件几何

| Token | 值 | 用途 |
| --- | --- | --- |
| `--te-control-radius-sm` | `8px` | 紧凑按钮 / 字段 / 菜单项 |
| `--te-control-radius-md` | `var(--te-radius-global)` 10px | 标准按钮 / 菜单容器 |
| `--te-control-radius-lg` | `12px` | 分段容器 / 大按钮 / 对话面板 |
| `--te-control-radius-pill` | `999px` | 胶囊按钮 / 开关 / 圆形图标按钮 |
| `--te-control-height-sm` | `28px` | 紧凑控件（工具条 / 选择按钮） |
| `--te-control-height-md` | `34px` | 标准控件（图标按钮 / 常规按钮） |
| `--te-control-height-lg` | `40px` | 大控件（主行动按钮 / 传输按钮） |
| `--te-control-height-field` | `36px` | 输入框 / 选择框 / 工具触发器 |
| `--te-control-pad-x-sm/md/lg` | `10 / 14 / 18px` | 横向内边距 |
| `--te-control-gap` | `8px` | 图标与文字间距 |
| `--te-control-font-size` | `var(--te-font-size-body)` | 标准字号 |
| `--te-control-font-size-sm` | `12px` | 紧凑字号 |
| `--te-control-font-weight` / `-strong` / `-bold` | `500 / 600 / 700` | 字重 |
| `--te-control-border-width` | `1px` | 描边 |
| `--te-control-focus-width` / `-offset` / `-color` | `2px / 2px / accent` | 焦点环 |

### 3.2 语义色

`--te-control-bg`、`--te-control-bg-hover`、`--te-control-bg-active`、`--te-control-fg`、
`--te-control-fg-muted`、`--te-control-border`、`--te-control-accent`、`--te-control-accent-soft`、
`--te-control-accent-line`、`--te-control-on-accent`、`--te-control-danger`、`--te-control-danger-soft`。

### 3.3 开关几何（三个 family 共用）

`--te-switch-width`(40) `--te-switch-height`(22) `--te-switch-inset`(3) `--te-switch-thumb`(16)
`--te-switch-travel`(18)，以及 `.large` 变体 `-lg`（48 / 28 / 4 / 20 / 20）；
颜色侧 `--te-switch-track` `--te-switch-track-active` `--te-switch-thumb-bg` `--te-switch-thumb-shadow`。
带 1px 描边的开关用 `calc(var(--te-switch-inset) - var(--te-control-border-width))` 保持视觉居中。

### 3.4 徽标几何

`--te-badge-radius`(pill)、`--te-badge-pad-x`(8) `--te-badge-pad-y`(2)、
`--te-badge-font-size`(12) `--te-badge-font-weight`(600)。

### 3.5 对话框

`--te-dialog-radius` 由 `8px` 调整为 **`16px`**，成为所有对话框圆角的唯一来源。

## 4. 改动清单

### 4.1 token 与全局基座 — `assets/base.css`

- 新增全部控件 token。
- 新增共享按钮兜底几何（`:where(...)` 零优先级，仅在无组件样式时生效）。
- 新增 `.primary-button` 基础样式（此前在非 `pureWhite` 主题下没有背景色）。
- `input[type='checkbox']` 浅色下也改为自绘方框（与深色一致），统一 4px 圆角、accent 勾选、focus ring、disabled；
  `input[type='radio']` / `input[type='range']` 统一 accent-color。
- `--te-dialog-radius` 8px → 16px。

### 4.2 开关

| 文件 | 类 |
| --- | --- |
| `settings-page/SettingsPage.css` | `.toggle-switch`（含 `.large`） |
| `player-bar/HiFiSidebar.css` | `.deck-switch` / `.deck-switch-knob` |
| `onboarding/OnboardingWizard.css` | `.onb-toggle` |

### 4.3 按钮族

| 文件 | 类 |
| --- | --- |
| `settings-page/SettingsPage.css` | `.soft-button` `.muted-button` `.brand-soft-button` `.danger-soft-button` `.icon-button` `.dashed-button` `.segmented-control` 按钮 `.preset-btn` |
| `player-bar/PlayerBar.css` | `.icon-btn` `.ctrl-btn` `.playlist-tool-btn` |
| `player-bar/HiFiSidebar.css` | `.deck-btn` |
| `song-list/SongList.css` | `.selection-btn` `.dialog-btn` `.recent-source-option` `.library-tools-option` `.excluded-tracks-trigger` |
| `streaming-page/StreamingPage.css` / `StreamingSearch.vue` | `.selection-btn` `.pager-btn` |
| `streaming-page/StreamingDetailStage.css` | `.stage-btn` `.stage-mini-btn` `.row-play-btn` |
| `streaming-page/StreamingProviderSwitcher.vue` | `.provider-switcher-option` |
| `PluginPage.vue` | `.btn` `.btn-outline` `.btn-primary` `.icon-btn` `.badge` |
| `theme-studio/ThemeStudioPage.css` | `.studio-icon-button` |
| `local-dashboard/SoundFieldHome.css` | `.sf-icon-button` / `.sf-play-button` |
| `local-dashboard/OnlineHome.css` | `.online-text-button` |
| `ListeningAnalyticsPage.css` | `.an-button` `.an-icon-button` |
| `NcmCloudPanel.vue` | `.cloud-button` `.icon-button` |
| `LyricsAppearanceCustomizer.vue` | `.icon-button` |
| `tray-player/TrayPlayerApp.vue` | `.icon-button` |

### 4.4 徽标 / 菜单 / 字段 / 对话框

| 文件 | 类 |
| --- | --- |
| `PluginPage.vue` / `RadioPodcastPage.vue` | `.badge` |
| `StreamingLibrary.vue` | `.stat-badge` |
| `song-list/SongList.css` | `.library-tools-badge` |
| `theme-workshop/ThemeWorkshopEnhancements.css` | `.workshop-badge` |
| `song-list/SongList.css` / `streaming-page/StreamingContextMenu.vue` | `.menu-item`（右键菜单） |
| `CommandPalette.vue` | `.palette-row` |
| `settings-page/SettingsPage.css` | `.preview-select` `.number-input` `.path-control input` `.segmented-control` |
| `ImportDialog.vue` / `TrackInfoDialog.vue` / `player-bar/QueueWorkspaceDialog.vue` | 对话框圆角 → `var(--te-dialog-radius)` |

### 4.5 防回归守卫

`src/renderer/src/components/uiPrimitiveTokens.test.ts`（5 项）锁定上述 token 使用，
已接入 `pnpm run test:themes`。

## 5. 验证

- `pnpm run test:themes`：**267/268 通过**。唯一失败
  「Linux playbar accessibility preferences override the backdrop fallback」与本次改动无关
  （它只在隔离 fixture 里编译 `PlayerBar.css`，失败原因是当前无 GPU 环境下 Electron 把
  `backdrop-filter` 计算为 `none`）。
- 新增 `uiPrimitiveTokens.test.ts`：5/5 通过。
- `eslint` 改动文件：0 error。
- 前后截图对比：`output/ui-inventory-before` → `output/ui-inventory-after`。
  **21/49 张页面发生变化，138/260 张元素切片变化**，集中在按钮 / 开关 / 徽标 / 字段 /
  菜单，无空白页。
- 运行时实测（CDP 计算样式）：开关 40×22、分段控件 28/8/12/600、图标按钮 34×34、
  字段 36/8、主按钮 34/10，均按 token 生效。

## 6. 仍然有意保留的差异

统一的是**刻度与语义**，不是把每个 surface 抹平。以下差异是设计意图，不应被「统一」掉：

- **形状**：播放栏 `.icon-btn` 是圆形（pill），插件页 `.icon-btn` 是圆角方形（sm）——
  前者悬浮在内容上，后者是列表内工具。
- **尺寸档位**：标题栏窗口控制按钮、仪表盘 `.transport-button`(46px) 属于大号传输控件，
  保留大尺寸；`.sf-play-button` 主播放按钮仍有强调尺寸。
- **配色**：`.deck-*` 侧栏、`.stage-*` 流媒体舞台、`.an-*` 仪表盘、`.onb-*` 引导页各自
  持有独立调色板，本次只统一几何，配色沿用其 surface token。
- **状态**：`.menu-item.danger`、`.badge.http` 等语义变体保留各自的危险/告警色。

后续若继续收口，建议按「先换 token、再跑前后截图」的节奏逐个 surface 复核，
`uiPrimitiveTokens.test.ts` 会在几何值再次写死时报错。
