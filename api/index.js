/**
 * Vercel Serverless Function 入口
 * 所有路由经 vercel.json rewrite 到这里，再交给通用 handler 处理。
 */
import { nodeToWebRequest, sendWebResponse } from '../lib/adapter.js';
import { handleRequest } from '../lib/handler.js';

export default async function handler(req, res) {
    try {
        const request = await nodeToWebRequest(req);
        const response = await handleRequest(request);
        await sendWebResponse(res, response);
    } catch (error) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('Internal Server Error: ' + (error && error.message ? error.message : error));
    }
}
