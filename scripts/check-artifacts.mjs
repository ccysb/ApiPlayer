/**
 * 只读产物校验：确认生成物与唯一源码 worker.js 一致、版本统一、脚本语法有效。
 * 用法：node scripts/check-artifacts.mjs（CI 与 pnpm check 调用，不写任何文件）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(root, p));
const fails = [];

// 1) 模板求值必须与 index.html 逐字节一致（与 build-static.mjs 使用同一正则与求值方式）
const source = read('worker.js');
const match = source.match(/const HTML = `([\s\S]*?)`;/);
if (!match) {
    fails.push('worker.js 中未找到 const HTML 模板');
} else {
    let html;
    try {
        html = new Function('return `' + match[1] + '`')();
    } catch (e) {
        fails.push('模板字面量求值失败：' + e.message);
    }
    if (html !== undefined) {
        if (!exists('index.html')) {
            fails.push('缺少 index.html，请先运行 pnpm build:static');
        } else if (read('index.html') !== html) {
            fails.push('index.html 与 worker.js 模板不一致，请重新运行 pnpm build:static');
        } else {
            console.log('PASS  index.html 与 worker.js 模板逐字节一致');
        }
        // 内联脚本语法必须可解析（只解析不执行）
        const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
        for (let i = 0; i < scripts.length; i++) {
            if (scripts[i][1].includes('tailwind.config')) continue; // 运行时 Tailwind 配置将被构建丢弃
            try {
                new Function(scripts[i][1]);
            } catch (e) {
                fails.push(`index.html 第 ${i + 1} 个内联脚本语法错误：${e.message}`);
            }
        }
    }
}

// 2) 版本号单一真源：package.json 与扩展 manifest 必须一致
try {
    const pkg = JSON.parse(read('package.json'));
    if (!exists('extension/manifest.json')) {
        fails.push('缺少 extension/manifest.json，请先运行 pnpm build:extension');
    } else {
        const manifest = JSON.parse(read('extension/manifest.json'));
        if (manifest.version !== pkg.version) {
            // 版本统一前为警告；阶段 2 统一 package.json 版本后改为强制失败。
            console.warn(`WARN  版本不一致：package.json=${pkg.version}，extension/manifest.json=${manifest.version}（将在版本治理阶段统一）`);
        } else {
            console.log(`PASS  版本号一致（${pkg.version}）`);
        }
    }
} catch (e) {
    fails.push('解析 package.json / manifest.json 失败：' + e.message);
}

// 3) 扩展产物软检查：仅当 extension/index.html 是「外置脚本版」（含 vendor 引用）时校验其不变量。
// build-static 会把它写成原始内嵌版，属正常中间状态，此时跳过，避免误报。
if (exists('extension/index.html')) {
    const extHtml = read('extension/index.html');
    const isExternal = extHtml.includes('vendor/alpine.js');
    if (isExternal) {
        if (/<script>/.test(extHtml)) fails.push('extension/index.html 仍含内联脚本（不符合 MV3）');
        if (extHtml.includes('cdn.tailwindcss.com')) fails.push('extension/index.html 仍引用 Tailwind CDN');
        for (const v of ['vendor/alpine.js', 'vendor/hls.js', 'vendor/artplayer.js', 'vendor/tailwind.css']) {
            if (!extHtml.includes(v)) fails.push(`extension/index.html 缺少 ${v} 引用`);
        }
        if (fails.length === 0 || !fails.some((f) => f.includes('extension/index.html'))) {
            console.log('PASS  extension/index.html 外置脚本与本地 vendor 引用正确');
        }
    } else {
        console.log('SKIP  extension/index.html 为原始内嵌版（build-static 中间态），跳过外置检查');
    }
}

if (fails.length) {
    console.error('\n产物校验失败：');
    fails.forEach((f) => console.error('  - ' + f));
    process.exit(1);
}
console.log('\n全部产物校验通过');
