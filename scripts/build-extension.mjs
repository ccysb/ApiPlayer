/**
 * 构建浏览器扩展版本（Manifest V3，符合严格 CSP，无 unsafe-eval）
 * 1) 依赖本地化：Alpine 用 CSP 版（自带表达式解析器，不依赖 new Function）；
 *    hls.js / artplayer 本地化；Tailwind 已在 build-tailwind.mjs 预编译为静态 CSS。
 * 2) 把内联 <script> 外置（MV3 不允许内联脚本）：
 *    - 第一个内联脚本是 tailwind.config（预编译后不再需要，直接丢弃）
 *    - 其余外置为 app.js（含 Alpine.data 注册）
 * 3) 扩展不使用 popup：点击工具栏图标时由 background.js 打开独立标签页。
 * 用法：node scripts/build-extension.mjs  或  pnpm build:extension
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extDir = path.join(root, 'extension');
const vendorDir = path.join(extDir, 'vendor');
fs.mkdirSync(vendorDir, { recursive: true });

const deps = [
    { url: 'https://unpkg.com/@alpinejs/csp@3.15.0/dist/cdn.min.js', file: 'alpine.js' },
    { url: 'https://unpkg.com/hls.js@latest/dist/hls.min.js', file: 'hls.js' },
    { url: 'https://unpkg.com/artplayer@latest/dist/artplayer.js', file: 'artplayer.js' }
];

async function download(url, dest) {
    try {
        const response = await fetch(url, { redirect: 'follow' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        fs.writeFileSync(dest, Buffer.from(await response.arrayBuffer()));
    } catch (error) {
        // 某些网络环境下 Node 的 TLS 会被重置，回退到 curl
        execFileSync('curl', ['-fsSL', '--retry', '2', '-o', dest, url], { stdio: 'pipe' });
    }
}

for (const dep of deps) {
    const dest = path.join(vendorDir, dep.file);
    await download(dep.url, dest);
    console.log(`已下载 ${dep.file}（${Math.round(fs.statSync(dest).size / 1024)} KB）`);
}

// 确保 Tailwind 静态 CSS 存在（单独运行时兜底）
const cssPath = path.join(vendorDir, 'tailwind.css');
if (!fs.existsSync(cssPath)) {
    console.error('缺少 extension/vendor/tailwind.css，请先运行：node scripts/build-tailwind.mjs');
    process.exit(1);
}

let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

// Alpine CSP 解析器不支持正则字面量或除号。属性字符串里的 Tailwind 斜杠（如 bg-primary-900/30）
// 是合法的，先剥掉引号内容再检查，只允许把 / 放在 JS 方法里。
function stripQuoted(expr) {
    return expr
        .replace(/'(?:\\.|[^'\\])*'/g, "''")
        .replace(/"(?:\\.|[^"\\])*"/g, '""')
        .replace(/`(?:\\.|[^`\\])*`/g, '``');
}
const unsupportedSlash = [];
const unsupportedComplex = [];
for (const m of html.matchAll(/\s(?:x-[\w.-]+|@[\w.:-]+|:[\w.-]+)="([^"]*)"/g)) {
    const bare = stripQuoted(m[1]);
    if (bare.includes('/')) unsupportedSlash.push(m[1]);
    // CSP 解析器不支持分号组合语句或 &&(...) 逗号表达式，会报 Unexpected token: xxx
    if (bare.includes(';') || /&&\(/.test(bare)) unsupportedComplex.push(m[1]);
}
if (unsupportedSlash.length) {
    console.error('Alpine 表达式含 /（CSP 解析器会报 Unexpected token: OPERATOR "/"），请移到 app() 方法：');
    unsupportedSlash.forEach((expr) => console.error(`  ${expr}`));
    process.exit(1);
}
if (unsupportedComplex.length) {
    console.error('Alpine 表达式含分号组合语句或逗号表达式（CSP 解析器会报 Unexpected token），请改成无参方法调用：');
    unsupportedComplex.forEach((expr) => console.error(`  ${expr}`));
    process.exit(1);
}

// 防止 this.xxx() 调用了却没有在 app() 里定义（例如 applyPortraitNarrow）。
const inlineScripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
const appCode = inlineScripts.length ? inlineScripts[inlineScripts.length - 1][1] : '';
const calledMethods = [...appCode.matchAll(/this\.([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]);
const definedMethods = new Set([...appCode.matchAll(/^\s+(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/gm)].map((m) => m[1]));
const builtinMethods = new Set(['then', 'catch', 'finally', '$nextTick', '$watch', '$dispatch', '$el', '$refs']);
const missingMethods = [...new Set(calledMethods)].filter((name) => !definedMethods.has(name) && !builtinMethods.has(name));
if (missingMethods.length) {
    console.error('app() 中调用了未定义的方法，会在运行时报 TypeError：');
    missingMethods.forEach((name) => console.error(`  this.${name}()`));
    process.exit(1);
}

const replacements = [
    // Tailwind：CDN JIT 脚本 → 预编译静态 CSS
    [/<script src="https:\/\/cdn\.tailwindcss\.com"><\/script>/, '<link rel="stylesheet" href="vendor/tailwind.css">'],
    // Alpine：标准版 → CSP 版（无 new Function）
    [/<script src="\/\/unpkg\.com\/alpinejs" defer><\/script>/, '<script src="vendor/alpine.js" defer></script>'],
    [/<script src="\/\/unpkg\.com\/hls\.js@latest"><\/script>/, '<script src="vendor/hls.js"></script>'],
    [/<script src="\/\/unpkg\.com\/artplayer\/dist\/artplayer\.js"><\/script>/, '<script src="vendor/artplayer.js"></script>']
];
for (const [pattern, replacement] of replacements) {
    if (!pattern.test(html)) console.warn(`未匹配到依赖引用：${replacement}`);
    html = html.replace(pattern, replacement);
}

// 内联脚本外置：第一个是 tailwind.config（预编译后丢弃），第二个是应用脚本
let inlineIndex = 0;
html = html.replace(/<script>([\s\S]*?)<\/script>/g, (_, code) => {
    inlineIndex++;
    if (inlineIndex === 1 && code.includes('tailwind.config')) {
        return ''; // 丢弃运行时 Tailwind 配置
    }
    fs.writeFileSync(path.join(extDir, 'app.js'), code, 'utf8');
    return '<script src="app.js"></script>';
});

fs.writeFileSync(path.join(extDir, 'index.html'), html, 'utf8');

// 点击工具栏图标时打开独立标签页；如果应用标签页已经存在则直接聚焦，避免重复打开。
const backgroundJs = `// MV3 background：点击扩展图标时在标签页中打开 ApiPlayer。
const APP_PATH = 'index.html';

async function focusOrCreateTab() {
  const url = chrome.runtime.getURL(APP_PATH);
  try {
    const tabs = await chrome.tabs.query({});
    const target = tabs.find((tab) => {
      return tab.url === url || tab.url.startsWith(url + '?') || tab.url.startsWith(url + '#');
    });
    if (target) {
      if (target.windowId !== undefined) {
        await chrome.windows.update(target.windowId, { focused: true });
      }
      await chrome.tabs.update(target.id, { active: true });
      return;
    }
  } catch (error) {
    // 查询失败时直接新建标签页，保证「点击即打开」。
  }
  await chrome.tabs.create({ url });
}

chrome.action.onClicked.addListener(focusOrCreateTab);
`;
fs.writeFileSync(path.join(extDir, 'background.js'), backgroundJs, 'utf8');

const manifest = {
  manifest_version: 3,
  name: 'ApiPlayer',
  version: '1.0.6',
  description: 'CMS 聚合播放器浏览器扩展（主题滚动条、全高集数面板、CSP 表达式兼容）',
  action: {
    default_title: '打开 ApiPlayer'
  },
  background: {
    service_worker: 'background.js'
  },
  options_page: 'index.html',
  permissions: ['storage', 'tabs'],
  host_permissions: ['<all_urls>'],
  content_security_policy: {
    extension_pages: "script-src 'self'; object-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: http:; media-src 'self' https: http:; connect-src * http: https:"
  }
};
fs.writeFileSync(path.join(extDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

console.log(`扩展构建完成：extension/index.html（外置应用脚本，Tailwind 已静态化），点击图标将打开标签页`);
