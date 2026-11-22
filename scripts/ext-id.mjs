/**
 * 从 .pem 私钥计算浏览器扩展 ID（32 位 a-p 字符串）。
 * 用途：核对 build-crx.mjs 打印的扩展 ID，或手动填到企业策略 / 文档。
 * 算法与 crx3 内部一致：SHA256(公钥 SPKI DER) 前 16 字节 → hex → 每字符 c 映射 (parseInt(c,16)+10).toString(26)。
 *
 * 用法：node scripts/ext-id.mjs [私钥路径]
 *   默认私钥：crx-output/ApiPlayer.pem
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pemPath = process.argv[2]
    ? path.resolve(process.cwd(), process.argv[2])
    : path.join(root, 'crx-output', 'ApiPlayer.pem');

let pem;
try {
    pem = fs.readFileSync(pemPath);
} catch (e) {
    console.error(`读取私钥失败：${pemPath}`);
    process.exit(1);
}

try {
    const publicKey = crypto.createPublicKey(crypto.createPrivateKey(pem));
    const digest = crypto.createHash('sha256')
        .update(publicKey.export({ type: 'spki', format: 'der' }))
        .digest()
        .slice(0, 16);
    const extId = digest.toString('hex').split('')
        .map((c) => (parseInt(c, 16) + 10).toString(26))
        .join('');
    console.log(extId);
} catch (e) {
    console.error(`解析私钥失败：${e && e.message ? e.message : e}`);
    process.exit(1);
}
