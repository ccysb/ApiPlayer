/**
 * 预编译 Tailwind 静态 CSS，供浏览器扩展使用。
 * MV3 扩展页面禁止 unsafe-eval，不能用 cdn.tailwindcss.com 的 JIT 运行时；
 * 这里用 Tailwind CLI 扫描页面里用到的 class，生成纯静态 CSS。
 * 用法：node scripts/build-tailwind.mjs  或  pnpm build:tailwind
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

let cli;
try {
    const pkgPath = require.resolve('tailwindcss/package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin.tailwindcss;
    cli = path.resolve(path.dirname(pkgPath), bin);
} catch (e) {
    console.error('未找到 tailwindcss，请先运行：pnpm add -D tailwindcss@3');
    process.exit(1);
}

const out = path.join(root, 'extension', 'vendor', 'tailwind.css');
fs.mkdirSync(path.dirname(out), { recursive: true });

try {
    execFileSync(process.execPath, [
        cli,
        '-i', path.join(root, 'src', 'input.css'),
        '-o', out,
        '-c', path.join(root, 'tailwind.config.js'),
        '--minify'
    ], { cwd: root, stdio: 'inherit' });
    console.log(`Tailwind 已预编译：extension/vendor/tailwind.css（${Math.round(fs.statSync(out).size / 1024)} KB）`);
} catch (e) {
    console.error('Tailwind 编译失败：', e.message);
    process.exit(1);
}
