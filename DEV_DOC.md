# CMS Pro v3 开发文档

## 概述

苹果CMS api 是一个基于 Cloudflare Workers 的视频聚合播放前端，适配苹果CMS api规范，提供多源切换、播放器选择、广告过滤等功能。

## 技术栈

| 类别   | 技术                          |
| ---- | --------------------------- |
| 后端   | Cloudflare Workers          |
| 前端框架 | Alpine.js                   |
| 样式   | Tailwind CSS                |
| 视频库  | hls.js, ArtPlayer, XGPlayer |
| 协议   | m3u8/HLS 流媒体                |

## 项目结构

```
worker.js
├── Cloudflare Worker 入口
│   ├── proxy() - API 代理
│   └── m3u8Proxy() - m3u8 流媒体代理
│
├── HTML 模板
│   ├── Header - 搜索、主题、收藏、历史、设置
│   ├── Main - 视频网格、分页
│   ├── 侧边栏 - 收藏、历史记录
│   ├── 设置面板 - 基础/API源/解析/高级
│   └── 播放器弹窗 - 电脑端右侧面板 / 手机端底部布局
│
└── Alpine.js 应用
    └── app() - 主应用状态和方法
```

## Cloudflare Worker 接口

### `GET /?u=<url>`

API 代理接口，用于跨域请求 CMS 数据。

**参数：**

- `u` (required) - 目标 API 地址（URL 编码）

**响应：**

```json
{
  "code": 1,
  "class": [...],
  "list": [...],
  "pagecount": 10
}
```

### `GET /?m3u8=<url>&skip=<n>`

m3u8 流媒体代理，支持相对路径补全和广告过滤。

**参数：**

- `m3u8` (required) - m3u8 地址（URL 编码）
- `skip` (optional) - 跳过前 n 段 TS 切片，默认 1

**功能：**

1. 自动检测 master playlist (`#EXT-X-STREAM-INF`) 并解析子流
2. 补全相对路径的 TS 文件地址
3. 跳过广告切片（基于 TS 段数量）
4. 添加 CORS 头支持跨域播放

**错误响应：**

```json
{ "error": "HTTP_404_https://..." }
```

## 数据结构

### 视频项 (VideoItem)

```typescript
interface VideoItem {
  vod_id: string;           // 视频 ID
  vod_name: string;         // 视频名称
  vod_pic: string;          // 封面图
  type_name: string;        // 分类名称
  vod_remarks: string;      // 备注（如 "更新至第12集"）
  vod_play_from: string;    // 播放源（多源用 $$$$ 分隔）
  vod_play_url: string;     // 播放地址（多源用 $$$$ 分隔，单集用 # 分隔）
}
```

### 播放组 (PlayGroup)

```typescript
interface PlayGroup {
  sn: string;               // 线路名称
  ep: Episode[];            // 集数列表
}

interface Episode {
  n: string;                // 集数名称（如 "第1集"）
  u: string;                // 播放地址
}
```

### 配置项 (Config)

```typescript
interface Config {
  theme: 'auto' | 'light' | 'dark';  // 主题模式
  autoNext: boolean;                    // 自动下一集
  rememberSpeed: boolean;               // 记忆播放倍速
  adFilter: boolean;                   // m3u8 广告过滤
  playerType: 'native' | 'art' | 'xg' | 'potplayer' | 'vlc';
  loadMode: 'page' | 'waterfall';      // 加载模式
  hiddenTypes: string;                 // 黑名单分类
  autoLoadMore: boolean;               // 自动加载更多
  adSkipCount: number;                 // 跳过前几段
  parseApis: string;                   // VIP 解析接口池
  skipIntro: boolean;                 // 跳过片头
  introTime: number;                   // 片头时间（秒）
  outroTime: number;                   // 片尾时间（秒）
  smartAdRemove: boolean;              // 智能去广告
}
```

## 状态管理

### 全局状态 (Alpine.js data)

```javascript
sources: []            // API 源列表
cfg: {}                // 配置对象
fav: []                // 收藏列表
his: []                // 播放历史
searchHistory: []      // 搜索历史
classes: []            // 当前显示的分类
allClassesList: []     // 所有分类（含黑名单过滤前）
visibleClasses: []     // 可见分类（适应容器宽度）
hiddenClasses: []      // 隐藏分类（更多菜单）
videos: []             // 视频列表
page: 1                // 当前页码
totalPages: 1          // 总页数
currentType: '0'       // 当前分类 ID
searchWd: ''           // 搜索关键词
// UI 状态
showFav: false         // 显示收藏面板
showHist: false        // 显示历史面板
showSettings: false    // 显示设置面板
showPlayer: false      // 显示播放器
showPlayerSettings: false  // 显示播放器设置
showEpSort: false      // 显示选集排序
epSortAsc: true        // 选集排序顺序
isWebPlayer: false    // 是否为网页嵌入播放器
// 播放状态
playGroups: []         // 播放组列表
playSrc: 0             // 当前线路索引
playEp: 0              // 当前集数索引
playSpeed: '1'         // 播放倍速
playerTitle: ''        // 播放器标题
currentItem: null      // 当前视频项
// 播放器实例
_art: null             // ArtPlayer 实例
_xg: null              // XGPlayer 实例
_hls: null             // Hls.js 实例
_observer: null        // IntersectionObserver 实例
```

## 核心方法

### 分类导航

| 方法                      | 说明                        |
| ----------------------- | ------------------------- |
| `loadClasses()`         | 加载分类列表，支持 localStorage 缓存 |
| `filterClasses()`       | 根据黑名单过滤分类                 |
| `calcClasses()`         | 计算可见/隐藏分类，支持自适应宽度         |
| `toggleBlacklistType()` | 切换分类黑名单状态                 |

### 数据加载

| 方法                   | 说明              |
| -------------------- | --------------- |
| `loadData(loadMore)` | 加载视频列表，支持分页/瀑布流 |
| `loadMore()`         | 瀑布流加载更多         |

### 播放器

| 方法                     | 说明                   |
| ---------------------- | -------------------- |
| `openPlayer(item)`     | 打开播放器，检测网页播放器        |
| `renderPlayer()`       | 渲染播放器（根据配置选择内核）      |
| `renderNativePlayer()` | 原生 video 标签 + hls.js |
| `renderArtPlayer()`    | ArtPlayer 播放器        |
| `renderXgPlayer()`     | XGPlayer 播放器         |
| `processPlayUrl()`     | 处理播放地址（广告过滤）         |
| `isWebPlayerUrl()`     | 检测是否为网页嵌入地址          |
| `prevEp() / nextEp()`  | 上一集/下一集              |
| `sortedEps()`          | 获取排序后的集数列表           |
| `toggleEpSort()`       | 切换集数排序               |
| `closePlayer()`        | 关闭播放器                |
| `destroyPlayers()`     | 销毁所有播放器实例            |

### 播放器设置

| 方法                | 说明          |
| ----------------- | ----------- |
| `getPlayerTime()` | 获取当前播放时间（秒） |
| `setIntroTime()`  | 设置片头跳过时间    |
| `setOutroTime()`  | 设置片尾跳过时间    |

### 历史与收藏

| 方法                  | 说明      |
| ------------------- | ------- |
| `toggleFav(item)`   | 切换收藏状态  |
| `isFav(id)`         | 检查是否已收藏 |
| `saveHistory(time)` | 保存播放历史  |
| `clearHist()`       | 清空历史记录  |
| `formatTime(ts)`    | 格式化时间戳  |

### 搜索

| 方法                     | 说明     |
| ---------------------- | ------ |
| `doSearch()`           | 执行搜索   |
| `clearSearchHistory()` | 清空搜索历史 |

### API 源管理

| 方法                   | 说明       |
| -------------------- | -------- |
| `addSource()`        | 添加 API 源 |
| `editSource(i)`      | 编辑 API 源 |
| `saveSource()`       | 保存 API 源 |
| `deleteSource(i)`    | 删除 API 源 |
| `setActiveSource(i)` | 激活 API 源 |
| `exportSources()`    | 导出源列表    |
| `importSources(e)`   | 导入源列表    |

### 工具

| 方法                         | 说明                 |
| -------------------------- | ------------------ |
| `makeApiUrl(base, params)` | 构造 API URL         |
| `pageRange()`              | 生成分页范围             |
| `fallbackCopy(text)`       | 降级复制方法             |
| `shareCurrent()`           | 分享当前视频             |
| `downloadCurrent()`        | 下载当前视频             |
| `toggleThemeMode()`        | 切换主题模式             |
| `saveCfg()`                | 保存配置到 localStorage |

## 播放器检测规则

`isWebPlayerUrl()` 检测以下模式：

```javascript
// 包含这些关键词的 URL 视为网页播放器
'.html'
'.htm'
'/play/'
'/player/'
'iframe'
```

检测到后使用 `<iframe>` 嵌入播放。

## 自适应布局

### 电脑端 (≥sm)

```
┌─────────────────────────────────────────────────────────┐
│  Header                                                 │
├───────────────────────────────────┬─────────────────────┤
│                                   │ 标题 + 关闭按钮      │
│                                   ├─────────────────────┤
│         播放器区域                  │ 选源 Tab 按钮       │
│         (aspect-video)            ├─────────────────────┤
│                                   │ 上一集 / 下一集      │
│                                   ├─────────────────────┤
│                                   │ 排序 + 集数统计      │
│                                   ├─────────────────────┤
│                                   │ 选集网格 (4列)       │
│                                   ├─────────────────────┤
│                                   │ 收藏 / 下载 / 分享   │
│                                   │ 设置按钮             │
│                                   ├─────────────────────┤
│                                   │ 播放器设置面板       │
│                                   │ (进度跳过/自动连播   │
│                                   │  m3u8过滤/智能去广)  │
└───────────────────────────────────┴─────────────────────┘
```

### 手机端 (\<sm)

```
┌───────────────────────────┐
│  Header                  │
├───────────────────────────┤
│ 标题 + 关闭按钮           │
├───────────────────────────┤
│                           │
│      播放器区域            │
│    (aspect-video)         │
│                           │
├───────────────────────────┤
│ 选源 Tab (横向滚动)        │
├───────────────────────────┤
│ 选集列表 (横向滚动)        │
└───────────────────────────┘
```

## localStorage 键名

| 键名                | 内容                  |
| ----------------- | ------------------- |
| `cms_src`         | API 源列表 (JSON)      |
| `cms_cfg`         | 用户配置 (JSON)         |
| `cms_fav`         | 收藏列表 (JSON)         |
| `cms_his`         | 播放历史 (JSON)         |
| `cms_search_hist` | 搜索历史 (JSON)         |
| `cms_spd`         | 播放倍速                |
| `cms_cls_<url>`   | 分类缓存 (按 API URL 隔离) |

## CDN 依赖

```html
<!-- Tailwind CSS -->
<script src="https://cdn.tailwindcss.com"></script>

<!-- Alpine.js -->
<script src="//unpkg.com/alpinejs" defer></script>

<!-- HLS.js -->
<script src="https://unpkg.com/hls.js@latest"></script>

<!-- ArtPlayer -->
<script src="https://unpkg.com/artplayer/dist/artplayer.js"></script>

<!-- XGPlayer -->
<script src="https://unpkg.com/xgplayer@3.0.17/dist/index.min.js"></script>
<link rel="stylesheet" href="https://unpkg.com/xgplayer@3.0.17/dist/index.min.css">
```

## 部署

1. 将 `worker.js` 完整内容部署到 Cloudflare Workers
2. 配置自定义域名（可选）
3. 添加 API 源开始使用

## 版本历史

### v3

- 新增播放器右侧面板（电脑端）
- 新增手机端自适应底部布局
- 新增网页播放器检测（iframe 嵌入）
- 新增播放器内设置（片头/片尾跳过、自动连播、智能去广）
- 新增选集排序功能
- 优化 m3u8 代理相对路径处理

### v2

- 支持 ArtPlayer、XGPlayer 多播放器
- 支持 PotPlayer、VLC 外部播放器
- m3u8 广告过滤
- 瀑布流加载模式

### v1

- 基础 CMS 视频列表
- 分页加载
- 收藏、历史功能

## 部署

> 完整的多平台部署说明见 [DEPLOY.md](./DEPLOY.md)，项目概览与一键部署见 [README.md](./README.md)。

### 快速部署（Cloudflare Workers）

```powershell
# 安装依赖
pnpm install

# 部署主 Worker
pnpm deploy

# 开发模式预览
pnpm dev
```

或使用 PowerShell 脚本：

```powershell
.\deploy.ps1        # 部署
.\deploy.ps1 -Dev   # 本地预览
```

### Worker 说明

本项目只有一个 Worker：`worker.js`（API 代理 + m3u8 改写 + 播放地址嗅探 + 播放器前端），部署到默认域名即可，无需额外 Worker。

| 文件 | 说明 | 路由 |
| --- | --- | --- |
| `worker.js` | API 代理 + 播放器主逻辑 | 默认域名 |

### `/parse/` 接口

```
GET /parse/https://example.com/page.html
```

**返回格式：**

```json
{
  "type": "direct|webpage|webpage_with_m3u8|iframe|aliyun|tencent|unknown",
  "url": "原始地址",
  "m3u8": "解析出的m3u8地址(如果有)",
  "origin": "源站域名",
  "resolved": true|false
}
```

m3u8 改写代理（`/?m3u8=<url>&skip=N`）会补全相对路径并跳过前 N 段切片，用于规避片头广告。
