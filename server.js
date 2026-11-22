#!/usr/bin/env node
/**
 * ApiPlayer 通用本地服务
 * Node.js 18+：node server.js
 * Bun：bun server.js
 * 默认端口 8787，可用 PORT / HOST 环境变量覆盖。
 */
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { handleRequest } from './lib/handler.js';
import { nodeToWebRequest, sendWebResponse } from './lib/adapter.js';

export function createAppServer() {
    return http.createServer(async (req, res) => {
        try {
            const request = await nodeToWebRequest(req);
            const response = await handleRequest(request);
            await sendWebResponse(res, response);
        } catch (error) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.end('Internal Server Error: ' + (error && error.message ? error.message : error));
        }
    });
}

export async function startServer(port = Number(process.env.PORT || 8787), host = process.env.HOST || '0.0.0.0') {
    const server = createAppServer();
    await new Promise(resolve => server.listen(port, host, resolve));
    console.log(`ApiPlayer 已启动： http://localhost:${port}`);
    return server;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) startServer().catch(error => { console.error(error); process.exitCode = 1; });
