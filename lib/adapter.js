/**
 * Node.js HTTP req/res <-> Web Request/Response 适配
 * 仅 Vercel / 本地 Node 服务使用；Cloudflare Pages 直接传 Web Request，无需本文件。
 */

export async function nodeToWebRequest(req) {
    const host = req.headers.host || 'localhost';
    const url = new URL(req.url || '/', `http://${host}`);
    const method = req.method || 'GET';
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers || {})) {
        if (Array.isArray(value)) value.forEach(v => headers.append(key, v));
        else if (value !== undefined) headers.set(key, String(value));
    }
    const init = { method, headers };
    if (!['GET', 'HEAD'].includes(method)) {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = Buffer.concat(chunks);
        if (body.length) init.body = body;
    }
    return new Request(url, init);
}

export async function sendWebResponse(res, response) {
    res.statusCode = response.status || 200;
    response.headers.forEach((value, key) => res.setHeader(key, value));
    const buffer = Buffer.from(await response.arrayBuffer());
    res.end(buffer);
}
