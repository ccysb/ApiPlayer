import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';

const CORS_ORIGIN = '*';

function jsonResponse(data, init = {}) {
    return new Response(JSON.stringify(data), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        ...init
    });
}

test('OPTIONS 预检返回 CORS 头', async () => {
    const res = await worker.fetch(new Request('http://localhost/', { method: 'OPTIONS' }));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), CORS_ORIGIN);
    assert.equal(res.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS');
    assert.equal(res.headers.get('access-control-allow-headers'), 'Content-Type');
});

test('?u= 缺参返回 400', async () => {
    const res = await worker.fetch(new Request('http://localhost/?u='));
    assert.equal(res.status, 400);
    assert.equal(await res.text(), 'Missing u');
    assert.equal(res.headers.get('access-control-allow-origin'), CORS_ORIGIN);
});

test('?u= 代理透传状态与响应体', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => new Response('{"code":1}', {
        status: 201,
        headers: { 'Content-Type': 'application/json' }
    }));
    const res = await worker.fetch(new Request('http://localhost/?u=' + encodeURIComponent('https://api.example.com/vod')));
    assert.equal(res.status, 201);
    assert.equal(res.headers.get('content-type'), 'application/json');
    assert.equal(await res.text(), '{"code":1}');
});

test('?u= 代理异常返回 502', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => { throw new Error('boom'); });
    const res = await worker.fetch(new Request('http://localhost/?u=' + encodeURIComponent('https://api.example.com/vod')));
    assert.equal(res.status, 502);
    assert.match(await res.text(), /Proxy Error: boom/);
});

test('?u= 不做二次解码，保留 %xx', async (t) => {
    let called = '';
    t.mock.method(globalThis, 'fetch', async (u) => { called = u; return new Response('{}'); });
    await worker.fetch(new Request('http://localhost/?u=' + encodeURIComponent('https://x.example.com/a%2Fb')));
    assert.equal(called, 'https://x.example.com/a%2Fb');
});

test('首页返回内嵌页面', async () => {
    const res = await worker.fetch(new Request('http://localhost/'));
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const body = await res.text();
    assert.ok(body.startsWith('<!DOCTYPE html>'));
    assert.ok(body.includes('x-data="app"'));
});

// ---------- m3u8 代理 ----------

function m3u8Request(url, extra = '') {
    return new Request('http://localhost/?m3u8=' + encodeURIComponent(url) + extra);
}

test('m3u8 相对分片地址绝对化（skip=0）', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => new Response(
        '#EXTM3U\n#EXTINF:10,\nseg0.ts\n#EXTINF:10,\nseg1.ts\n#EXT-X-ENDLIST\n'
    ));
    const res = await worker.fetch(m3u8Request('https://cdn.example.com/live/index.m3u8', '&skip=0'));
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/vnd\.apple\.mpegurl/);
    const body = await res.text();
    assert.ok(body.includes('https://cdn.example.com/live/seg0.ts'));
    assert.ok(body.includes('https://cdn.example.com/live/seg1.ts'));
});

test('m3u8 skip=1 跳过首个分片但保留标签', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => new Response(
        '#EXTM3U\n#EXTINF:10,\nseg0.ts\n#EXTINF:10,\nseg1.ts\n#EXT-X-ENDLIST\n'
    ));
    const res = await worker.fetch(m3u8Request('https://cdn.example.com/live/index.m3u8', '&skip=1'));
    const body = await res.text();
    assert.ok(!body.includes('https://cdn.example.com/live/seg0.ts'));
    assert.ok(body.includes('https://cdn.example.com/live/seg1.ts'));
    assert.ok(body.includes('#EXTINF:10,'));
});

test('m3u8 master playlist 二次抓取子列表', async (t) => {
    const urls = [];
    let n = 0;
    t.mock.method(globalThis, 'fetch', async (u) => {
        urls.push(u);
        n++;
        if (n === 1) return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nsub/index.m3u8\n');
        return new Response('#EXTM3U\n#EXTINF:10,\nchunk.ts\n#EXT-X-ENDLIST\n');
    });
    const res = await worker.fetch(m3u8Request('https://cdn.example.com/live/master.m3u8', '&skip=0'));
    assert.equal(n, 2);
    assert.equal(urls[1], 'https://cdn.example.com/live/sub/index.m3u8');
    assert.ok((await res.text()).includes('https://cdn.example.com/live/sub/chunk.ts'));
});

test('m3u8 HTTP 错误返回 502', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => new Response('not found', { status: 404 }));
    const res = await worker.fetch(m3u8Request('https://cdn.example.com/live/x.m3u8'));
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.match(body.error, /HTTP_404_/);
    assert.match(body.error, /not found/);
});

test('m3u8 空响应返回 502 EMPTY_RESPONSE', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => new Response('short'));
    const res = await worker.fetch(m3u8Request('https://cdn.example.com/live/x.m3u8'));
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /EMPTY_RESPONSE/);
});

test('m3u8 请求头带 UA 与 Referer', async (t) => {
    let init;
    t.mock.method(globalThis, 'fetch', async (_u, i) => { init = i; return new Response('#EXTM3U\n#EXTINF:1,\na.ts\n'); });
    await worker.fetch(m3u8Request('https://cdn.example.com/live/index.m3u8'));
    assert.match(init.headers['User-Agent'], /Chrome\/120/);
    assert.equal(init.headers['Referer'], 'https://cdn.example.com/live/');
    assert.equal(init.headers['Origin'], 'https://cdn.example.com');
});

// ---------- /parse/ 地址嗅探 ----------

test('/parse/ 直接播放地址返回 direct', async () => {
    const res = await worker.fetch(new Request('http://localhost/parse/https://cdn.example.com/a.m3u8'));
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.type, 'direct');
    assert.equal(data.resolved, true);
    assert.equal(data.origin, 'https://cdn.example.com');
});

test('/parse/ 网页含 m3u8 返回 webpage_with_m3u8', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => new Response('<html><script>url="https://cdn.example.com/v.m3u8"</script></html>'));
    const res = await worker.fetch(new Request('http://localhost/parse/https://example.com/play/123'));
    const data = await res.json();
    assert.equal(data.type, 'webpage_with_m3u8');
    assert.equal(data.m3u8, 'https://cdn.example.com/v.m3u8');
    assert.equal(data.resolved, true);
});

test('/parse/ ArtPlayer 配置返回 player_video', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => new Response("<html>new Artplayer({url:'https://x.example.com/a.mp4'})</html>"));
    const res = await worker.fetch(new Request('http://localhost/parse/https://example.com/play/123'));
    const data = await res.json();
    assert.equal(data.type, 'player_video');
    assert.equal(data.m3u8, 'https://x.example.com/a.mp4');
});

test('/parse/ JSON 配置递归提取视频地址（api_video）', async (t) => {
    const html = '<html>var cfg = {"data":[{"url":"https://x.example.com/b.mp4"}]};</html>';
    let n = 0;
    t.mock.method(globalThis, 'fetch', async () => { n++; return new Response(html); });
    const res = await worker.fetch(new Request('http://localhost/parse/https://example.com/play/123'));
    const data = await res.json();
    assert.equal(data.type, 'api_video');
    assert.equal(data.m3u8, 'https://x.example.com/b.mp4');
    assert.equal(n, 1); // JSON 分支直接返回，不再发起后续 API 请求
});

test('/parse/ 排除含 example/config 的误判字符串', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => new Response('<html>var cfg = {"note":"http://example.com/config/a-very-long-url"};</html>'));
    const res = await worker.fetch(new Request('http://localhost/parse/https://example.com/page.html'));
    const data = await res.json();
    assert.equal(data.resolved, false);
    assert.equal(data.m3u8, null);
});

test('/parse/ iframe 返回 iframe 且未解析', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => new Response('<html><iframe src="https://embed.example.com/v"></iframe></html>'));
    const res = await worker.fetch(new Request('http://localhost/parse/https://example.com/play/123'));
    const data = await res.json();
    assert.equal(data.type, 'iframe');
    assert.equal(data.url, 'https://embed.example.com/v');
    assert.equal(data.resolved, false);
});

test('/parse/ JS 跳转返回 js_redirect 且未解析', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => new Response('<html><script>window.location="https://next.example.com/v"</script></html>'));
    const res = await worker.fetch(new Request('http://localhost/parse/https://example.com/play/123'));
    const data = await res.json();
    assert.equal(data.type, 'js_redirect');
    assert.equal(data.url, 'https://next.example.com/v');
    assert.equal(data.resolved, false);
});

test('/parse/ 未知地址返回 unknown', async () => {
    const res = await worker.fetch(new Request('http://localhost/parse/https://example.com/about'));
    const data = await res.json();
    assert.equal(data.type, 'unknown');
    assert.equal(data.resolved, false);
});
