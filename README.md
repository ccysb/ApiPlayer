# ApiPlayer

> 一个基于 Cloudflare Workers 的**单文件 CMS 聚合播放器**。零后端数据库，全部配置保存在浏览器本地；既能部署成在线站点，也能打包成浏览器扩展离线使用。

<p align="center">
  <a href="https://github.com/ccysb/ApiPlayer"><img src="https://img.shields.io/badge/GitHub-ccysb%2FApiPlayer-181717?logo=github" alt="GitHub"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License"></a>
  <a href="https://github.com/ccysb/ApiPlayer/actions"><img src="https://img.shields.io/badge/build-passing-brightgreen" alt="Build"></a>
</p>

## 一键部署

| 平台 | 部署 |
| --- | --- |
| **Vercel** | [![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fccysb%2FApiPlayer) |
| **Koyeb** | [![Deploy to Koyeb](https://www.koyeb.com/static/images/deploy/button.svg)](https://app.koyeb.com/deploy?type=git&repository=github.com/ccysb/ApiPlayer&branch=main&build_type=dockerfile) |
| **Cloudflare Workers** | [![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fccysb%2FApiPlayer) |
| **Cloudflare Pages** | [![Deploy to Cloudflare Pages](https://deploy.workers.cloudflare.com/button)](https://dash.cloudflare.com/?to=/:account/pages/new/from-git) |

> 各平台的详细步骤与注意事项见 [DEPLOY.md](DEPLOY.md)。

## 功能特性

- **多源聚合**：可添加任意数量的 CMS API 视频源，自动解析分类与列表，支持切换、启停、删除。
- **双播放器内核**：原生 HLS.js 与 ArtPlayer 可随时切换；支持剧集选集、换源、记忆播放速度、自动播下一集。
- **片头片尾**：全局或单源设置跳过片头 / 片尾时长，一键取当前时间点。
- **灵活布局**：分页翻页 / 无限滚动两种加载模式；卡片墙瀑布流、海报 / 列表布局；卡片角标可自定义字段。
- **多主题**：浅色 / 深色 / 跟随系统，滚动条、播放器面板等均随主题切换。
- **收藏与历史**：收藏夹、观看历史、搜索历史，本地持久化。
- **数据同步**：一键导出 / 导入全部数据；可将设置、API 源、收藏、历史、搜索记录同步到自己的**私有 GitHub Gist**，并支持自动同步。
- **代理与直连**：同源 `/?u=` 代理、自定义代理地址、浏览器扩展直连三种请求方式，兼容不同部署环境。
- **多形态交付**：Cloudflare Workers / Pages、Vercel、Koyeb、Wasmer、Docker、Node、Bun、浏览器扩展。

> 所有数据默认只保存在浏览器 `LocalStorage`，只有主动配置 Gist 同步后才会上传。

## 安装与使用

### 环境要求

- Node.js ≥ 20（推荐 22），或 Bun
- 包管理器：pnpm（推荐）

### 本地运行

```bash
git clone https://github.com/ccysb/ApiPlayer.git
cd ApiPlayer
pnpm install

# 方式一：Node 本地服务（带 /?u= 与 /parse/ 代理）
pnpm start                 # 或 node server.js / npx .

# 方式二：Cloudflare Workers 本地开发预览
pnpm dev                   # wrangler dev
```

打开终端提示的地址（Node 默认 `http://localhost:3000`，Wrangler 默认 `http://localhost:8787`），进入右上角**设置 → API源**添加你的 CMS 接口即可开始使用。

### 浏览器扩展

```bash
pnpm build:extension       # 生成 extension/ 目录
```

在 `chrome://extensions`（Edge 为 `edge://extensions`）打开「开发者模式」→「加载已解压的扩展程序」→ 选择 `extension/` 目录。点击工具栏图标会在新标签页打开播放器。

关于"未知来源"警告、CRX 安装方式对比与企业策略安装，见 [INSTALL.md](INSTALL.md) 与下方 [CRX 打包](#crx-打包)。

## 部署方式

项目只有一个源码入口 `worker.js`（Cloudflare Worker + 内嵌页面），各平台通过薄适配层复用同一份 `fetch` 逻辑：

| 目标 | 入口文件 | 说明 |
| --- | --- | --- |
| Cloudflare Workers | `worker.js` + `wrangler.toml` | `pnpm deploy` |
| Cloudflare Pages | `functions/[[path]].js` | Pages Functions |
| Vercel | `api/index.js` + `vercel.json` | Serverless Function |
| Koyeb / Wasmer / Docker | `Dockerfile` + `server.js` | Node 容器 |
| Node / Bun / npx | `server.js` | 纯内置模块，无第三方依赖 |
| 浏览器扩展 | `extension/` | MV3，无 `unsafe-eval` |

详细配置、代理地址设置与排错见 [DEPLOY.md](DEPLOY.md)，开发内部说明见 [DEV_DOC.md](DEV_DOC.md)。

## CRX 打包

`pnpm build:crx` 会在 `crx-output/` 生成：

- `ApiPlayer.crx`：CRX3 扩展包
- `apiplayer-store.zip`：可上传 Chrome / Edge 扩展商店的 ZIP（`manifest.json` 在根目录，不含 `update_url`）
- 追加 `--host` 时额外生成 `update.xml`（更新清单）与 `chrome-forcelist.reg` / `edge-forcelist.reg`（企业策略注册表）

### 是否需要私钥

| 生成方式 | 是否需要私钥 | 说明 |
| --- | --- | --- |
| 上传到 Chrome / Edge 扩展商店 | **不需要** | 上传 `apiplayer-store.zip`，由商店签名分发，扩展 ID 由商店分配 |
| 开发者模式加载 `extension/` 目录 | **不需要** | 调试用，无需签名 |
| 本地生成 `.crx` | **可选，建议提供** | 不提供私钥时每次打包会生成**新的扩展 ID**；提供 `--key` 可复用同一把私钥，保持扩展 ID 稳定 |

```bash
# 首次打包：自动生成私钥 crx-output/ApiPlayer.pem
pnpm build:crx

# 后续打包：复用私钥，保持扩展 ID 不变
node scripts/build-crx.mjs --key ./crx-output/ApiPlayer.pem

# 附带生成自托管更新资源（update.xml + Chrome/Edge 企业策略 .reg）
pnpm build:crx -- --host https://dl.example.com/apiplayer

# 查询当前私钥对应的扩展 ID
node scripts/ext-id.mjs
```

> **重要**：
> - 私钥 `*.pem` 已被 `.gitignore` 忽略，**绝不提交**。丢失私钥将无法保持原扩展 ID。
> - 新版 Chrome / Edge 在 Windows / macOS 上**禁止拖拽 / 双击安装本地 CRX**，会提示"此扩展不是来自任何已知来源"——这是浏览器安全策略，CRX 本身无问题。本项目未上架商店，该警告无法在不上架的前提下消除。
> - **普通用户**：用开发者模式加载 `extension/` 目录；**组织管理设备**：可用 `--host` 生成自托管 `update.xml` + 企业策略 `.reg` 强制安装（家庭版无效）。三种方式的完整步骤与限制见 [INSTALL.md](INSTALL.md)。

## 项目结构

```
.
├── worker.js              # 唯一源码：Worker 逻辑 + 内嵌页面模板
├── index.html             # 由 worker.js 生成的静态页
├── server.js              # Node/Bun 本地服务（复用 worker.fetch）
├── lib/                   # 请求/响应适配层
├── api/index.js           # Vercel 入口
├── functions/[[path]].js  # Cloudflare Pages 入口
├── src/input.css          # Tailwind 源样式（含主题滚动条）
├── scripts/               # 静态页 / Tailwind / 扩展 / CRX 构建脚本
├── extension/             # 浏览器扩展产物（MV3）
├── DEPLOY.md              # 多平台部署文档
└── DEV_DOC.md             # 开发内部说明
```

## 构建脚本

```bash
pnpm build:static      # 从 worker.js 提取 index.html
pnpm build:tailwind    # 预编译 Tailwind CSS
pnpm build:extension   # 静态页 + Tailwind + 扩展
pnpm build:crx         # 扩展 + CRX/ZIP 打包
```

> 修改页面逻辑请编辑 `worker.js` 内嵌的 `const HTML` 模板，然后重新运行对应构建脚本生成产物；不要直接改 `index.html` 或 `extension/`，它们都是生成物。

## License

[MIT](LICENSE)
