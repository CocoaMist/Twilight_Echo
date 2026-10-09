import {
  DSD_OUTPUT_MODE_OPTIONS,
  DSD_RATE_POLICY_OPTIONS,
  VOLUME_NORMALIZATION_OPTIONS
} from '../../../../shared/audioProcessingOptions.ts'
import type {
  PlayerBarMode,
  PlayerBarPageMode,
  PlayerBarPageVisibility,
  PlayerBarVisibility
} from '../../../../shared/playerBar.ts'
import type { PlayerBarControlId, PlayerBarRegionName } from '../../../../shared/playerBarLayout.ts'
import type {
  AppTheme,
  AppBackgroundPage,
  ChannelRoutingMode,
  DesktopLyricsSettings,
  LyricsAppearanceAlign,
  LyricsAppearanceFontFamily,
  LyricsFocusLineCount,
  MotionPreference,
  NcmPlaybackQuality,
  PlaybackResumeMode,
  PreviousButtonAction,
  SacdProgramMode,
  StartupHomePage,
  TrackActivationMode,
  StreamingAudioCachePolicy,
  UiDensity
} from '../../types/settings'
import { DEFAULT_DESKTOP_LYRICS_SETTINGS } from '../../../../shared/desktopLyrics.ts'
import type { AppFontFamily } from '../../../../shared/appFont.ts'

export type SectionKey =
  | 'general'
  | 'playback'
  | 'dsp'
  | 'cache'
  | 'performance'
  | 'appearance'
  | 'desktopLyrics'
  | 'shortcuts'
  | 'about'

export type BooleanSettingKey =
  | 'autoCheckLogin'
  | 'launchAtLogin'
  | 'hardwareAcceleration'
  | 'proxyAllowDirectFallback'
  | 'windowTransparency'
  | 'useCoverTheme'
  | 'globalShortcuts'
  | 'watchLibrary'
  | 'onlineLyricsFallback'
  | 'smtcEnabled'
  | 'taskbarThumbarButtonsEnabled'
  | 'discordRpcEnabled'
  | 'remoteControlEnabled'
  | 'developerMode'

export const sections: { key: SectionKey; label: string; icon: string; description?: string }[] = [
  { key: 'general', label: '常规', icon: 'pi pi-sliders-h' },
  { key: 'playback', label: '播放', icon: 'pi pi-volume-up' },
  {
    key: 'dsp',
    label: '音效',
    icon: 'pi pi-sliders-v',
    description: '均衡器、响度与声音处理（DSP）'
  },
  { key: 'cache', label: '缓存', icon: 'pi pi-database' },
  { key: 'performance', label: '性能', icon: 'pi pi-bolt' },
  { key: 'appearance', label: '外观', icon: 'pi pi-palette' },
  { key: 'desktopLyrics', label: '桌面歌词', icon: 'pi pi-window-maximize' },
  { key: 'shortcuts', label: '快捷键', icon: 'pi pi-key' },
  { key: 'about', label: '关于', icon: 'pi pi-info-circle' }
]

export const colorModeOptions: { value: AppTheme; label: string; icon: string }[] = [
  { value: 'system', label: '系统', icon: 'pi pi-desktop' },
  { value: 'pureWhite', label: '浅色', icon: 'pi pi-sun' },
  { value: 'dark', label: '深色', icon: 'pi pi-moon' }
]

export const motionPreferenceOptions: { value: MotionPreference; label: string }[] = [
  { value: 'system', label: '跟随系统' },
  { value: 'full', label: '完整动效' },
  { value: 'reduced', label: '减少动效' },
  { value: 'off', label: '关闭动效' }
]

export const playbackResumeOptions: { value: PlaybackResumeMode; label: string }[] = [
  { value: 'off', label: '关闭' },
  { value: 'track', label: '记住曲目' },
  { value: 'trackAndPosition', label: '曲目和位置' }
]

export const previousButtonActionOptions: { value: PreviousButtonAction; label: string }[] = [
  { value: 'restart', label: '重播当前歌曲' },
  { value: 'previous', label: '切换到上一首' }
]

export const ncmPlaybackQualityOptions: { value: NcmPlaybackQuality; label: string }[] = [
  { value: 'auto', label: '自动（最高可用）' },
  { value: 'standard', label: '标准' },
  { value: 'exhigh', label: '极高' },
  { value: 'lossless', label: '无损' },
  { value: 'hires', label: 'Hi-Res' }
]

export const startupHomePageOptions: { value: StartupHomePage; label: string; icon: string }[] = [
  { value: 'local', label: '本地音乐主页', icon: 'pi pi-home' },
  { value: 'streaming', label: '流媒体主页', icon: 'pi pi-compass' }
]

export const trackActivationModeOptions: {
  value: TrackActivationMode
  label: string
  icon: string
}[] = [
  { value: 'singleClick', label: '单击播放', icon: 'pi pi-bolt' },
  { value: 'doubleClick', label: '双击播放', icon: 'pi pi-clone' }
]

export const bufferSizeOptions = [
  { value: 0, label: '自动（推荐）' },
  { value: 64, label: '64' },
  { value: 128, label: '128' },
  { value: 256, label: '256' },
  { value: 512, label: '512' },
  { value: 1024, label: '1024' },
  { value: 2048, label: '2048' }
] as const

export const routingModeOptions: { value: ChannelRoutingMode; label: string }[] = [
  { value: 'auto', label: '自动（推荐）' },
  { value: 'stereo', label: '立体声' },
  { value: 'stereo-to-5.1', label: '立体声转 5.1 声道' },
  { value: 'stereo-to-7.1', label: '立体声转 7.1 声道' },
  { value: 'mono-to-stereo', label: '单声道转立体声' },
  { value: 'mono-to-multichannel', label: '单声道转多声道' }
]

export const pcmToDsdModeOptions: {
  value: import('../../types/settings').PcmToDsdMode
  label: string
}[] = [
  { value: 'off', label: '关闭' },
  { value: 'dsd64', label: 'DSD64' },
  { value: 'dsd128', label: 'DSD128' },
  { value: 'dsd256', label: 'DSD256' }
]

export const replayGainOptions = VOLUME_NORMALIZATION_OPTIONS.map((option) => ({
  ...option,
  label: {
    off: '关闭',
    track: '按曲目标签',
    album: '按专辑标签',
    loudnorm: '测量响度（Loudnorm）'
  }[option.value]
}))
export const dsdOutputModeOptions = DSD_OUTPUT_MODE_OPTIONS
export const dsdRatePolicyOptions = DSD_RATE_POLICY_OPTIONS

export const sacdProgramModeOptions: { value: SacdProgramMode; label: string }[] = [
  { value: 'auto', label: '自动（推荐）' },
  { value: 'stereo', label: '立体声' },
  { value: 'multichannel', label: '多声道' }
]

export const fftResolutionOptions = [64, 128, 256, 512, 1024, 2048, 4096, 8192] as const

export const accentColorOptions: { value: string; label: string; class: string }[] = [
  { value: 'violet', label: '紫罗兰', class: 'violet' },
  { value: 'blue', label: '蓝', class: 'blue' },
  { value: 'emerald', label: '翠绿', class: 'emerald' },
  { value: 'rose', label: '玫瑰', class: 'rose' },
  { value: 'amber', label: '琥珀', class: 'amber' },
  { value: 'slate', label: '石板', class: 'slate' }
]

export const fontFamilyOptions: { value: AppFontFamily; label: string }[] = [
  { value: 'system', label: '默认（跟随主题）' },
  { value: 'inter', label: 'Inter / Roboto' },
  { value: 'lxgw', label: '霞鹜文楷 (LXGW)' },
  { value: 'sarasa', label: 'Sarasa Gothic' },
  { value: 'comic', label: 'Comic Sans MS' }
]

export const lyricsAppearanceFontFamilyOptions: {
  value: LyricsAppearanceFontFamily
  label: string
}[] = [
  { value: 'inherit', label: '跟随界面字体' },
  { value: 'system', label: '系统默认 (System)' },
  { value: 'inter', label: 'Inter / Roboto' },
  { value: 'lxgw', label: '霞鹜文楷 (LXGW)' },
  { value: 'sarasa', label: 'Sarasa Gothic' },
  { value: 'comic', label: 'Comic Sans MS' },
  { value: 'custom', label: '自定义字体（在播放页设置）' }
]

export const lyricsFocusLineCountOptions: { value: LyricsFocusLineCount; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 1, label: '1 行' },
  { value: 3, label: '3 行' },
  { value: 5, label: '5 行' }
]

export const uiDensityOptions: { value: UiDensity; label: string }[] = [
  { value: 'compact', label: '紧凑' },
  { value: 'standard', label: '标准' },
  { value: 'comfortable', label: '舒展' }
]

export const appBackgroundPageOptions: { value: AppBackgroundPage; label: string; desc: string }[] =
  [
    { value: 'local', label: '本地主页', desc: '本地音乐首页和资料概览背景。' },
    { value: 'settings', label: '设置与插件', desc: '设置页、插件中心等管理界面背景。' },
    { value: 'streaming', label: '流媒体页', desc: '在线音乐浏览、搜索和详情页背景。' },
    { value: 'player', label: '播放页', desc: '沉浸式播放页和全屏播放背景。' }
  ]

export const lyricAlignOptions: { value: LyricsAppearanceAlign; label: string }[] = [
  { value: 'center', label: '居中对齐' },
  { value: 'left', label: '靠左对齐' },
  { value: 'right', label: '靠右对齐' }
]

export const streamingAudioCachePolicyOptions: {
  value: StreamingAudioCachePolicy
  label: string
}[] = [
  { value: 'provider', label: '按音源规则缓存' },
  { value: 'off', label: '不缓存流媒体音频' }
]

export const playerBarModeOptions: { value: PlayerBarMode; label: string; icon: string }[] = [
  { value: 'standard', label: '标准', icon: 'pi pi-window-maximize' },
  { value: 'mini', label: '细长', icon: 'pi pi-window-minimize' },
  { value: 'compact', label: '紧凑', icon: 'pi pi-minus' }
]

export const playerBarPageModeOptions: { value: PlayerBarPageMode; label: string }[] = [
  { value: 'inherit', label: '跟随全局形态' },
  { value: 'standard', label: '标准' },
  { value: 'mini', label: '细长（可自动隐藏）' },
  { value: 'compact', label: '紧凑（可自动隐藏）' }
]

/**
 * Labels for the controls the playbar layout can place. Lives here rather than in
 * the shared contract for the same reason the mode options do: `src/shared` holds
 * the structure, the renderer holds the copy.
 */
export const playerBarControlOptions: {
  value: PlayerBarControlId
  label: string
  icon: string
  /** Why this control may render nothing even when it is placed. */
  hint?: string
}[] = [
  { value: 'cover', label: '封面', icon: 'pi pi-image' },
  { value: 'trackInfo', label: '曲目信息', icon: 'pi pi-align-left' },
  { value: 'transport', label: '上一首 / 播放 / 下一首', icon: 'pi pi-play-circle' },
  { value: 'playPause', label: '单独的播放按钮', icon: 'pi pi-play' },
  { value: 'time', label: '时间读数', icon: 'pi pi-clock' },
  {
    value: 'favorite',
    label: '收藏',
    icon: 'pi pi-heart',
    hint: '仅在当前来源支持收藏时出现'
  },
  { value: 'playMode', label: '播放顺序', icon: 'pi pi-refresh' },
  { value: 'volume', label: '音量', icon: 'pi pi-volume-up' },
  { value: 'queue', label: '播放列表', icon: 'pi pi-list' },
  { value: 'hifi', label: 'HiFi 控制台', icon: 'ph ph-faders' },
  { value: 'equalizer', label: '均衡器', icon: 'ph ph-sliders' },
  { value: 'desktopLyrics', label: '桌面歌词', icon: 'pi pi-window-maximize' },
  { value: 'miniPlayer', label: '独立迷你窗口', icon: 'ph ph-picture-in-picture' },
  {
    value: 'exitPlayingPage',
    label: '退出播放页',
    icon: 'ph ph-arrows-out-simple',
    hint: '仅在播放页出现'
  }
]

export const playerBarRegionOptions: { value: PlayerBarRegionName; label: string }[] = [
  { value: 'left', label: '左侧' },
  { value: 'center', label: '中间' },
  { value: 'right', label: '右侧' }
]

export const playerBarVisibilityOptions: {
  value: PlayerBarVisibility
  label: string
  icon: string
}[] = [
  { value: 'visible', label: '常显', icon: 'pi pi-eye' },
  { value: 'autoHide', label: '自动隐藏', icon: 'pi pi-arrow-down' },
  { value: 'hidden', label: '完全隐藏', icon: 'pi pi-eye-slash' }
]

export const playerBarPageVisibilityOptions: { value: PlayerBarPageVisibility; label: string }[] = [
  { value: 'inherit', label: '跟随全局可见性' },
  { value: 'visible', label: '常显' },
  { value: 'autoHide', label: '自动隐藏（需细长或紧凑形态）' },
  { value: 'hidden', label: '完全隐藏' }
]

export { GITHUB_URL, HOMEPAGE_URL, RELEASES_URL } from '../../../../shared/projectUrls.ts'

export interface SettingsSearchEntry {
  /** 所属设置分区 */
  section: SectionKey
  /** 结果展示标题（设置项名称） */
  title: string
  /** 用于在 DOM 中定位设置项文本；默认取 title */
  match?: string
  /** Local panels to reveal; this never changes persisted settings. */
  reveal?: readonly string[]
  /** A prerequisite row to show if the control is currently unavailable. */
  fallback?: string
  /** 搜索关键词（别名 / 英文 / 相关词，空格分隔） */
  terms: string
}

const sectionTerms: Record<SectionKey, string> = {
  general: '常规 设置 媒体库 启动 集成 网络',
  playback: '播放 输出 引擎',
  dsp: 'DSP 处理器 音效',
  cache: '缓存 存储',
  performance: '性能 优化',
  appearance: '外观 主题 界面',
  desktopLyrics: '桌面歌词 歌词',
  shortcuts: '快捷键 快捷 热键',
  about: '关于 版本 更新'
}

const searchPanels: Record<string, string> = {
  表面着色: 'liquidGlass',
  镜面高光: 'liquidGlass',
  弹性跟随: 'liquidGlass',
  玻璃饱和度: 'liquidGlass',
  玻璃模糊: 'liquidGlass',
  色散强度: 'liquidGlass',
  折射强度: 'liquidGlass',
  首页媒体焦点液态玻璃: 'liquidGlass',
  设置导航液态玻璃: 'liquidGlass',
  播放栏液态玻璃: 'liquidGlass',
  主导航液态玻璃: 'liquidGlass',
  全局液态玻璃: 'liquidGlass',
  歌词颜色: 'lyricsStyle',
  突出显示的歌词行数: 'lyricsStyle',
  未播放歌词淡化程度: 'lyricsStyle',
  歌词行距: 'lyricsStyle',
  歌词字重: 'lyricsStyle',
  歌词对齐: 'lyricsStyle',
  歌词字号: 'lyricsStyle',
  歌词字体: 'lyricsStyle',
  独立迷你窗口: 'miniPlayer',
  声道路由: 'advancedEngine',
  '输出缓冲（帧）': 'advancedEngine',
  播放条形态: 'playerBar',
  播放页形态: 'playerBar',
  播放条可见性: 'playerBar',
  播放页可见性: 'playerBar',
  触发距离: 'playerBar',
  收起延迟: 'playerBar',
  播放条按钮编排: 'playerBarLayout',
  播放页歌词样式: 'lyricsStyle',
  逐字高亮: 'lyricsStyle',
  卡片与背景自定义: 'cardAppearance',
  启用自定义外观: 'cardAppearance',
  卡片模糊强度: 'cardAppearance',
  卡片模糊饱和度: 'cardAppearance',
  卡片背景颜色: 'cardAppearance',
  卡片边框: 'cardAppearance',
  卡片圆角半径: 'cardAppearance',
  卡片阴影强度: 'cardAppearance',
  卡片悬浮效果: 'cardAppearance',
  玻璃高光: 'cardAppearance',
  背景模糊与暗化: 'cardAppearance',
  背景模糊: 'cardAppearance',
  背景亮度: 'cardAppearance',
  背景暗化遮罩: 'cardAppearance',
  液态玻璃材质: 'liquidGlass',

  高光跟随指针: 'liquidGlass',
  自定义背景: 'background',
  统一背景: 'background',
  页面背景覆盖: 'background',
  高级音频参数: 'advancedEngine',
  'WASAPI 独占推送模式': 'advancedEngine'
}

/** Built-in search entries and aliases. Plugin forms supply their own labels. */
export const SETTINGS_SEARCH_INDEX: SettingsSearchEntry[] = (
  [
    { section: 'general', title: '下载目录', terms: '下载 保存 文件夹' },
    { section: 'general', title: '下载文件命名', terms: '文件名 歌手 标题 命名' },
    { section: 'general', title: '内嵌歌曲信息与封面', terms: '下载 元数据 歌曲 标签 封面' },
    { section: 'general', title: '同时保存歌词文件', terms: '下载 lrc 歌词' },
    { section: 'general', title: '个人数据备份与迁移', terms: '备份 数据 歌单 收藏 转移' },
    { section: 'general', title: '语言', terms: 'language 中文 English 系统' },
    { section: 'playback', title: '交叉淡入淡出', terms: '交叉淡化 crossfade 过渡 秒 曲线' },
    { section: 'playback', title: '削波保护', terms: 'clip guard 防破音' },
    { section: 'playback', title: '输出缓冲（帧）', terms: 'buffer 缓冲 卡顿 延迟' },
    { section: 'playback', title: '声道路由', terms: 'routing 上混 立体声' },
    { section: 'appearance', title: '主题插件工坊', terms: '主题 插件 工坊' },
    { section: 'appearance', title: '独立迷你窗口', terms: '迷你 悬浮 mini 独立窗口' },
    { section: 'appearance', title: '歌词字体', terms: '播放页 字体' },
    { section: 'appearance', title: '歌词字号', terms: '播放页 字号' },
    { section: 'appearance', title: '歌词对齐', terms: '播放页 对齐' },
    { section: 'appearance', title: '歌词字重', terms: '播放页 字重' },
    { section: 'appearance', title: '歌词行距', terms: '播放页 行距' },
    { section: 'appearance', title: '未播放歌词淡化程度', terms: '歌词 暗度 淡化' },
    { section: 'appearance', title: '突出显示的歌词行数', terms: '歌词 聚焦 行数' },
    { section: 'appearance', title: '歌词颜色', terms: '歌词 配色' },

    { section: 'appearance', title: '主导航液态玻璃', terms: '玻璃 导航' },
    { section: 'appearance', title: '播放栏液态玻璃', terms: '玻璃 播放栏' },
    { section: 'appearance', title: '设置导航液态玻璃', terms: '玻璃 设置导航' },
    { section: 'appearance', title: '首页媒体焦点液态玻璃', terms: '玻璃 首页 卡片' },
    { section: 'appearance', title: '折射强度', terms: '玻璃 折射' },
    { section: 'appearance', title: '色散强度', terms: '玻璃 色散' },
    { section: 'appearance', title: '玻璃模糊', terms: '玻璃 模糊' },
    { section: 'appearance', title: '玻璃饱和度', terms: '玻璃 饱和度' },
    { section: 'appearance', title: '弹性跟随', terms: '玻璃 弹性' },
    { section: 'appearance', title: '镜面高光', terms: '玻璃 高光' },
    { section: 'appearance', title: '表面着色', terms: '玻璃 着色' },
    { section: 'dsp', title: 'DSD 输出方式', terms: 'DSD 直通 DoP PCM' },
    { section: 'dsp', title: 'DSD 采样率策略', terms: 'DSD 采样率 降采样' },
    { section: 'dsp', title: 'SACD 声道版本', terms: 'SACD 立体声 多声道' },
    { section: 'dsp', title: '频谱分析（FFT）', terms: 'FFT 频谱 可视化' },
    { section: 'performance', title: '歌词页底部动态频谱', terms: '歌词 频谱 动画 性能' },
    { section: 'general', title: '清空媒体库索引', terms: '重置库 重建 reset 清空索引' },
    // ── 常规 ──────────────────────────────────────────────
    { section: 'general', title: '扫描文件夹', terms: '媒体库 文件夹 目录 扫描 添加 本地 音乐 库' },
    { section: 'general', title: '流派分隔符', terms: 'genre separator 标签 分隔 元数据' },
    {
      section: 'general',
      title: '实时监控文件夹变动',
      terms: 'watch 监控 文件夹 自动 同步 媒体库 监听'
    },
    {
      section: 'general',
      title: '在线补充缺失歌词',
      terms: '歌词 lyric 回退 provider LRCLIB 在线 搜索'
    },
    { section: 'general', title: '媒体库监控状态', terms: 'watcher 状态 监控 监听 文件夹 降级' },
    { section: 'general', title: '完整重扫', terms: 'rescan 重扫 扫描 元数据 封面 刷新 媒体库' },
    { section: 'general', title: '启动时检查网易云登录', terms: '网易云 ncm 登录 检查 启动 账号' },
    {
      section: 'general',
      title: '系统媒体控制（SMTC）',
      terms: 'smtc 媒体控制 系统 媒体键 集成 windows'
    },
    {
      section: 'general',
      title: '任务栏缩略图按钮',
      terms: '任务栏 taskbar 缩略图 thumbar 上一首 播放 暂停 下一首 windows'
    },
    {
      section: 'general',
      title: 'Discord 听歌状态',
      terms: 'discord 状态 展示 集成 社交 游戏'
    },
    { section: 'general', title: '局域网远程控制', terms: '远程 遥控 局域网 手机 控制 投送 DLNA' },
    { section: 'general', title: '配对 PIN / 访问地址', terms: 'pin 配对 访问 地址 远程 安全' },
    { section: 'general', title: '歌曲列表播放方式', terms: '单击 双击 播放 列表 操作 习惯 激活' },
    { section: 'general', title: '启动后进入', terms: 'startup 主页 首页 启动 进入 本地 流媒体' },
    {
      section: 'general',
      title: '登录系统后启动',
      terms: '开机 启动 自启 登录 自动启动 launch at login'
    },
    {
      section: 'general',
      title: '关闭主窗口时',
      terms: '关闭 主窗口 最小化 托盘 退出 行为 窗口 迷你播放器'
    },
    {
      section: 'general',
      title: '独立迷你窗口显示在任务栏',
      terms: '迷你播放器 mini player 任务栏 taskbar 悬浮窗 独立窗口'
    },
    {
      section: 'general',
      title: '欢迎向导',
      terms: '向导 欢迎 onboarding 首次 引导 任务栏 播放器形态'
    },
    { section: 'general', title: '设置备份', terms: '备份 backup 导出 导入 恢复 设置' },
    { section: 'general', title: '按分组恢复默认', terms: '恢复 默认 重置 reset 分组' },
    {
      section: 'general',
      title: '插件设置',
      match: '插件设置',
      terms: '插件 plugin 面板 设置 扩展'
    },
    {
      section: 'general',
      title: '开发者模式',
      terms: '开发者 开发 模式 developer dev debug 调试 插件 目录 文件夹 未打包 unpacked 本地安装'
    },
    { section: 'general', title: '代理模式', terms: '代理 proxy 模式 网络 系统 关闭' },
    { section: 'general', title: '代理地址', terms: '代理 proxy 地址 host 服务器' },
    { section: 'general', title: '代理端口', terms: '代理 proxy 端口 port' },
    {
      section: 'general',
      title: '代理失败时允许直连',
      terms: '代理 proxy 直连 fallback 失败 回退'
    },

    // ── 播放 ──────────────────────────────────────────────
    { section: 'playback', title: '输出模式', terms: '输出 output 设备 音频 模式 声卡' },
    { section: 'playback', title: 'DSD 直通路由', terms: 'dsd 直通 路由 sacd 采样 原始' },
    {
      section: 'playback',
      title: '独占模式 (Exclusive)',
      terms: '独占 exclusive 输出 设备 绕过 混音'
    },
    {
      section: 'playback',
      title: '独占模式自动启停',
      terms: '独占 exclusive 自动 启停 暂停 释放 声卡 设备'
    },
    { section: 'playback', title: '播放音量', terms: '音量 削波 clip 保护 响度 安全' },
    {
      section: 'playback',
      title: '无缝播放 (Gapless Playback)',
      terms: '无缝 播放 gapless 间隙 连续 歌曲 边界'
    },
    { section: 'playback', title: '记住上次播放', terms: '恢复 播放 resume 上次 曲目 位置 启动' },
    {
      section: 'playback',
      title: '上一首按钮行为',
      terms: '上一首 按钮 重播 重放 回到 开头 previous restart 行为'
    },
    { section: 'playback', title: '睡眠定时器', terms: '睡眠 定时 sleep timer 停止 播放 计时' },
    {
      section: 'playback',
      title: '网易云播放音质',
      terms: '网易云 ncm 音质 无损 hi-res lossless 标准'
    },
    {
      section: 'playback',
      title: '高级音频参数',
      terms: '引擎 engine buffer 缓冲 采样率 位深 高级'
    },
    {
      section: 'playback',
      title: 'WASAPI 独占推送模式',
      terms: 'wasapi 独占 推送 模式 windows 输出'
    },

    // ── DSP ───────────────────────────────────────────────
    { section: 'dsp', title: '削波保护', terms: '防破音 clip guard 保护 削波 响度' },
    {
      section: 'dsp',
      title: '响度均衡（ReplayGain / Loudnorm）',
      terms: 'replaygain loudnorm 音量 标准化 响度 增益'
    },
    { section: 'dsp', title: '响度预增益', terms: 'preamp 增益 前置 音量 标准化' },
    { section: 'dsp', title: '缺少响度信息时的增益', terms: 'fallback gain 增益 回退 音量' },
    { section: 'dsp', title: '响度均衡后的削波限制', terms: 'replaygain clip 削波 限制 增益' },
    { section: 'dsp', title: '参数均衡器（EQ）', terms: 'eq 均衡 均衡器 parametric 频率 增益' },
    {
      section: 'dsp',
      title: '耳机交叉馈送（Crossfeed）',
      terms: 'crossfeed 交叉 馈电 耳机 声场 空间'
    },
    { section: 'dsp', title: '交叉馈送延迟', terms: 'crossfeed delay 延迟 交叉 馈电' },
    { section: 'dsp', title: '交叉馈送截止频率', terms: 'crossfeed cutoff 截止 频率 交叉 馈电' },
    { section: 'dsp', title: '启用 VST3 音效插件', terms: 'vst3 宿主 插件 启用 效果器 host' },
    {
      section: 'dsp',
      title: 'VST3 搜索目录',
      match: '搜索目录',
      terms: 'vst3 搜索 目录 插件 扫描 路径'
    },
    { section: 'dsp', title: '插件目录状态', terms: '插件 目录 状态 vst3 扫描 检测' },

    // ── 缓存 ──────────────────────────────────────────────
    { section: 'cache', title: '缓存目录', terms: '缓存 目录 cache 路径 存储 位置' },
    { section: 'cache', title: '封面缓存', terms: '封面 cover 缓存 图片 清除' },
    { section: 'cache', title: '歌词缓存', terms: '歌词 lyric 缓存 清除' },
    { section: 'cache', title: '元数据缓存', terms: '元数据 metadata 缓存 清除' },
    {
      section: 'cache',
      title: '流媒体音频缓存',
      terms: '流媒体 音频 缓存 streaming 缓存策略 网络'
    },
    { section: 'cache', title: '自动分析节拍速度（BPM）', terms: 'bpm 分析 自动 节奏 扫描' },
    { section: 'cache', title: 'BPM 分析缓存', terms: 'bpm 分析 缓存 清除' },
    { section: 'cache', title: '响度分析缓存（Loudnorm）', terms: 'loudnorm 响度 分析 缓存 清除' },
    { section: 'cache', title: '缓存占用', terms: '缓存 占用 大小 清理 清空 释放 空间' },

    // ── 性能 ──────────────────────────────────────────────
    { section: 'performance', title: '硬件加速', terms: '硬件 加速 gpu 渲染 显卡 性能' },
    { section: 'performance', title: '窗口透明', terms: '窗口 透明 透明度 毛玻璃 玻璃 背景' },
    {
      section: 'performance',
      title: '窗口表面不透明度',
      terms: '表面 不透明度 opacity 透明度 窗口'
    },
    {
      section: 'performance',
      title: '窗口表面模糊度',
      terms: '表面 模糊 blur 毛玻璃 窗口'
    },
    {
      section: 'performance',
      title: '窗口内卡片不透明度',
      terms: '卡片 不透明度 opacity 透明度'
    },
    { section: 'performance', title: '窗口内卡片模糊度', terms: '卡片 模糊 blur 毛玻璃' },

    // ── 外观 ──────────────────────────────────────────────
    {
      section: 'appearance',
      title: '主题创意工坊',
      terms: '主题 工作室 theme 编辑器 自定义 皮肤'
    },
    { section: 'appearance', title: '主题模式', terms: '主题 模式 浅色 深色 系统 亮色 暗色' },
    { section: 'appearance', title: '界面动效', terms: '动效 动画 减少动画 motion 特效 过渡' },
    { section: 'appearance', title: '插件主题', terms: '插件 主题 plugin theme 扩展' },
    { section: 'appearance', title: '浅色强调色', terms: '强调色 accent 浅色 颜色 主题' },
    { section: 'appearance', title: '深色强调色', terms: '强调色 accent 深色 颜色 主题' },
    { section: 'appearance', title: '自定义背景', terms: '背景 自定义 壁纸 图片 封面' },
    { section: 'appearance', title: '统一背景', terms: '背景 统一 所有 页面 壁纸' },
    { section: 'appearance', title: '页面背景覆盖', terms: '背景 页面 覆盖 独立 壁纸 图片' },
    { section: 'appearance', title: '封面主题色', terms: '封面 主题色 cover 颜色 专辑' },
    {
      section: 'appearance',
      title: '界面字体',
      terms: '字体 font typography 排版 全局 界面字体 正文 标题 霞鹜文楷 更纱黑体 跟随主题'
    },
    {
      section: 'appearance',
      title: '界面密度',
      terms: '密度 ui density 排版 紧凑 宽松'
    },
    {
      section: 'appearance',
      title: '播放页歌词样式',
      terms: '歌词 lyric 样式 高亮 逐字 显示'
    },
    { section: 'appearance', title: '逐字高亮', terms: '逐字 高亮 歌词 卡拉 ok 同步' },
    { section: 'appearance', title: '卡片与背景自定义', terms: '卡片 背景 自定义 外观' },
    { section: 'appearance', title: '启用自定义外观', terms: '外观 自定义 启用 卡片 开关' },
    { section: 'appearance', title: '卡片模糊强度', terms: '卡片 模糊 强度 blur 毛玻璃' },
    { section: 'appearance', title: '卡片模糊饱和度', terms: '卡片 模糊 饱和度 saturation blur' },
    { section: 'appearance', title: '卡片背景颜色', terms: '卡片 背景 颜色 color' },
    { section: 'appearance', title: '卡片边框', terms: '卡片 边框 border 描边' },
    { section: 'appearance', title: '卡片圆角半径', terms: '卡片 圆角 radius 圆角 弧度' },
    { section: 'appearance', title: '卡片阴影强度', terms: '卡片 阴影 强度 shadow 投影' },
    { section: 'appearance', title: '卡片悬浮效果', terms: '卡片 悬浮 hover 效果 悬停' },
    { section: 'appearance', title: '玻璃高光', terms: '玻璃 高光 glass highlight 光泽' },
    { section: 'appearance', title: '背景模糊与暗化', terms: '背景 模糊 暗化 遮罩 blur darken' },
    { section: 'appearance', title: '背景模糊', terms: '背景 模糊 blur 毛玻璃' },
    { section: 'appearance', title: '背景亮度', terms: '背景 亮度 brightness 明暗' },
    { section: 'appearance', title: '背景暗化遮罩', terms: '背景 暗化 遮罩 蒙版 overlay darken' },
    {
      section: 'appearance',
      title: '播放条形态',
      terms: '播放条 播放栏 playbar 迷你 mini 标准 紧凑 compact 形态 大小 贴底 全宽'
    },
    {
      section: 'appearance',
      title: '播放页形态',
      terms: '播放页 播放条 playbar 迷你 mini 紧凑 compact 形态 now playing'
    },
    {
      section: 'appearance',
      title: '播放条按钮编排',
      terms:
        '按钮 编排 排列 顺序 布局 槽位 自定义 增删 左侧 中间 右侧 播放条 播放栏 playbar layout 收藏 音量 均衡器 时间 封面'
    },
    {
      section: 'appearance',
      title: '播放条可见性',
      terms:
        '可见性 常显 自动隐藏 完全隐藏 隐藏播放条 关闭播放条 不显示播放条 播放条 播放栏 playbar auto hide hidden visibility'
    },
    {
      section: 'appearance',
      title: '播放页可见性',
      terms: '播放页 可见性 自动隐藏 完全隐藏 播放条 playbar auto hide hidden now playing 歌词页'
    },
    {
      section: 'appearance',
      title: '触发距离',
      terms: '触发 距离 阈值 threshold 鼠标 底边 播放条 自动隐藏'
    },
    { section: 'appearance', title: '收起延迟', terms: '收起 延迟 delay 播放条 自动隐藏 隐藏' },
    // Surface material is a separate dimension from the playbar's shape and
    // visibility: any combination is valid, so it gets its own entries rather
    // than sharing the playbar ones.
    {
      section: 'appearance',
      title: '液态玻璃材质',
      terms:
        '液态玻璃 玻璃 透明 透明化 折射 材质 质感 liquid glass 卡片 播放条 播放栏 playbar 毛玻璃'
    },
    {
      section: 'appearance',
      title: '全局液态玻璃',
      terms: '液态玻璃 启用 开关 透明 透明化 材质 liquid glass 播放条 播放栏 卡片'
    },
    {
      section: 'appearance',
      title: '高光跟随指针',
      terms: '高光 跟随 指针 鼠标 光源 镜面 specular 液态玻璃'
    },

    // ── 桌面歌词 ──────────────────────────────────────────
    { section: 'desktopLyrics', title: '启用桌面歌词', terms: '桌面歌词 启用 开关 显示 歌词' },
    {
      section: 'desktopLyrics',
      title: '字体',
      match: '字体',
      terms:
        '桌面歌词 字体 字体名 跟随 PlayingMusic 系统默认 霞鹜文楷 更纱黑体 本机字体 已安装 font family custom installed follow'
    },
    {
      section: 'desktopLyrics',
      title: '字号',
      match: '字号',
      terms: '字体 大小 font size 字号 歌词'
    },
    {
      section: 'desktopLyrics',
      title: '字体粗细',
      match: '字体粗细',
      terms: '字体 粗细 font weight 加粗'
    },
    {
      section: 'desktopLyrics',
      title: '描边',
      match: '描边',
      terms: '描边 边框 outline stroke 有描边 无描边 歌词'
    },
    {
      section: 'desktopLyrics',
      title: '行距',
      match: '行距',
      terms: '行距 间距 line spacing 歌词'
    },
    {
      section: 'desktopLyrics',
      title: '显示行数',
      match: '显示行数',
      terms: '行数 单行 双行 single double display lines 歌词'
    },
    {
      section: 'desktopLyrics',
      title: '文字排列方向',
      match: '文字排列方向',
      terms: '横排 竖排 横向 纵向 horizontal vertical writing mode 排版 歌词'
    },
    {
      section: 'desktopLyrics',
      title: '歌词配色方案',
      match: '歌词配色方案',
      terms: '配色 方案 落日晖 Twilight 暖白 封面强调色 palette color 歌词'
    },
    {
      section: 'desktopLyrics',
      title: '已播放歌词颜色',
      match: '已播放歌词颜色',
      terms: '已播放 当前 歌词 颜色 active played color'
    },
    {
      section: 'desktopLyrics',
      title: '未播放歌词颜色',
      match: '未播放歌词颜色',
      terms: '未播放 未唱 歌词 颜色 inactive unplayed color'
    },
    {
      section: 'desktopLyrics',
      title: '背景透明度',
      match: '背景透明度',
      terms: '背景 透明度 opacity 歌词 半透明'
    },
    {
      section: 'desktopLyrics',
      title: '文字阴影',
      match: '文字阴影',
      terms: '文字 阴影 强度 shadow 投影 歌词'
    },
    {
      section: 'desktopLyrics',
      title: '歌词对齐方式',
      match: '歌词对齐方式',
      terms: '对齐 align 居左 居中 居右 歌词'
    },
    {
      section: 'desktopLyrics',
      title: '窗口宽度',
      match: '窗口宽度',
      terms: '窗口 宽度 width 桌面歌词'
    },
    {
      section: 'desktopLyrics',
      title: '窗口高度',
      match: '窗口高度',
      terms: '窗口 高度 height 桌面歌词'
    },
    {
      section: 'desktopLyrics',
      title: '始终置顶',
      match: '始终置顶',
      terms: '置顶 always on top 窗口 顶层 钉住'
    },
    {
      section: 'desktopLyrics',
      title: '锁定并穿透点击',
      match: '锁定并穿透点击',
      terms: '锁定 鼠标 穿透 click through 点击 窗口'
    },
    {
      section: 'desktopLyrics',
      title: '显示翻译',
      match: '显示翻译',
      terms: '翻译 translation 显示 双语 原文'
    },
    {
      section: 'desktopLyrics',
      title: '显示音译',
      match: '显示音译',
      terms: '音译 罗马音 romanization transliteration 显示 外文歌词'
    },

    // ── 快捷键 ────────────────────────────────────────────
    {
      section: 'shortcuts',
      title: '全局快捷键',
      terms: '全局 快捷键 系统 媒体键 后台 注册'
    },
    { section: 'shortcuts', title: '快捷键状态', terms: '快捷键 状态 注册 冲突 检测 失败' },
    {
      section: 'shortcuts',
      title: '自定义组合键',
      terms: '自定义 组合键 修改 绑定 录制 恢复默认 上一首 下一首 播放 暂停 桌面歌词'
    },
    {
      section: 'shortcuts',
      title: '系统媒体键',
      terms: '媒体键 media key 键盘 耳机 播放键 停止'
    },

    { section: 'about', title: '自动检查更新', terms: '自动 检查 更新' },
    { section: 'about', title: '检查间隔', terms: '更新 间隔 频率 每天' },
    { section: 'about', title: '更新频道', terms: '更新 频道 稳定版 测试版 预发布' },
    // ── 关于 ──────────────────────────────────────────────
    {
      section: 'about',
      title: '版本信息',
      match: 'Version',
      terms: '版本 version 关于 twilight echo 名称'
    },
    {
      section: 'about',
      title: '检查更新',
      match: '检查更新',
      terms: '更新 update 检查 版本 下载 安装 发布'
    },
    {
      section: 'about',
      title: '下载 / 安装更新',
      match: '更新',
      terms: '更新 下载 安装 版本 发布 github releases'
    },
    { section: 'about', title: '支持项目发展', terms: '赞助 支持 捐赠 项目 开源 爱发电' },
    {
      section: 'about',
      title: '开源致谢与交流群',
      match: '开源致谢',
      terms: '开源 致谢 交流 群 社区 感谢 license'
    }
  ] satisfies SettingsSearchEntry[]
).map((entry) => ({
  ...entry,
  reveal: searchPanels[entry.title] ? [searchPanels[entry.title]] : undefined,
  fallback:
    entry.section === 'appearance' &&
    (entry.title.includes('玻璃') ||
      ['折射强度', '色散强度', '弹性跟随', '镜面高光', '表面着色', '高光跟随指针'].includes(
        entry.title
      ))
      ? '全局液态玻璃'
      : ['背景模糊', '背景亮度', '背景暗化遮罩'].includes(entry.title)
        ? '背景模糊与暗化'
        : entry.section === 'performance' &&
            entry.title.startsWith('窗口') &&
            entry.title !== '窗口透明'
          ? '窗口透明'
          : ['触发距离', '收起延迟'].includes(entry.title)
            ? '播放条可见性'
            : entry.title.startsWith('代理') && entry.title !== '代理模式'
              ? '代理模式'
              : undefined,
  terms: `${sectionTerms[entry.section]} ${entry.terms} ${entry.title === '记住上次播放' ? '启动时恢复播放' : entry.title === '独立迷你窗口' ? '迷你播放器' : ''}`
}))

export const RESET_DESKTOP_LYRICS: DesktopLyricsSettings = DEFAULT_DESKTOP_LYRICS_SETTINGS

export type PluginSettingsFieldType = 'text' | 'password' | 'url' | 'select'

export interface PluginSettingsOption {
  label: string
  value: string
}

export interface PluginSettingsField {
  key: string
  label: string
  type: PluginSettingsFieldType
  required: boolean
  placeholder: string
  value: string
  options: PluginSettingsOption[]
}

export interface PluginSettingsForm {
  submitCommand: string
  fields: PluginSettingsField[]
  notice: string
}
