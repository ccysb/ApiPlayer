/**
 * 跨平台请求入口
 * 直接复用 worker.js 的 fetch 处理逻辑，避免为不同平台维护多份服务端代码。
 * 仅使用 Web 标准 API，可用于 Cloudflare Workers/Pages、Node.js、Bun。
 */
import worker from '../worker.js';

export async function handleRequest(request) {
    return await worker.fetch(request, {});
}
