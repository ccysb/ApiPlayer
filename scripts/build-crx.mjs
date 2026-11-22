/**
 * 把 extension/ 目录打包成 CRX3（本地安装 / 企业分发用）。
 *
 * 前置：先运行 `pnpm build:extension` 生成完整的 extension/ 目录。
 * 用法：
 *   pnpm build:crx                                # 打包；私钥不存在则新建（首次生成新扩展 ID）
 *   pnpm build:crx -- --key ./my-key.pem           # 用指定私钥打包（扩展 ID 稳定，可覆盖更新）
 *   CRX_KEY=./my-key.pem pnpm build:crx            # 同上，走环境变量
 *   pnpm build:crx -- --host https://dl.example.com/apiplayer
 *                                                 # 附带生成 update.xml 与 Chrome/Edge 企业策略 .reg
 *
 * 私钥说明（重要，详见 INSTALL.md）：
 *  - 只有「本地 / 企业自签名 CRX」才需要 .pem 私钥。私钥决定扩展 ID，
 *    想让新版本覆盖旧版本（同一扩展 ID）必须始终复用同一把私钥。
 *  - 上传到 Chrome 网上应用店 / Edge 插件商店时【不需要】私钥：商店用自己的密钥签名，
 *    只需把 extension/ 压缩成 ZIP 上传即可（本脚本会同时产出该 ZIP）。
 *  - .pem 私钥等同扩展“所有权凭证”，绝不提交 Git、绝不遗失。
 *
 * 产物（crx-output/）：
 *   - ApiPlayer.crx              本地 CRX3
 *   - ApiPlayer.pem              本次使用的私钥（自动生成；请妥善保管）
 *   - apiplayer-store.zip        可上传商店的 ZIP（不含私钥，manifest 无 update_url）
 *   - update.xml                 仅 --host 时生成：自托管更新清单
 *   - chrome-forcelist.reg       仅 --host 时生成：Chrome 企业策略
 *   - edge-forcelist.reg         仅 --host 时生成：Edge 企业策略
 *
 * 注意：manifest 默认【不注入】update_url——带它的扩展无法上架商店，且不能解除
 * 新版浏览器对本地 CRX 拖拽安装的拦截。update_url 只用于企业策略/自托管更新通道。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let crx3;
try {
    crx3 = require('crx3');
} catch (e) {
    console.error('缺少 crx3 依赖，请先运行：pnpm add -D crx3');
    process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extDir = path.join(root, 'extension');
const outDir = path.join(root, 'crx-output');

// 完整性检查：必须先构建扩展
for (const required of ['manifest.json', 'index.html', 'app.js', 'background.js']) {
    if (!fs.existsSync(path.join(extDir, required))) {
        console.error(`缺少 extension/${required}，请先运行：pnpm build:extension`);
        process.exit(1);
    }
}

// 参数：--key <path> 或 CRX_KEY
const keyArgIndex = process.argv.indexOf('--key');
let keyPath = keyArgIndex >= 0 ? process.argv[keyArgIndex + 1] : (process.env.CRX_KEY || '');
if (keyArgIndex >= 0 && !keyPath) {
    console.error('--key 后需要指定 .pem 路径');
    process.exit(1);
}
if (keyPath && !path.isAbsolute(keyPath)) keyPath = path.resolve(process.cwd(), keyPath);

// 参数：--host <https://域名/路径> 或 CRX_HOST（用于自托管 update.xml 与企业策略）
const hostArgIndex = process.argv.indexOf('--host');
let host = hostArgIndex >= 0 ? process.argv[hostArgIndex + 1] : (process.env.CRX_HOST || '');
if (hostArgIndex >= 0 && !host) {
    console.error('--host 后需要指定 HTTPS 地址，例如 https://dl.example.com/apiplayer');
    process.exit(1);
}
host = String(host).trim().replace(/\/+$/, '');
if (host && !/^https:\/\//i.test(host)) {
    console.error('--host 必须是 https:// 开头的公网地址（自签名证书会被浏览器拒绝更新）');
    process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
const crxPath = path.join(outDir, 'ApiPlayer.crx');
const zipPath = path.join(outDir, 'apiplayer-store.zip');
const outKey = path.join(outDir, 'ApiPlayer.pem');

const manifestPath = path.join(extDir, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

if (keyPath && fs.existsSync(keyPath)) {
    console.log(`使用已有私钥：${keyPath}（扩展 ID 保持不变，可作为更新覆盖安装）`);
    if (path.resolve(keyPath) !== outKey) {
        console.log('  注意：请确认这是本扩展的私钥；根目录旧 extension.pem 与 crx-output/ApiPlayer.pem 是不同私钥，混用会改变扩展 ID。');
    }
} else if (keyPath) {
    console.error(`指定的私钥不存在：${keyPath}`);
    process.exit(1);
} else if (fs.existsSync(outKey)) {
    console.log(`复用上次的私钥：${outKey}（扩展 ID 保持不变）`);
    keyPath = outKey;
} else {
    console.log('未提供私钥：将生成新私钥（首次打包正常；之后请复用它以保持扩展 ID）。');
}

let info;
try {
    info = await crx3([manifestPath], {
        keyPath: keyPath || outKey,
        crxPath,
        zipPath,
        ...(host ? {
            xmlPath: path.join(outDir, 'update.xml'),
            crxURL: `${host}/ApiPlayer.crx`,
            appVersion: manifest.version,
            browserVersion: '64.0.3242'
        } : {})
    });
} catch (e) {
    console.error('CRX 打包失败：', e && e.message ? e.message : e);
    process.exit(1);
}

if (!fs.existsSync(crxPath)) {
    console.error('未生成 CRX 文件，请检查 crx3 是否正常工作。');
    process.exit(1);
}

const extId = (info && info.appId) || '';

console.log('\nCRX 打包完成：');
console.log(`  CRX      : ${crxPath} (${Math.round(fs.statSync(crxPath).size / 1024)} KB)`);
console.log(`  私钥     : ${keyPath || outKey}`);
console.log(`  商店 ZIP : ${zipPath} (${Math.round(fs.statSync(zipPath).size / 1024)} KB)`);
console.log(`  版本     : ${manifest.version}`);
if (extId) console.log(`  扩展 ID  : ${extId}`);

// 仅当提供 --host 时生成自托管更新清单与企业策略注册表文件
if (host) {
    const regHeader = 'Windows Registry Editor Version 5.00\r\n\r\n';
    const entry = `${extId};${host}/update.xml`;
    const chromeReg = path.join(outDir, 'chrome-forcelist.reg');
    const edgeReg = path.join(outDir, 'edge-forcelist.reg');
    // .reg 用纯 ASCII（含中文注释会导致部分系统导入编码异常）
    fs.writeFileSync(chromeReg,
        regHeader + `[HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Google\\Chrome\\ExtensionInstallForcelist]\r\n"1"="${entry}"\r\n`,
        'utf8');
    fs.writeFileSync(edgeReg,
        regHeader + `[HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\Edge\\ExtensionInstallForcelist]\r\n"1"="${entry}"\r\n`,
        'utf8');
    console.log(`  update.xml : ${path.join(outDir, 'update.xml')}`);
    console.log(`  策略文件   : ${chromeReg}`);
    console.log(`               ${edgeReg}`);
}

console.log('\n提示：后续更新务必复用同一把私钥（--key），否则会被当作新扩展。');
console.log('      .pem 不要提交 Git；上传商店不需要私钥，用商店 ZIP 即可。');
console.log('\n安装方式（重要）：');
console.log('  1) 新版 Chrome/Edge 在 Windows/Mac 已禁止拖拽/双击安装本地 CRX，');
console.log('     会提示“此扩展不是来自任何已知来源”——这是浏览器安全策略，CRX 本身无问题。');
console.log('  2) 普通用户：开启开发者模式，加载已解压的 extension/ 目录（详见 INSTALL.md）。');
console.log('  3) 组织管理设备：可用上面生成的 .reg + 自托管 update.xml 走企业策略强制安装；');
console.log('     家庭版 Windows 无效，强制安装的扩展用户无法自行卸载。');
