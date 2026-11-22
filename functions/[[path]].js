/**
 * Cloudflare Pages Functions 入口（catch-all）
 * 部署时静态目录请指向 public/，避免 index.html 抢占 /?u= 代理路由。
 */
import { handleRequest } from '../lib/handler.js';

export async function onRequest(context) {
    return handleRequest(context.request);
}
