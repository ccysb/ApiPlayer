# 浏览器扩展安装指引

ApiPlayer 提供浏览器扩展，但**没有上架 Chrome / Edge 扩展商店**，因此安装方式和普通商店扩展不同。请先读完下面的说明，选择适合你的方式。

## 关于"此扩展不是来自任何已知来源"警告

把 `ApiPlayer.crx` 拖到浏览器扩展页时，新版 Chrome（116+）/ Edge 会提示：

> 此扩展不是来自任何已知来源，可能是在你不知情的情况下添加的。

这是**浏览器的安全策略**，不是文件损坏或打包错误。从 Chrome 116 / 对应版本 Edge 开始，Windows 与 macOS 上已禁止通过"拖拽 / 双击本地 `.crx`"安装扩展。

需要明确两点：

- 这个 CRX 文件本身是正常、完整、由本项目源代码构建的；
- 在不上架商店的前提下，这个警告**无法通过修改 CRX 消除**。给 manifest 加 `update_url` 也不会让拖拽安装恢复，反而会导致扩展无法上架商店。

所以请改用下面三种正式途径之一。

## 三种安装方式对比

| 方式 | 适用对象 | 需要私钥 | 主要限制 |
| --- | --- | --- | --- |
| **开发者模式加载 `extension/` 文件夹** | 所有用户（**推荐**） | 否 | 浏览器每次启动可能提示"停用开发者模式扩展"，需手动保留 |
| **企业策略强制安装** | 组织管理的设备（加入 AD 域 / Intune / MDM / Chrome 云管理） | 是（决定扩展 ID） | 家庭版 Windows 无效；强制安装后用户无法自行卸载 |
| 上架扩展商店 | 公众 | 否 | 需开发者账号与审核；**本项目当前未采用** |

> 如果你只是想自己用，直接用**方式一**，不要折腾 CRX 拖拽。

---

## 方式一：开发者模式加载（推荐）

无需签名、无需私钥，最稳妥。

```bash
pnpm install
pnpm build:extension       # 生成完整的 extension/ 目录
```

然后：

1. 打开 `chrome://extensions`（Edge 为 `edge://extensions`）；
2. 打开右上角的**开发者模式**开关；
3. 点击**加载已解压的扩展程序**（Edge 为"加载解压缩的扩展"）；
4. 选择项目里的 `extension/` 目录；
5. 点击工具栏中 ApiPlayer 图标，会在新标签页打开播放器。

注意：

- 每次浏览器启动时，Chrome/Edge 可能弹出"停用开发者模式扩展"的提示，选择**保留**即可；
- `extension/` 是生成物，修改页面逻辑请改 `worker.js` 后重新 `pnpm build:extension`；
- 这种方式安装的扩展不会自动更新，项目发布新版本后需要重新加载目录。

## 方式二：企业策略强制安装（仅组织设备）

适合公司 / 学校等**由组织统一管理**的设备。前提是你有自己的 **HTTPS 托管空间**（公网可信证书，不能用自签名证书）。

### 步骤

1. 准备托管目录，例如 `https://dl.example.com/apiplayer/`，用于放置 `ApiPlayer.crx` 和 `update.xml`；
2. 生成自托管资源（把地址换成你自己的）：

   ```bash
   pnpm build:crx -- --host https://dl.example.com/apiplayer
   ```

   该命令会在 `crx-output/` 额外生成：

   - `update.xml`：更新清单，内含扩展 ID、CRX 下载地址与版本；
   - `chrome-forcelist.reg`：Chrome 企业策略注册表；
   - `edge-forcelist.reg`：Edge 企业策略注册表。

   同时会打印本扩展的**扩展 ID**（也可用 `node scripts/ext-id.mjs` 单独查询）。

3. 把 `crx-output/ApiPlayer.crx` 和 `crx-output/update.xml` 上传到该 HTTPS 目录，确保能用浏览器直接访问；
4. 由管理员在目标设备上导入对应的 `.reg` 文件（需管理员权限），导入后重启浏览器；
5. 打开 `chrome://policy` / `edge://policy`，点击"重新加载策略"，确认 `ExtensionInstallForcelist` 状态为正常。

### 托管要求

- `update.xml` 以 `application/xml` 或 `text/xml` 提供；
- `ApiPlayer.crx` 以 `application/x-chrome-extension` 或 `application/octet-stream` 提供；
- **必须是 HTTPS 且证书由公网可信 CA 签发**——自签名证书会被 Chrome/Edge 拒绝更新；
- 每次升级扩展版本，需重新打包并上传新的 `ApiPlayer.crx` 与 `update.xml`（脚本会从 manifest 自动读取版本号写入 XML）。

### 重要限制

- `ExtensionInstallForcelist` **只对组织管理的设备生效**，普通家庭版 Windows 无法静默强制安装；
- Edge 对**未加入 AD 域**的 Windows 实例，强制安装仅限 Edge Add-ons 商店扩展；
- 强制安装的扩展**用户无法自行卸载 / 关闭**，部署前请评估影响；
- 需要长期维护 HTTPS 托管地址与私钥，否则后续版本无法平滑更新。

## 方式三：上架扩展商店（本项目未采用）

项目保留了可上传的商店包 `crx-output/apiplayer-store.zip`（`manifest.json` 在根目录，不含 `update_url`）。若将来需要面向公众分发，可用它提交到 Chrome Web Store / Edge Add-ons，由商店签名后用户即可正常安装。此方式需要你自备开发者账号并走审核，本项目当前不进行。

## 私钥与扩展 ID

- `crx-output/ApiPlayer.pem` 是本扩展的私钥，等同"扩展所有权凭证"：丢失它就无法在后续版本中保持同一个扩展 ID（会被当作全新扩展，无法实现覆盖更新）；
- 私钥已被 `.gitignore` 忽略，**绝不要提交到 Git 或公开**；
- 项目根目录可能残留一个旧的 `extension.pem`，它与 `crx-output/ApiPlayer.pem` **不是同一把**。复用了错误的私钥会改变扩展 ID，请始终使用 `crx-output/ApiPlayer.pem`，或用 `--key` 明确指定你的正式私钥；
- 查看当前私钥对应的扩展 ID：

  ```bash
  node scripts/ext-id.mjs
  ```
