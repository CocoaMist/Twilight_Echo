# 控件样式与 Token 契约

本文记录共享控件的几何、语义色与回归约束。整体设计原则见 [设计系统](./apple-music-inspired-hifi-player-design-system.md)。

## 统一原则

- **单一事实来源**：所有交互控件的几何与语义色都落在 `assets/base.css` 的
  `--te-control-*` / `--te-switch-*` / `--te-badge-*` token 上。
- **不新增硬编码颜色**：组件样式只消费 token；颜色仍由主题运行时注入，浅色 / 深色 /
  主题预设全部照常工作（`themeColorAudit` 守卫）。
- **组件作用域优先**：跨组件的类只在定义处改成 token，不引入 `!important`，不用全局
  覆盖去压倒 scoped 样式。`base.css` 只补「未被任何组件样式覆盖时的兜底几何」。
- **尺寸归一到刻度，而非一刀切**：每个控件吸附到最近的 token 档位（`sm/md/lg/field`），
  保留各 surface 的合理大小差异，同时消除「26/30/32/33/34/36/38/40/42/46」这类随手值。

## Token 契约

定义位置：`src/renderer/src/assets/base.css` 的 `:root`。

### 通用控件几何

| Token                                             | 值                                               | 用途                            |
| ------------------------------------------------- | ------------------------------------------------ | ------------------------------- |
| `--te-control-radius-sm`                          | `8px`                                            | 紧凑按钮 / 字段 / 菜单项        |
| `--te-control-radius-md`                          | `var(--te-radius-global)` 10px                   | 标准按钮 / 菜单容器             |
| `--te-control-radius-lg`                          | `12px`                                           | 分段容器 / 大按钮 / 对话面板    |
| `--te-control-radius-pill`                        | `999px`                                          | 胶囊按钮 / 开关 / 圆形图标按钮  |
| `--te-control-height-sm`                          | `28px`                                           | 紧凑控件（工具条 / 选择按钮）   |
| `--te-control-height-md`                          | `34px`                                           | 标准控件（图标按钮 / 常规按钮） |
| `--te-control-height-lg`                          | `40px`                                           | 大控件（主行动按钮 / 传输按钮） |
| `--te-control-height-field`                       | `36px`                                           | 输入框 / 选择框 / 工具触发器    |
| `--te-control-pad-x-sm/md/lg`                     | `10 / 14 / 18px`                                 | 横向内边距                      |
| `--te-control-gap`                                | `8px`                                            | 图标与文字间距                  |
| `--te-control-font-size`                          | `var(--te-font-size-body)`                       | 标准字号                        |
| `--te-control-font-size-sm`                       | `calc(var(--te-font-size-body, 14px) * 12 / 14)` | 随界面字号缩放的紧凑字号        |
| `--te-control-font-weight` / `-strong` / `-bold`  | `500 / 600 / 700`                                | 字重                            |
| `--te-control-border-width`                       | `1px`                                            | 描边                            |
| `--te-control-focus-width` / `-offset` / `-color` | `2px / 2px / accent`                             | 焦点环                          |

### 语义色

`--te-control-bg`、`--te-control-bg-hover`、`--te-control-bg-active`、`--te-control-fg`、
`--te-control-fg-muted`、`--te-control-border`、`--te-control-accent`、`--te-control-accent-soft`、
`--te-control-accent-line`、`--te-control-accent-text`、`--te-control-on-accent`、
`--te-control-danger`、`--te-control-danger-soft`、`--te-control-on-danger`。

主题运行时根据最终生效的强调色和卡片背景计算实心按钮及软按钮文字色。
普通文字目标对比度为 4.5:1，软按钮同时覆盖默认和悬停状态；危险按钮独立计算文字色，
避免亮色强调色所需的深色文字被误用到红色按钮上。

### 开关几何（三个 family 共用）

`--te-switch-width`(40) `--te-switch-height`(22) `--te-switch-inset`(3) `--te-switch-thumb`(16)
`--te-switch-travel`(18)，以及 `.large` 变体 `-lg`（48 / 28 / 4 / 20 / 20）；
颜色侧 `--te-switch-track` `--te-switch-track-active` `--te-switch-thumb-bg` `--te-switch-thumb-shadow`。
带 1px 描边的开关用 `calc(var(--te-switch-inset) - var(--te-control-border-width))` 保持视觉居中。

### 徽标几何

`--te-badge-radius`(pill)、`--te-badge-pad-x`(8) `--te-badge-pad-y`(2)、
`--te-badge-font-size`（默认 12，随界面字号缩放）`--te-badge-font-weight`(600)。

### 对话框

对话框消费 `--te-dialog-radius`，保留 Pxasen 的 **`8px`** 默认值，与主题注册表一致；
用户主题和预设仍可覆盖该值。

## 控件差异

统一的是**刻度与语义**，不是把每个 surface 抹平。以下差异是设计意图，不应被「统一」掉：

- **形状**：播放栏 `.icon-btn` 是圆形（pill），插件页 `.icon-btn` 是圆角方形（sm）——
  前者悬浮在内容上，后者是列表内工具。
- **尺寸档位**：标题栏窗口控制按钮、仪表盘 `.transport-button`(46px) 属于大号传输控件，
  保留大尺寸；`.sf-play-button` 主播放按钮仍有强调尺寸。
- **配色**：`.deck-*` 侧栏、`.stage-*` 流媒体舞台、`.an-*` 仪表盘、`.onb-*` 引导页各自
  持有独立调色板，几何使用共享刻度，配色沿用其 surface token。
- **状态**：`.menu-item.danger`、`.badge.http` 等语义变体保留各自的危险/告警色。

## 防回归守卫

`src/renderer/src/components/uiPrimitiveTokens.test.ts`锁定上述 token 使用；
`uiPrimitiveTokens.behavior.test.ts` 在真实 Electron 中验证 12/14/20px 字号、
六种强调色与深浅色、软按钮悬停对比度及关闭开关滑钮。两者均接入 `test:themes`。
