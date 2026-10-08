# UI 风格统一（Style Unification）

> 状态：第一批已落地（token 契约 + 开关 / 按钮 / 徽标 / 对话框）· 2026-10-09
> 关联：`docs/apple-music-inspired-hifi-player-design-system.md`、`output/ui-inventory-before/`、`output/ui-inventory-after/`

---

## 1. 背景

用 CDP 驱动真实应用做了一次全量 UI 元素盘点（见 `output/ui-inventory/`），确认了几类明显分歧：

1. **开关**：`.toggle-switch`（40×20 / 滑钮 16）、`.deck-switch`（40×22 / 滑钮 16）、
   `.onb-toggle`（42×22 / 滑钮 18）三套几何值、三种激活色。
2. **按钮**：`.primary-button` 甚至没有基础样式（只在 `pureWhite` 下拿到背景色）；
   `.pill-action` 在设置页与网络源页各写一套；`.soft-button` / `.icon-button` /
   `.brand-soft-button` / `.danger-soft-button` 圆角、字号、内边距、过渡时长各异。
3. **徽标**：`.badge`（插件页 12px/600/圆角 100px）与 `.badge`（电台页 10px/750/圆角 999）
   同名不同形。
4. **表单字段**：选择框 / 输入框高度在 34–38 之间漂移，圆角在 6–8 之间漂移。
5. **对话框**：`--te-dialog-radius` 名义值是 8px，但导入对话框写死 20px、曲目信息 20px、
   队列工作区 16px、导航编辑用 token（→8px），实际渲染在 8–20 之间跳动。

## 2. 统一原则

- **单一事实来源**：所有交互控件的几何与语义色都落在 `assets/base.css` 的
  `--te-control-*` / `--te-switch-*` / `--te-badge-*` token 上。
- **不新增硬编码颜色**：组件样式只消费 token；颜色仍由主题运行时注入，浅色 / 深色 /
  主题预设全部照常工作（`themeColorAudit` 守卫）。
- **组件作用域优先**：跨组件的类只在定义处改成 token，不引入 `!important`，不回退到
  全局覆盖。`base.css` 只补「未被任何组件样式覆盖时的兜底几何」。

## 3. Token 契约

定义位置：`src/renderer/src/assets/base.css` 的 `:root`。

### 3.1 通用控件几何

| Token | 值 | 用途 |
| --- | --- | --- |
| `--te-control-radius-sm` | `8px` | 紧凑按钮 / 字段 |
| `--te-control-radius-md` | `var(--te-radius-global)` 10px | 标准按钮 |
| `--te-control-radius-lg` | `12px` | 分段容器 / 大按钮 |
| `--te-control-radius-pill` | `999px` | 胶囊按钮 / 开关 |
| `--te-control-height-sm` | `28px` | 紧凑控件 |
| `--te-control-height-md` | `34px` | 标准控件 |
| `--te-control-height-lg` | `40px` | 大控件 |
| `--te-control-height-field` | `36px` | 输入框 / 选择框 |
| `--te-control-pad-x-sm/md/lg` | `10 / 14 / 18px` | 横向内边距 |
| `--te-control-gap` | `8px` | 图标与文字间距 |
| `--te-control-font-size` | `var(--te-font-size-body)` | 标准字号 |
| `--te-control-font-size-sm` | `12px` | 紧凑字号 |
| `--te-control-font-weight` / `-strong` | `500 / 600` | 字重 |
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

## 4. 本批改动清单

| 文件 | 改动 |
| --- | --- |
| `assets/base.css` | 新增全部控件 token；新增共享按钮兜底几何；新增 `.primary-button` 基础样式；`--te-dialog-radius` → 16px |
| `settings-page/SettingsPage.css` | `.toggle-switch`、`.pill-action`、`.soft-button`/`.muted-button`/`.danger-soft-button`/`.brand-soft-button`/`.icon-button`/`.dashed-button`、`.segmented-control`、`.preview-select`/`.number-input`、`.path-control input`、设置页焦点环 → token |
| `player-bar/HiFiSidebar.css` | `.deck-switch` / `.deck-switch-knob` → token（保留 deck 自有配色） |
| `onboarding/OnboardingWizard.css` | `.onb-toggle` → token（保留 `--onb-accent` 配色） |
| `PluginPage.vue` | `.badge` → token |
| `RadioPodcastPage.vue` | `.badge` → token |
| `NetworkSourcesPage.vue` | `.pill-action` → token |
| `ImportDialog.vue` / `TrackInfoDialog.vue` / `player-bar/QueueWorkspaceDialog.vue` | 对话框圆角 → `var(--te-dialog-radius)` |
| `uiPrimitiveTokens.test.ts`（新增） | 防回归守卫，已加入 `pnpm run test:themes` |

## 5. 验证

- `pnpm run test:themes`：262/263 通过。唯一失败
  「Linux playbar accessibility preferences override the backdrop fallback」与本次改动无关
  （它只在隔离 fixture 里编译 `PlayerBar.css`，该文件未被修改；失败原因是当前无 GPU 环境下
  Electron 把 `backdrop-filter` 计算为 `none`）。
- 新增 `uiPrimitiveTokens.test.ts`：4/4 通过。
- 前后截图对比：`output/ui-inventory-before` → `output/ui-inventory-after`。
  设置页变化 2–9%，元素切片 94/260 发生变化，集中在开关 / 按钮 / 字段 / 分段控件，
  与预期一致；无空白页。

## 6. 剩余待办（下一批）

以下按钮族仍是各组件自带样式，尚未纳入 token（按使用量排序）：

`soft-button`(32) · `icon-button`(25) · `selection-btn`(15) · `deck-btn`(15) ·
`brand-soft-button`(12) · `stage-mini-btn`(11) · `studio-icon-button`(10) · `icon-btn`(10) ·
`btn-primary`(7) · `stage-btn`(6) · `pager-btn`(6) · `online-text-button`(6) · `cloud-button`(6) ·
`btn-outline`(6) · `muted-button`(5) · `danger-soft-button`(5) …

建议按「家族 → 定义处 → 视觉回归截图」的节奏逐批替换为 `--te-control-*`。
新增组件请直接复用 token；`uiPrimitiveTokens.test.ts` 会在几何值再次写死时报错。

### 建议的下一步

1. 玩家栏 / 播放页按钮族（`deck-btn`、`icon-btn`、`transport-button`）。
2. 列表行内操作（`row-play-btn`、`selection-btn`、`library-tools-trigger`）。
3. 各页面顶部工具栏按钮（`stage-btn*`、`pager-btn`、`studio-icon-button`）。
4. 统一后把 `theme-color-allowlist.json` 中各文件的颜色基线逐步下调。
