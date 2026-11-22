/**
 * 从 worker.js 的内嵌模板生成静态 index.html（及扩展副本）
 * 用法：node scripts/build-static.mjs  或  pnpm build:static
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'worker.js'), 'utf8');
const match = source.match(/const HTML = `([\s\S]*?)`;/);

if (!match) {
    console.error('未在 worker.js 中找到 const HTML 模板');
    process.exit(1);
}

// 必须像 JS 引擎一样对模板字面量求值，而不是简单替换 <\/script>：
// 模板里的 \/ \s \$ \\ 等转义都会被引擎处理。若只做字符串替换，
// 产物的正则（如 /\/+$/）会保留反斜杠，而 wrangler 部署时会变成 //+$/，
// 导致两端行为不一致（wrangler 端语法错误）。用 new Function 求值可保证与部署完全一致。
// 安全检查：模板内不应出现反引号或未转义的 ${（会导致插值/语法问题）
if (match[1].includes('`') || /\$\{/.test(match[1])) {
    console.error('模板内含反引号或未转义的 ${，请先转义');
    process.exit(1);
}
let html;
try {
    html = new Function('return `' + match[1] + '`')();
} catch (e) {
    console.error('模板字面量求值失败（模板内可能含未转义的反引号或 ${）：', e.message);
    process.exit(1);
}
fs.writeFileSync(path.join(root, 'index.html'), html, 'utf8');

const extensionDir = path.join(root, 'extension');
if (fs.existsSync(extensionDir)) {
    fs.writeFileSync(path.join(extensionDir, 'index.html'), html, 'utf8');
    console.log(`已生成 index.html 与 extension/index.html（${html.length} 字符）`);
} else {
    console.log(`已生成 index.html（${html.length} 字符）`);
}
