# ApiPlayer 多平台部署指南

同一份代码可部署到 Cloudflare Workers / Pages、Vercel、Koyeb、Wasmer、浏览器扩展，以及本地 Node / Bun 服务。

## 一、先理解结构

| 文件 | 作用 |
| --- | --- |
| `worker.js` | **唯一源码**。包含服务端逻辑 + 内嵌页面模板（`const HTML`） |
| `lib/handler.js` | 通用入口，直接复用 `worker.js` 的 `fetch` |
| `lib/adapter.js` | Node `req/res` ↔ Web `Request/Response` 适配（Vercel / 本地用） |
| `server.js` | Node / Bun 通用 HTTP 服务 |
| `api/index.js` + `vercel.json` | Vercel 入口与路由重写 |
| `functions/[[path]].js` + `public/` | Cloudflare Pages 入口与静态目录 |
| `Dockerfile` | Koyeb / Wasmer 使用的容器镜像 |
| `index.html` | 由脚本从 `worker.js` 提取的静态页面（供扩展使用） |
| `extension/` | 浏览器扩展产物（由脚本生成） |

服务端只有三条路由，全部使用 Web 标准 API，因此可被各平台直接复用：

- `/` — 返回播放器页面
- `/?u=<api地址>` — API 代理（前端所有 CMS 请求都经此转发）
- `/?m3u8=<地址>&skip=N` — m3u8 改写代理
- `/parse/<原始播放页地址>` — 播放地址嗅探

> **重要**：修改页面时只改 `worker.js`，然后执行 `pnpm build:static` 重新生成 `index.html`。不要直接编辑 `index.html`。

## 二、通用准备

需要 Node.js 18+（推荐 22）或 Bun；项目使用 pnpm：

```bash
pnpm install
```

常用命令：

```bash
pnpm start           # 本地启动，默认 8787
pnpm build:static    # 从 worker.js 生成 index.html
pnpm build:extension # 生成浏览器扩展（需要网络下载依赖）
```

两条约定：

1. 服务端逻辑没有使用任何 Workers 专有 API 或环境变量，所以同一份 `worker.js` 能在 Node/Bun 里直接运行。
2. 浏览器端的用户数据（设置、API 源、收藏、历史）存在 localStorage；设置 → 数据 里可配置 GitHub Gist 同步。

## 三、各平台部署

### 1. Cloudflare Workers（原方案，最省事）

```bash
pnpm install
pnpm deploy
```

配置在 `wrangler.toml`：`main = "worker.js"`，`compatibility_date = "2024-01-01"`。
本地调试：`pnpm dev`。

### 2. Cloudflare Pages

Pages 的静态文件优先级高于 Functions。如果 `index.html` 出现在静态目录里，`/?u=...` 会被静态文件截获，代理就会失效。所以静态目录特意指向空的 `public/`，所有请求交给 `functions/[[path]].js`。

Dashboard 方式：

- Framework preset: `None`
- Build command: 留空
- Build output directory: `public`
- Functions directory: `functions`
- Root directory: 项目根

CLI 方式：

```bash
npx wrangler pages deploy public --project-name apiplayer
```

验证：打开站点首页应看到播放器；若 API 源加载失败，多半是静态文件抢占了路由。

### 3. Vercel

`vercel.json` 已把所有路径重写到 `/api/index`，`api/index.js` 再把 Node 请求转成 Web Request 交给通用 handler。

Git 导入方式：直接导入仓库，Framework 选 `Other / None`，其余保持默认即可。

CLI 方式：

```bash
npx vercel --prod
```

注意 Vercel Hobby 的函数有执行时间上限，长视频嗅探可能超时；常规播放不受影响。

### 4. Koyeb

使用仓库里的 `Dockerfile`（基于 `node:22-alpine`，监听 8080）。

Koyeb Dashboard：

- 新建 Service → 选择 GitHub 仓库
- Builder 选 `Dockerfile`
- 端口填 `8080`
- 环境变量一般不填；如需改端口，设置 `PORT`

CLI 方式（安装 Koyeb CLI 后）：

```bash
koyeb service create apiplayer --git github.com/<你的账号>/<仓库> --dockerfile Dockerfile --port 8080
```

### 5. Wasmer

Wasmer 同样支持 Dockerfile：

```bash
wasmer login
wasmer deploy --name apiplayer
```

或在 Wasmer Dashboard 中选择 GitHub 仓库 → Docker 部署 → 端口 `8080`。

### 6. 本地 Node / npx / Bun

```bash
node server.js                 # Node 18+
PORT=9000 node server.js       # 指定端口
HOST=127.0.0.1 node server.js  # 只监听本机
bun server.js                  # Bun
npx .                          # 按 package.json 的 bin 启动
```

默认地址 `http://localhost:8787`。

> **为什么 `http://localhost:3000/?u=...` 返回的是网页而不是 JSON？**
> `?u=` 是服务端路由，只有运行了 `server.js` / Worker / Vercel 函数才会执行代理逻辑。
> 如果只是用 `npx serve`、`npx http-server`、`python -m http.server` 等**纯静态服务器**打开 `index.html`，
> 没有这个路由，服务器会把 `/?u=...` 当成首页回退，返回的就是 `index.html` 网页。
> 解决方式二选一：
> 1. 改用 `node server.js`（或 `PORT=3000 node server.js` 指定端口）、`npx .` 启动；
> 2. 若必须用静态托管，在「设置 → 基础 → API 代理地址」填入一个已部署的本程序地址（如 `https://xxx.workers.dev`），
>    前端会改为请求 `https://xxx.workers.dev/?u=...`。
> 页面顶部会显示明确的错误提示，不会再静默失败。

### 7. 浏览器扩展（MV3）

Chrome / Edge MV3 不允许远程脚本、内联脚本，也不允许在 `extension_pages` 的 CSP 里使用 `'unsafe-eval'`。构建脚本已做全套合规处理：

```bash
pnpm build:extension
```

这条命令会依次：`build-static`（提取页面）→ `build-tailwind`（用 Tailwind CLI 预编译静态 CSS）→ 本地化依赖并外置脚本。扩展已改成**点击图标直接在标签页打开**，不再显示 popup；若应用标签页已存在会直接聚焦。它完成三件事：

1. **Tailwind 静态化**：`cdn.tailwindcss.com` 的 JIT 运行时依赖 `unsafe-eval`，已改用 `scripts/build-tailwind.mjs` 预编译出 `extension/vendor/tailwind.css`，页面改为 `<link>` 引入。
2. **Alpine 换 CSP 版**：标准 Alpine 用 `new Function` 求值表达式，换成 `@alpinejs/csp@3.15` 后自带表达式解析器，不需要 `unsafe-eval`。为兼容它，页面里不受支持的表达式（如 `String()`、可选链、箭头函数，以及收藏/历史面板的 `showFav`/`showHist` 组合表达式）都改成 `app()` 内的方法调用（如 `toggleFavPanel()`、`bodyOverlayClass()`），组件通过 `Alpine.data('app', app)` 注册。
3. **依赖本地化 + 脚本外置 + 标签页入口**：hls.js / artplayer 下载到 `extension/vendor/`，内联脚本外置为 `app.js`；同时生成 `manifest.json` 与 `background.js`，点击工具栏图标打开独立标签页。

然后：

1. 打开 `chrome://extensions`
2. 开启「开发者模式」
3. 点「加载已解压的扩展程序」，选择项目里的 `extension/` 目录

扩展默认使用**直连模式**：前端通过 `chrome.runtime` / `browser.runtime` 或 `extension` 协议识别扩展环境后，API 请求不再走 `?u=` 代理，而是直接请求你配置的 API 源地址（依靠 manifest 的 `<all_urls>` 权限绕过 CORS）。`/parse/` 嗅探在扩展里不可用，会回退到原始播放地址，由播放器自行解析。若在「设置 → 基础 → API 代理地址」显式填入了代理地址，则扩展会优先使用该代理（包括 `/parse/`），便于应对源站拒绝直连的情况。

限制与说明：

- 部分 API 源即使扩展有权限也会因为源站校验 Referer 而失败，此时请改用服务端部署方案。
- `manifest.json` 的 CSP 不含 `'unsafe-eval'`，符合 MV3 最低要求，开发者模式和商店上架都不会再报 CSP 错误。
- 扩展配置与网页版共用 localStorage 结构，但不同环境的存储空间互相独立，可用 Gist 同步迁移。
- 以后修改页面表达式时，注意保持在 Alpine CSP 版支持的子集内（简单方法调用可用；`String()` 等全局函数、可选链、箭头函数、内联函数定义、复杂对象字面量、分号组合语句、正则字面量或除号都移到 `app()` 的方法里）。例如剧集名 `ep.n.replace(/第|集/g,'')` 要写成 `episodeLabel(ep)`。若控制台出现 `CSP Parser Error: Unexpected token: xxx`（包括 `OPERATOR "/"`），优先把该属性表达式改成无参方法调用；`build:extension` 现在也会拦截属性里未加引号的 `/`。

### 8. CRX 打包与分发

```bash
pnpm build:crx                                       # 生成 CRX + 商店 ZIP
pnpm build:crx -- --host https://dl.example.com/apiplayer   # 附带自托管更新资源
```

产物（均在 `crx-output/`，已被 Git 忽略）：

| 文件 | 说明 |
| --- | --- |
| `ApiPlayer.crx` | 本地自签名 CRX3 |
| `apiplayer-store.zip` | 商店上传包（`manifest.json` 在根目录，无 `update_url`） |
| `ApiPlayer.pem` | 私钥，决定扩展 ID，务必保管且不要提交 |
| `update.xml` | 仅 `--host` 时生成：自托管更新清单 |
| `chrome-forcelist.reg` / `edge-forcelist.reg` | 仅 `--host` 时生成：企业策略注册表 |

关于安装：

- 新版 Chrome / Edge 禁止拖拽 / 双击安装本地 CRX（提示"此扩展不是来自任何已知来源"），这是浏览器安全策略，CRX 本身无损；本项目未上架商店，该警告无法在不上架的前提下消除。
- **普通用户**：用上面的第 7 节方式（开发者模式加载 `extension/` 目录）。
- **组织管理设备**：用 `--host` 指向你自己的 HTTPS 地址，把 `ApiPlayer.crx` 与 `update.xml` 上传后，管理员导入 `.reg` 走企业策略强制安装（家庭版 Windows 无效；强制安装用户无法自行卸载；Edge 未加域时仅限商店扩展）。
- 自托管的 `update.xml` / CRX 必须走 HTTPS 且证书为公网可信 CA，自签名证书会被拒绝更新。
- 默认打包**不向 manifest 注入 `update_url`**，以保证商店 ZIP 干净；`update_url` 只在企业策略 / 自托管更新通道中使用。

完整的安装步骤、方式对比、私钥与扩展 ID 说明见 [INSTALL.md](INSTALL.md)。

## 四、验证清单

部署后建议按顺序确认：

1. 首页能打开，能看到"还没有添加API源"或视频列表
2. 添加任意公开 CMS API 源，分类栏能加载
3. 浏览器网络面板里 `?u=` 请求返回 200（不是 404/502）
4. 播放一个视频，关闭播放器后 `.ts` 分片停止传输
5. 设置 → 数据 → GitHub Gist 同步能上传和下载

## 五、常见问题

**Q：Pages / Vercel 上首页正常，但分类和列表为空？**
A：API 代理没生效。Pages 检查静态目录是否是 `public/`（不能包含 `index.html`）；Vercel 检查 `vercel.json` 的 rewrite 是否随代码一起部署。

**Q：本地 `wrangler deploy --dry-run` 失败？**
A：通常是 `node_modules` 符号链接损坏（缺 esbuild）。删除 `node_modules` 后重新 `pnpm install`。

**Q：Docker 镜像为什么不需要 `npm install`？**
A：应用只依赖 Node.js 内置模块和原生 `fetch`，`Dockerfile` 仅复制源码即可。

**Q：改了页面但线上没变化？**
A：线上跑的是 `worker.js` 里的 `const HTML`，不是根目录的 `index.html`。改完记得重新部署 Workers/Pages，或执行 `pnpm build:static` 后再构建扩展。

**Q：Gist 同步的 Token 存哪里？**
A：只存当前浏览器的 localStorage（`cms_gist`）。不要在不信任的设备上填写有写权限的 Token。
