/**
 * ApiPlayer - CMS 聚合播放器（唯一源码）
 *
 * 本文件同时包含两部分：
 *   1. 服务端：Web 标准 API 实现的 fetch 入口（API 代理 / m3u8 改写 / 地址嗅探），
 *      被 Cloudflare Workers、Vercel、Cloudflare Pages、Node/Bun 直接复用。
 *   2. 前端：内嵌的 HTML 模板常量 `HTML`，内含 Alpine.js 应用 `app()`。
 *
 * 约定：修改页面只改本文件的 `HTML` 模板，再执行 `pnpm build:static` 生成 index.html、
 * `pnpm build:extension` 生成浏览器扩展。不要直接编辑产物。
 * 部署说明见 DEPLOY.md，项目概览见 README.md。
 */

/**
 * 媒体日志分级（避免逐分片刷屏导致控制台卡死）：
 *  - DEBUG（逐条抓取/逐分片）：默认关闭。仅当 DEBUG_MEDIA=1 或请求带 debug=1 时输出。
 *  - INFO（汇总）：每次 m3u8 代理结束只输出一条，取代过去的逐条输出。
 *  - WARN/ERROR（错误与异常）：始终保留。
 * Cloudflare Workers 无 process，这里统一用 typeof 保护，兼容 Workers / Node / Bun。
 */
const MEDIA_DEBUG = (() => {
    try {
        if (typeof globalThis !== 'undefined' && globalThis.DEBUG_MEDIA) return true;
        if (typeof process !== 'undefined' && process && process.env && process.env.DEBUG_MEDIA) return true;
    } catch (e) { }
    return false;
})();


function extractVideoFromJson(data) {
    if (!data || typeof data !== 'object') return null;

    const videoFields = ['url', 'src', 'file', 'playUrl', 'videoUrl', 'video_url', 'play_url', 'stream', 'hls', 'm3u8', 'mp4', 'source', 'data', 'info', 'player'];

    for (const field of videoFields) {
        if (data[field]) {
            const val = data[field];
            if (typeof val === 'string') {
                if (val.includes('.m3u8') || val.includes('.mp4') || val.includes('.webm') || val.startsWith('http')) {
                    return val;
                }
            } else if (Array.isArray(val) && val.length > 0) {
                for (const item of val) {
                    if (typeof item === 'string') {
                        if (item.includes('.m3u8') || item.includes('.mp4') || item.includes('.webm')) {
                            return item;
                        }
                    } else if (item && typeof item === 'object') {
                        const nested = extractVideoFromJson(item);
                        if (nested) return nested;
                    }
                }
            } else if (typeof val === 'object' && val !== null) {
                const nested = extractVideoFromJson(val);
                if (nested) return nested;
            }
        }
    }

    for (const key of Object.keys(data)) {
        const val = data[key];
        if (typeof val === 'string') {
            if (/\.(m3u8|mp4|webm|mov)(\?|$)/.test(val) || (val.startsWith('http') && !val.includes('example') && val.length > 20)) {
                if (!val.includes('json') && !val.includes('config') && !val.includes('css')) {
                    return val;
                }
            }
        }
    }

    return null;
}

async function handleM3u8Proxy(rawUrl, skip = 1, debug = false) {
    let target = decodeURIComponent(rawUrl);
    if (!target.startsWith('http')) target = 'https:' + target;
    const base = target.substring(0, target.lastIndexOf('/') + 1);
    // 汇总统计：只在按需调试时输出一次，避免逐分片/逐请求刷屏
    const stats = { fetches: 0, variants: 0, segments: 0, skipped: 0, bytes: 0 };
    const logDebug = (...args) => { if (debug) console.log('[m3u8]', ...args); };

    async function fetchM3u8(u) {
        stats.fetches++;
        logDebug('fetching:', u);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        try {
            const r = await fetch(u, {
                method: 'GET',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': '*/*',
                    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
                    'Referer': base,
                    'Origin': new URL(base).origin
                },
                redirect: 'follow',
                signal: controller.signal
            });
            clearTimeout(timer);
            if (!r.ok) {
                const errText = await r.text().catch(() => '');
                throw new Error('HTTP_' + r.status + '_' + u + (errText ? '_' + errText.slice(0, 200) : ''));
            }
            const text = await r.text();
            stats.bytes += text.length;
            if (!text || text.length < 10) throw new Error('EMPTY_RESPONSE_' + u);
            return text;
        } catch (e) {
            clearTimeout(timer);
            if (e.name === 'AbortError') throw new Error('TIMEOUT_' + u);
            throw e;
        }
    }

    let text = await fetchM3u8(target);
    let m3u8Base = target;

    if (text.includes('#EXTM3U') && text.includes('#EXT-X-STREAM-INF')) {
        const lines = text.split('\n');
        let found = false;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line && !line.startsWith('#') && (line.endsWith('.m3u8') || line.includes('.m3u8'))) {
                let streamUrl = line;
                if (!streamUrl.startsWith('http')) {
                    try { streamUrl = new URL(streamUrl, target).href; } catch (e) { streamUrl = base + (streamUrl.startsWith('/') ? '' : '/') + streamUrl; }
                }
                m3u8Base = streamUrl;
                text = await fetchM3u8(streamUrl);
                stats.variants++;
                found = true;
                break;
            }
        }
        if (!found) throw new Error('NO_STREAM_URL');
    }

    text = text.split('\n').map(line => {
        const t = line.trim();
        if (!t || t.startsWith('#') || t.startsWith('http')) return line;
        try { return new URL(t, m3u8Base).href; } catch (e) { return line; }
    }).join('\n');

    if (skip > 0) {
        const segLines = text.split('\n');
        const out = [];
        let skipped = 0;

        for (let i = 0; i < segLines.length; i++) {
            const raw = segLines[i];
            const line = raw.trim();
            const isSeg = line && !line.startsWith('#') && (line.includes('.ts') || line.includes('.m4s'));

            if (isSeg) {
                stats.segments++;
                if (skipped < skip) {
                    skipped++;
                    stats.skipped++;
                    continue;
                }
            }
            out.push(raw);
        }
        text = out.join('\n');
    } else {
        // skip=0 时同样统计分片数，保证汇总信息准确（不额外输出日志）
        stats.segments = text.split('\n').filter(line => {
            const t = line.trim();
            return t && !t.startsWith('#') && (t.includes('.ts') || t.includes('.m4s'));
        }).length;
    }

    // 每次代理只输出一条汇总（默认静默，MEDIA_DEBUG/请求 debug=1 时可见），不再逐分片刷屏
    logDebug('summary', JSON.stringify({ url: target, ...stats }));
    return text;
}

async function parsePlayUrl(url) {
    const parseResult = {
        type: 'unknown',
        url: url,
        m3u8: null,
        origin: null,
        resolved: false
    };

    const lowerUrl = url.toLowerCase();

    if (lowerUrl.includes('.m3u8') || lowerUrl.includes('.ts') || lowerUrl.includes('.mp4')) {
        parseResult.type = 'direct';
        parseResult.resolved = true;
        parseResult.origin = new URL(url).origin;
        return parseResult;
    }

    if (lowerUrl.includes('.html') || lowerUrl.includes('.htm') || lowerUrl.includes('/play/') || lowerUrl.includes('/player/')) {
        parseResult.type = 'webpage';

        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 10000);

            const response = await fetch(url, {
                signal: controller.signal,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });

            clearTimeout(timer);
            const html = await response.text();

            const m3u8Match = html.match(/(https?:\/\/[^\s"']+\.m3u8[^\s"']*)/);
            if (m3u8Match) {
                parseResult.m3u8 = m3u8Match[1];
                parseResult.type = 'webpage_with_m3u8';
                parseResult.resolved = true;
                return parseResult;
            }

            const playerUrlMatch = html.match(/Video url["']?\s*[:=]\s*["']([^"']+)["']/i) ||
                html.match(/video\s*:\s*["']([^"']+\.mp4[^"']*)["']/i) ||
                html.match(/src\s*:\s*["']([^"']+\.(?:mp4|m3u8|webm)[^"']*)["']/gi) ||
                html.match(/player\.src\s*\(\s*["']([^"']+)["']/i) ||
                html.match(/new\s+DPlayer\s*\([^)]*url\s*:\s*["']([^"']+)["']/i) ||
                html.match(/new\s+Artplayer\s*\([^)]*url\s*:\s*["']([^"']+)["']/i);
            if (playerUrlMatch) {
                const videoUrl = playerUrlMatch[1];
                if (videoUrl.startsWith('http')) {
                    parseResult.m3u8 = videoUrl;
                    parseResult.type = 'player_video';
                    parseResult.resolved = true;
                    return parseResult;
                }
            }

            const jsonMatch = html.match(/var\s+\w+\s*=\s*(\{[\s\S]*?\});/);
            if (jsonMatch) {
                try {
                    const jsonData = JSON.parse(jsonMatch[1]);
                    const extracted = extractVideoFromJson(jsonData);
                    if (extracted) {
                        parseResult.m3u8 = extracted;
                        parseResult.type = 'api_video';
                        parseResult.resolved = true;
                        return parseResult;
                    }
                } catch (e) { }
            }

            const iframeMatch = html.match(/<iframe[^>]+src=["']([^"']+)["']/i);
            if (iframeMatch) {
                parseResult.type = 'iframe';
                parseResult.url = iframeMatch[1];
                parseResult.resolved = false;
                return parseResult;
            }

            const jsMatch = html.match(/(window\.|document\.)(location|href|src)\s*=\s*["']([^"']+)["']/);
            if (jsMatch) {
                parseResult.type = 'js_redirect';
                parseResult.url = jsMatch[3];
                parseResult.resolved = false;
                return parseResult;
            }

            const apiMatch = url.match(/\/play\/([a-zA-Z0-9]+)/);
            if (apiMatch) {
                const videoId = apiMatch[1];
                const baseUrl = new URL(url).origin;
                const apiUrls = [
                    baseUrl + '/api/player/' + videoId,
                    baseUrl + '/api/vid/' + videoId,
                    baseUrl + '/player/' + videoId + '/info',
                    baseUrl + '/api/source/' + videoId,
                    baseUrl + '/api/video/' + videoId
                ];
                for (const apiUrl of apiUrls) {
                    try {
                        const apiResp = await fetch(apiUrl, {
                            signal: controller.signal,
                            headers: { 'User-Agent': 'Mozilla/5.0' }
                        });
                        if (apiResp.ok) {
                            const apiData = await apiResp.json();
                            const extracted = extractVideoFromJson(apiData);
                            if (extracted) {
                                parseResult.m3u8 = extracted;
                                parseResult.type = 'api_video';
                                parseResult.resolved = true;
                                return parseResult;
                            }
                        }
                    } catch (e) {
                        continue;
                    }
                }
            }

        } catch (e) {
            parseResult.error = e.message;
        }

        return parseResult;
    }

    parseResult.type = 'unknown';
    return parseResult;
}

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
};
async function proxy(req) {// 代理请求
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    // searchParams.get() 已自动解码一次；再 decodeURIComponent 会把 URL 中的 %xx 二次解码导致地址损坏
    const t = new URL(req.url).searchParams.get('u');
    if (!t) return new Response('Missing u', { status: 400, headers: CORS });

    try {
        const r = await fetch(t, {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        return new Response(await r.text(), {
            status: r.status,
            headers: {
                'Content-Type': r.headers.get('Content-Type') || 'application/json; charset=utf-8',
                ...CORS
            }
        });
    } catch (e) {
        return new Response('Proxy Error: ' + e.message, { status: 502, headers: CORS });
    }
}

const HTML = `<!DOCTYPE html>
<html lang="zh-CN" class="scroll-smooth">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no">
  <meta name="theme-color" content="#8b5cf6">
  <title>ApiPlayer</title>
  <script src="https://cdn.tailwindcss.com"><\/script>
  <script src="//unpkg.com/alpinejs" defer></script>
  <script src="//unpkg.com/hls.js@latest"><\/script>
  <script src="//unpkg.com/artplayer/dist/artplayer.js"><\/script>
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {
          colors: {
            primary: {
              50:'#f5f3ff',100:'#ede9fe',200:'#ddd6fe',300:'#c4b5fd',400:'#a78bfa',
              500:'#8b5cf6',600:'#7c3aed',700:'#6d28d9',800:'#5b21b6',900:'#4c1d95'
            }
          }
        }
      }
    }
  <\/script>
  <style>
    [x-cloak]{display:none!important}
    /* 滚动条跟随主题：:root 为日间，html.dark 为夜间（applyTheme 会切换该 class） */
    :root{
      color-scheme:light;
      --sb-track:#f3f4f6;
      --sb-thumb:#cbd5e1;
      --sb-thumb-hover:#94a3b8;
    }
    html.dark{
      color-scheme:dark;
      --sb-track:#030712;
      --sb-thumb:#374151;
      --sb-thumb-hover:#4b5563;
    }
    *{scrollbar-width:thin;scrollbar-color:var(--sb-thumb) var(--sb-track)}
    *::-webkit-scrollbar{width:8px;height:8px}
    *::-webkit-scrollbar-track{background:var(--sb-track)}
    *::-webkit-scrollbar-thumb{background:var(--sb-thumb);border:2px solid var(--sb-track);border-radius:9999px}
    *::-webkit-scrollbar-thumb:hover{background:var(--sb-thumb-hover)}
    *::-webkit-scrollbar-corner{background:var(--sb-track)}
    .scrollbar-hide{-ms-overflow-style:none;scrollbar-width:none}
    .scrollbar-hide::-webkit-scrollbar{display:none}
    .card-hover{transition:all .25s cubic-bezier(.4,0,.2,1)}
    .card-hover:hover{transform:translateY(-6px);box-shadow:0 20px 40px rgba(0,0,0,.15)}
    .line-clamp-1{overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:1}
    .line-clamp-2{overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2}
    @keyframes spin { to { transform: rotate(360deg) } }
    .animate-spin { animation: spin 1s linear infinite }
    /* 主内容布局：网格保留海报宽度 竖屏 224px / 横屏 280px；卡片墙由 JS 绝对定位 */
    .ts-grid-poster{display:grid;grid-template-columns:repeat(auto-fill,minmax(224px,1fr));gap:1rem}
    .ts-grid-land{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:1rem}
    @media (max-width:640px){.ts-grid-poster,.ts-grid-land{grid-template-columns:repeat(2,minmax(0,1fr))}}
    .ts-wall{position:relative;width:100%;min-height:1px}
    .ts-wall>.ts-wf-item{position:absolute;top:0;left:0;box-sizing:border-box}
    .ts-grid-poster>.ts-wf-item,.ts-grid-land>.ts-wf-item{position:static;width:auto!important;left:auto!important;top:auto!important}
    /* 全宽布局：容器铺满可用宽度，仅保留内容内边距；clip 避免窄屏出现横向滚动条且不影响 sticky 顶栏 */
    body{overflow-x:clip}
  </style>
</head>
<body class="bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100 min-h-screen" x-data="app" x-init="init()" :class="bodyOverlayClass()">

<header class="sticky top-0 z-40 bg-white/80 dark:bg-gray-900/80 backdrop-blur-xl border-b border-gray-200 dark:border-gray-800">
  <div class="w-full px-4 sm:px-6 py-3">
    <div class="flex flex-wrap items-center gap-3">
      <!-- 左上角：API 源名称；小屏幕额外提供搜索图标 -->
      <div class="flex flex-1 items-center gap-2 justify-between">
        <div class="min-w-0 leading-tight mr-2">
          <div class="text-lg font-semibold truncate" x-text="activeSourceName || '未选择API源'" :title="activeSourceName"></div>
        </div>        
        <button @click="openMobileSearch()" class="sm:hidden p-2 -ml-2 rounded-xl hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors" title="搜索">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>
        </button>

      </div>

      <!-- 桌面端搜索框居中 -->
      <div class="hidden sm:block max-w-md">
        <div class="relative">
          <input type="text" x-model="searchWd" @keydown.enter="doSearch()" @focus="showSearchHist=true" @blur="hideSearchHistLater()" placeholder="搜索视频..." class="w-full pl-10 pr-20 py-2.5 rounded-full bg-gray-100 dark:bg-gray-800 border-0 focus:ring-2 focus:ring-primary-500 text-sm outline-none">
          <svg class="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>
          <button @click="doSearch()" class="absolute right-1.5 top-1/2 -translate-y-1/2 px-4 py-1.5 rounded-full bg-gradient-to-r from-primary-600 to-primary-500 text-white text-sm font-medium hover:shadow-lg transition-shadow">搜索</button>
          
          <div x-show="showSearchHist && searchHistory.length" class="absolute top-full left-0 right-0 mt-2 bg-white dark:bg-gray-800 rounded-xl shadow-xl border border-gray-200 dark:border-gray-700 py-2 z-50">
            <template x-for="term in searchHistory.slice(0,5)" :key="term">
              <div class="flex items-center group px-4 py-2 hover:bg-gray-100 dark:hover:bg-gray-700">
                <button @click="selectSearchHistory(term)" class="flex-1 flex items-center gap-2 text-left text-sm">
                  <svg class="w-4 h-4 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
                  <span x-text="term" class="truncate"></span>
                </button>
                <button @click="removeSearchHistory(term)" class="ml-2 p-1 rounded text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/30 transition-colors" title="删除">
                  <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
                </button>
              </div>
            </template>
          </div>
        </div>
      </div>

      <!-- 小屏幕：点击搜索图标后弹出搜索框 -->
      <div x-show="mobileSearchOpen" x-transition class="w-full order-last sm:hidden mt-1">
        <div class="relative">
          <input type="text" x-ref="mobileSearchInput" x-model="searchWd" @keydown.enter="doMobileSearch()" @focus="showSearchHist=true" @blur="hideSearchHistLater()" placeholder="搜索视频..." class="w-full pl-10 pr-20 py-2.5 rounded-full bg-gray-100 dark:bg-gray-800 border-0 focus:ring-2 focus:ring-primary-500 text-sm outline-none">
          <svg class="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>
          <button @click="doMobileSearch()" class="absolute right-1.5 top-1/2 -translate-y-1/2 px-4 py-1.5 rounded-full bg-gradient-to-r from-primary-600 to-primary-500 text-white text-sm font-medium">搜索</button>
          <div x-show="showSearchHist && searchHistory.length" class="absolute top-full left-0 right-0 mt-2 bg-white dark:bg-gray-800 rounded-xl shadow-xl border border-gray-200 dark:border-gray-700 py-2 z-50">
            <template x-for="term in searchHistory.slice(0,5)" :key="term">
              <button @click="selectMobileSearchHistory(term)" class="w-full px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2">
                <svg class="w-4 h-4 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
                <span x-text="term" class="truncate"></span>
              </button>
            </template>
          </div>
        </div>
      </div>

      <div class="flex-1 min-w-0 flex items-center justify-end gap-2 shrink-0">
        <button @click="toggleThemeMode()" class="p-2.5 rounded-xl hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors" :title="'主题：' + cfg.theme">
          <template x-if="cfg.theme==='light'">
            <svg class="w-5 h-5 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-1.414-1.414M6.343 6.343 4.93 4.93m12.728 1.414L16.242 7.76M6.343 17.657l-1.414 1.414M16 12a4 4 0 11-8 0 4 4 0 018 0z"/>
            </svg>
          </template>
          <template x-if="cfg.theme==='dark'">
            <svg class="w-5 h-5 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"/>
            </svg>
          </template>
          <template x-if="cfg.theme==='auto'">
            <svg class="w-5 h-5 text-primary-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/>
            </svg>
          </template>
        </button>

        <button @click="toggleFavPanel()" class="relative p-2.5 rounded-xl hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors" :class="favButtonClass()">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z"/></svg>
          <span x-show="fav.length" class="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-red-500 text-white text-xs flex items-center justify-center" x-text="fav.length"></span>
        </button>

        <button @click="toggleHistPanel()" class="relative p-2.5 rounded-xl hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors" :class="histButtonClass()">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
          <span x-show="his.length" class="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-blue-500 text-white text-xs flex items-center justify-center" x-text="his.length"></span>
        </button>

        <button @click="toggleSettingsPanel()" class="p-2.5 rounded-xl hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
        </button>
      </div>
    </div>
  </div>
  <div id="typeNavContainer" class="border-t border-gray-200 dark:border-gray-800 bg-white/90 dark:bg-gray-900/90 backdrop-blur" x-show="classes.length" x-transition>
    <div class="w-full px-4 sm:px-6">
      <div class="flex items-center py-2">
        <ul class="flex items-center flex-nowrap overflow-hidden flex-1 gap-1">
          <li>
            <button @click="selectAllTypes()" class="px-4 py-1.5 rounded-full text-sm font-medium whitespace-nowrap transition-all" :class="currentType==='0'?'bg-gradient-to-r from-primary-600 to-primary-500 text-white shadow-lg shadow-primary-500/30':'hover:bg-gray-100 dark:hover:bg-gray-800'">全部</button>
          </li>
          <template x-for="c in visibleClasses" :key="c.type_id">
            <li>
              <button @click="selectType(c.type_id)" class="px-4 py-1.5 rounded-full text-sm font-medium whitespace-nowrap transition-all" :class="typeIsActive(c.type_id)?'bg-gradient-to-r from-primary-600 to-primary-500 text-white shadow-lg shadow-primary-500/30':'hover:bg-gray-100 dark:hover:bg-gray-800'" x-text="c.type_name"></button>
            </li>
          </template>
        </ul>
        <div x-show="hiddenClasses.length > 0" class="relative pl-2">
          <button @click="toggleMoreTypes($event)" class="px-4 py-1.5 rounded-full text-sm font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors flex items-center" title="更多分类">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"/></svg>
          </button>
          <div x-show="showMoreTypes" x-transition @click.away="showMoreTypes=false" class="absolute right-0 top-full mt-1 w-48 bg-white dark:bg-gray-800 rounded-xl shadow-xl border border-gray-200 dark:border-gray-700 py-1 z-50 max-h-80 overflow-y-auto">
            <template x-for="c in hiddenClasses" :key="c.type_id">
              <button @click="selectTypeCloseMore(c.type_id)" class="w-full px-4 py-2 text-left text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-primary-50 dark:hover:bg-primary-900/30" x-text="c.type_name"></button>
            </template>
          </div>
        </div>
      </div>
    </div>
  </div>
</header>

<main class="w-full px-4 sm:px-6 py-6">
  <div x-show="apiError" x-transition class="mb-4 flex items-start gap-3 p-4 rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-800 dark:text-red-300">
    <svg class="w-5 h-5 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
    <div class="flex-1 min-w-0">
      <p class="text-sm font-semibold mb-1">数据加载失败</p>
      <p class="text-xs break-words" x-text="apiError"></p>
    </div>
    <button @click="apiError=''" class="shrink-0 text-red-500 hover:text-red-700" title="关闭">✕</button>
  </div>

  <div x-show="!sources.length" class="flex flex-col items-center justify-center py-20">
    <div class="w-20 h-20 rounded-2xl bg-gray-100 dark:bg-gray-800 flex items-center justify-center mb-4">
      <svg class="w-10 h-10 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6"/></svg>
    </div>
    <h3 class="text-lg font-semibold mb-2">还没有添加API源</h3>
    <p class="text-gray-500 mb-4">点击右上角设置按钮添加视频源</p>
    <button @click="openSettingsSources()" class="px-6 py-2.5 rounded-xl bg-gradient-to-r from-primary-600 to-primary-500 text-white font-medium hover:shadow-lg hover:shadow-primary-500/30 transition-shadow">去添加</button>
  </div>

  <div x-show="loading" class="py-10 text-center text-gray-500">
    <svg class="animate-spin h-8 w-8 mx-auto text-primary-500" fill="none" viewBox="0 0 24 24">
      <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
      <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
    </svg>
  </div>

  <div id="mainWall" x-show="videos.length" :class="mainWallClass()">
    <template x-for="(item, index) in videos" :key="item.vod_id + '_' + index">
      <div @click="openPlayer(item)" class="ts-wf-item group relative bg-white dark:bg-gray-900 rounded overflow-hidden shadow-sm hover:shadow-xl card-hover cursor-pointer border border-gray-100 dark:border-gray-800">
        <div class="card-media relative bg-gray-100 dark:bg-gray-800 w-full" :class="cfg.listLayout==='poster' ? 'aspect-[2/3]' : 'aspect-[5/3]'">
          <img :src="item.vod_pic || placeholderImg" loading="lazy" class="w-full h-full object-cover" @error="$event.target.src=placeholderImg">
          <div class="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent"></div>
          <span x-show="cardTagText('tl', item)" class="absolute top-2 left-2 px-2 py-1 rounded-md border-white/60 bg-black/40 backdrop-blur text-white text-xs font-medium" x-text="cardTagText('tl', item)"></span>
          <span x-show="cardTagText('tr', item)" class="absolute top-2 right-2 px-2 py-1 rounded-md border-white/60 bg-black/40 backdrop-blur text-white text-xs font-medium" x-text="cardTagText('tr', item)"></span>
          <span x-show="cardTagText('bl', item)" class="absolute bottom-2 left-2 px-2 py-1 rounded-md border-white/60 bg-black/40 backdrop-blur text-white text-xs font-medium" x-text="cardTagText('bl', item)"></span>
          <span x-show="cardTagText('br', item)" class="absolute bottom-2 right-2 px-2 py-1 rounded-md border-white/60 bg-black/40 backdrop-blur text-white text-xs font-medium" x-text="cardTagText('br', item)"></span>
          <button @click.stop="toggleFav(item)" class="absolute top-2 right-2 w-8 h-8 rounded-full bg-black/40 backdrop-blur flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
            <svg class="w-4 h-4" :class="isFav(item.vod_id)?'text-red-500 fill-red-500':'text-white'" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z"/></svg>
          </button>
        </div>
        <div class="p-3">
          <h3 class="font-semibold text-sm line-clamp-2 leading-tight" x-text="item.vod_name || '未命名'"></h3>
          <div class="text-xs text-gray-500 mt-1 flex justify-between gap-2">
            <span x-show="cardTagText('sub1', item)" x-text="cardTagText('sub1', item)" class="truncate"></span>
            <span x-show="cardTagText('sub2', item)" x-text="cardTagText('sub2', item)" class="truncate text-right"></span>
          </div>
        </div>
      </div>
    </template>
  </div>

  <div x-show="cfg.loadMode==='page' && totalPages>1" class="flex justify-center items-center gap-2 mt-8 flex-wrap">
    <button @click="prevPage()" class="px-4 py-2 rounded-xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 hover:border-primary-500 text-sm font-medium transition-colors" :class="page<=1?'opacity-50 cursor-not-allowed':''">上一页</button>
    <template x-for="p in pageRange()" :key="p">
      <button @click="goPage(p)" class="w-10 h-10 rounded-xl text-sm font-medium transition-all" :class="p===page?'bg-gradient-to-r from-primary-600 to-primary-500 text-white shadow-lg shadow-primary-500/30':'bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 hover:border-primary-500'" x-text="p"></button>
    </template>
    <button @click="nextPage()" class="px-4 py-2 rounded-xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 hover:border-primary-500 text-sm font-medium transition-colors" :class="page>=totalPages?'opacity-50 cursor-not-allowed':''">下一页</button>
  </div>

  <div x-show="cfg.loadMode==='waterfall' && videos.length && page < totalPages && !cfg.autoLoadMore" class="flex justify-center mt-8">
    <button @click="loadMore()" :disabled="loading" class="px-6 py-3 rounded-xl bg-gradient-to-r from-primary-600 to-primary-500 text-white font-medium hover:shadow-lg hover:shadow-primary-500/30 transition-shadow disabled:opacity-50">
      <span x-show="!loading">加载更多</span>
      <span x-show="loading">加载中...</span>
    </button>
  </div>

  <div id="loadSentinel" class="h-10"></div>

  <div x-show="sources.length && !loading && !videos.length" class="flex flex-col items-center justify-center py-20">
    <div class="w-16 h-16 rounded-2xl bg-gray-100 dark:bg-gray-800 flex items-center justify-center mb-4">
      <svg class="w-8 h-8 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 4v16M17 4v16M3 8h4m10 0h4M3 12h18M3 16h4m10 0h4M4 20h16a1 1 0 001-1V5a1 1 0 00-1-1H4a1 1 0 00-1 1v14a1 1 0 001 1z"/></svg>
    </div>
    <p class="text-gray-500">暂无视频数据</p>
    <p class="text-gray-400 text-sm mt-1">尝试切换分类或搜索</p>
  </div>
</main>

<div x-show="showFav" x-transition @click.away="closeFavPanel()" class="fixed right-0 top-0 h-full w-full sm:w-80 bg-white dark:bg-gray-900 shadow-2xl z-50 overflow-hidden flex flex-col border-l border-gray-200 dark:border-gray-800">
  <div class="p-4 border-b border-gray-200 dark:border-gray-800 flex items-center justify-between">
    <h2 class="font-bold text-lg">我的收藏</h2>
    <button @click="closeFavPanel()" class="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800">
      <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
    </button>
  </div>
  <div class="flex-1 overflow-y-auto p-4 space-y-3">
    <template x-for="item in fav" :key="item.vod_id">
      <div @click="openFavItem(item)" class="flex gap-3 p-2 rounded-xl hover:bg-gray-100 dark:hover:bg-gray-800 cursor-pointer transition-colors">
        <img :src="item.vod_pic || placeholderImg" class="w-12 h-16 rounded-lg object-cover bg-gray-200 dark:bg-gray-700 flex-shrink-0">
        <div class="flex-1 min-w-0">
          <h4 class="font-medium text-sm line-clamp-1" x-text="item.vod_name"></h4>
          <p class="text-xs text-gray-500 mt-0.5" x-text="item.type_name || ''"></p>
        </div>
        <button @click.stop="toggleFav(item)" class="p-1.5 rounded-lg hover:bg-red-100 dark:hover:bg-red-900/30 text-red-500">
          <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z"/></svg>
        </button>
      </div>
    </template>
    <div x-show="!fav.length" class="text-center text-gray-400 py-8">暂无收藏</div>
  </div>
</div>

<div x-show="showHist" x-transition @click.away="showHist=false" class="fixed right-0 top-0 h-full w-full sm:w-80 bg-white dark:bg-gray-900 shadow-2xl z-50 overflow-hidden flex flex-col border-l border-gray-200 dark:border-gray-800">
  <div class="p-4 border-b border-gray-200 dark:border-gray-800 flex items-center justify-between">
    <h2 class="font-bold text-lg">播放历史</h2>
    <div class="flex items-center gap-2">
      <button @click="clearHist()" class="text-xs text-red-500 hover:text-red-600">清空</button>
      <button @click="showHist=false" class="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800">
        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
      </button>
    </div>
  </div>
  <div class="flex-1 overflow-y-auto p-4 space-y-3">
    <template x-for="item in his" :key="item.vod_id + '_' + item.last_watch_time">
      <div @click="openHistItem(item)" class="flex gap-3 p-2 rounded-xl hover:bg-gray-100 dark:hover:bg-gray-800 cursor-pointer transition-colors">
        <img :src="item.vod_pic || placeholderImg" class="w-12 h-16 rounded-lg object-cover bg-gray-200 dark:bg-gray-700 flex-shrink-0">
        <div class="flex-1 min-w-0">
          <h4 class="font-medium text-sm line-clamp-1" x-text="item.vod_name"></h4>
          <p class="text-xs text-gray-500 mt-0.5" x-text="formatTime(item.last_watch_time)"></p>
        </div>
      </div>
    </template>
    <div x-show="!his.length" class="text-center text-gray-400 py-8">暂无历史</div>
  </div>
</div>

<div x-show="showSettings" x-transition class="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4" @click.self="showSettings=false">
  <div class="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-lg max-h-full overflow-hidden flex flex-col" @click.stop>
    <div class="p-4 border-b border-gray-200 dark:border-gray-800 flex items-center justify-between">
      <h2 class="font-bold text-lg">设置中心</h2>
      <button @click="showSettings=false" class="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800">
        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
      </button>
    </div>

    <div class="flex border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50">
      <button @click="settingsTab='basic'" class="px-4 py-3 font-medium text-sm border-b-2 transition-all flex-1" :class="settingsTab==='basic'?'border-primary-500 text-primary-600 dark:text-primary-400 bg-white dark:bg-gray-900':'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400'">基础</button>
      <button @click="settingsTab='layout'" class="px-4 py-3 font-medium text-sm border-b-2 transition-all flex-1" :class="settingsTab==='layout'?'border-primary-500 text-primary-600 dark:text-primary-400 bg-white dark:bg-gray-900':'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400'">布局</button>
      <button @click="settingsTab='sources'" class="px-4 py-3 font-medium text-sm border-b-2 transition-all flex-1" :class="settingsTab==='sources'?'border-primary-500 text-primary-600 dark:text-primary-400 bg-white dark:bg-gray-900':'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400'">API源</button>
      <button @click="settingsTab='data'" class="px-4 py-3 font-medium text-sm border-b-2 transition-all flex-1" :class="settingsTab==='data'?'border-primary-500 text-primary-600 dark:text-primary-400 bg-white dark:bg-gray-900':'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400'">数据</button>
    </div>

    <div class="flex-1 overflow-y-auto p-4">
      <div x-show="settingsTab==='basic'" class="space-y-6">

        <div>
          <label class="block text-sm font-medium mb-2">API 代理地址</label>
          <input type="text" x-model="cfg.apiProxy" @change="reloadAfterProxyChange()" placeholder="留空 = 使用当前站点（同源）" class="w-full px-3 py-2 rounded-xl border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm focus:ring-primary-500 focus:border-primary-500">
          <p class="text-xs text-gray-500 mt-2">留空时请求当前站点的 /?u= 接口（适用于 Cloudflare / Vercel / node server.js）。若以纯静态方式部署（如 npx serve、GitHub Pages），此接口不存在，会返回网页导致加载失败；此时请填入一个已部署的本程序地址，例如 https://api.example.workers.dev 。</p>
        </div>

        <div>
          <label class="block text-sm font-medium mb-2">分页模式</label>
          <label class="flex items-center justify-between p-3 rounded-xl bg-gray-50 dark:bg-gray-800 cursor-pointer">
            <span class="text-sm font-medium">自动加载（无限滚动）</span>
            <input type="checkbox" :checked="cfg.loadMode==='waterfall'" @change="setLoadMode($event.target.checked?'waterfall':'page')" class="w-5 h-5 rounded text-primary-600 focus:ring-primary-500">
          </label>
          <p class="text-xs text-gray-500 mt-2">关闭时为「上下页翻页」模式，手动切换页码；开启后滚动到底部自动加载更多。</p>
        </div>

        <div>
          <label class="block text-sm font-medium mb-2">主内容瀑布流</label>
          <label class="flex items-center justify-between p-3 rounded-xl bg-gray-50 dark:bg-gray-800 cursor-pointer">
            <span class="text-sm font-medium">卡片墙瀑布流模式</span>
            <input type="checkbox" :checked="!!cfg.cardWall" @change="toggleCardWall($event.target.checked)" class="w-5 h-5 rounded text-primary-600 focus:ring-primary-500">
          </label>
          <p class="text-xs text-gray-500 mt-2">把主内容区从网格改为卡片墙瀑布流排列，保留海报宽度设定：竖屏 224px、横屏 280px。配合上面的「自动加载（无限滚动）」即为无限滚动瀑布流。</p>
        </div>

      </div>

      <div x-show="settingsTab==='layout'" class="space-y-6">
        <div>
          <label class="block text-sm font-medium mb-2">视频布局</label>
          <div class="grid grid-cols-2 gap-2">
            <button @click="setListLayout('poster')" class="p-3 rounded-xl border-2 text-sm" :class="cfg.listLayout==='poster'?'border-primary-500 bg-primary-50 dark:bg-primary-900/20':'border-gray-200 dark:border-gray-700'">竖图</button>
            <button @click="setListLayout('landscape')" class="p-3 rounded-xl border-2 text-sm" :class="cfg.listLayout==='landscape'?'border-primary-500 bg-primary-50 dark:bg-primary-900/20':'border-gray-200 dark:border-gray-700'">横图</button>
          </div>
        </div>

        <div>
          <label class="block text-sm font-medium mb-2">卡片标签字段</label>
          <p class="text-xs text-gray-500 mb-2">四角标签及标题下方两行，均从下方字段中选择（选"不显示"则隐藏）</p>
          <div class="grid grid-cols-2 gap-3">
            <div>
              <span class="text-xs text-gray-500">左上角</span>
              <select @change="setCardTag('tl', $event.target.value)" :value="activeCardTags().tl" class="w-full mt-1 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-2 py-1.5">
                <option value="">不显示</option>
                <option value="type">分类</option>
                <option value="hits">热度</option>
                <option value="lang">语言</option>
                <option value="year">年代</option>
                <option value="area">地区</option>
                <option value="actor">演员</option>
                <option value="director">导演</option>
                <option value="tag">标签</option>
                <option value="duration">时长</option>
                <option value="state">资源类别</option>
                <option value="remarks">备注</option>
                <option value="pubdate">上映日期</option>
              </select>
            </div>
            <div>
              <span class="text-xs text-gray-500">右上角</span>
              <select @change="setCardTag('tr', $event.target.value)" :value="activeCardTags().tr" class="w-full mt-1 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-2 py-1.5">
                <option value="">不显示</option>
                <option value="type">分类</option>
                <option value="hits">热度</option>
                <option value="lang">语言</option>
                <option value="year">年代</option>
                <option value="area">地区</option>
                <option value="actor">演员</option>
                <option value="director">导演</option>
                <option value="tag">标签</option>
                <option value="duration">时长</option>
                <option value="state">资源类别</option>
                <option value="remarks">备注</option>
                <option value="pubdate">上映日期</option>
              </select>
            </div>
            <div>
              <span class="text-xs text-gray-500">左下角</span>
              <select @change="setCardTag('bl', $event.target.value)" :value="activeCardTags().bl" class="w-full mt-1 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-2 py-1.5">
                <option value="">不显示</option>
                <option value="type">分类</option>
                <option value="hits">热度</option>
                <option value="lang">语言</option>
                <option value="year">年代</option>
                <option value="area">地区</option>
                <option value="actor">演员</option>
                <option value="director">导演</option>
                <option value="tag">标签</option>
                <option value="duration">时长</option>
                <option value="state">资源类别</option>
                <option value="remarks">备注</option>
                <option value="pubdate">上映日期</option>
              </select>
            </div>
            <div>
              <span class="text-xs text-gray-500">右下角</span>
              <select @change="setCardTag('br', $event.target.value)" :value="activeCardTags().br" class="w-full mt-1 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-2 py-1.5">
                <option value="">不显示</option>
                <option value="type">分类</option>
                <option value="hits">热度</option>
                <option value="lang">语言</option>
                <option value="year">年代</option>
                <option value="area">地区</option>
                <option value="actor">演员</option>
                <option value="director">导演</option>
                <option value="tag">标签</option>
                <option value="duration">时长</option>
                <option value="state">资源类别</option>
                <option value="remarks">备注</option>
                <option value="pubdate">上映日期</option>
              </select>
            </div>
          </div>
        </div>

        <div>
          <label class="block text-sm font-medium mb-2">标题下方两行</label>
          <div class="grid grid-cols-2 gap-3">
            <div>
              <span class="text-xs text-gray-500">第一行</span>
              <select @change="setCardTag('sub1', $event.target.value)" :value="activeCardTags().sub1" class="w-full mt-1 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-2 py-1.5">
                <option value="">不显示</option>
                <option value="type">分类</option>
                <option value="hits">热度</option>
                <option value="lang">语言</option>
                <option value="year">年代</option>
                <option value="area">地区</option>
                <option value="actor">演员</option>
                <option value="director">导演</option>
                <option value="tag">标签</option>
                <option value="duration">时长</option>
                <option value="state">资源类别</option>
                <option value="remarks">备注</option>
                <option value="pubdate">上映日期</option>
              </select>
            </div>
            <div>
              <span class="text-xs text-gray-500">第二行</span>
              <select @change="setCardTag('sub2', $event.target.value)" :value="activeCardTags().sub2" class="w-full mt-1 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-2 py-1.5">
                <option value="">不显示</option>
                <option value="type">分类</option>
                <option value="hits">热度</option>
                <option value="lang">语言</option>
                <option value="year">年代</option>
                <option value="area">地区</option>
                <option value="actor">演员</option>
                <option value="director">导演</option>
                <option value="tag">标签</option>
                <option value="duration">时长</option>
                <option value="state">资源类别</option>
                <option value="remarks">备注</option>
                <option value="pubdate">上映日期</option>
              </select>
            </div>
          </div>
        </div>
      </div>

      <div x-show="settingsTab==='sources'" class="space-y-6">
        <div>
          <div class="flex items-center justify-between mb-3">
            <h3 class="font-semibold">API源列表（单选）</h3>
            <div class="flex gap-2">
              <button @click="exportSources()" class="text-xs px-3 py-1.5 rounded-lg bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700">导出</button>
              <button @click="$refs.importFile.click()" class="text-xs px-3 py-1.5 rounded-lg bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700">导入</button>
              <input type="file" x-ref="importFile" @change="importSources($event)" accept=".json" class="hidden">
            </div>
          </div>

          <div class="space-y-2 max-h-72 overflow-y-auto">
            <template x-for="(s,i) in sources" :key="s.id">
              <div class="flex items-center gap-2 p-2 rounded-xl bg-gray-50 dark:bg-gray-800" :class="!s.enabled?'opacity-70':''">
                <button @click="setActiveSource(i)" class="flex-shrink-0 w-10 h-6 rounded-full transition-colors relative" :class="s.enabled?'bg-green-500':'bg-gray-300 dark:bg-gray-600'">
                  <span class="absolute top-1 w-4 h-4 rounded-full bg-white shadow transition-transform" :class="s.enabled?'left-5':'left-1'"></span>
                </button>
                <div class="flex-1 min-w-0">
                  <div class="text-sm font-medium truncate" x-text="s.name"></div>
                  <div class="text-xs text-gray-500 truncate" x-text="s.url"></div>
                </div>
                <button @click="editSource(i)" class="p-1.5 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700">
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
                </button>
                <button @click="removeSource(i)" class="p-1.5 rounded-lg hover:bg-red-100 dark:hover:bg-red-900/30 text-red-500">
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
                </button>
              </div>
            </template>
          </div>

          <button @click="addSource()" class="w-full mt-3 p-3 rounded-xl border-2 border-dashed border-gray-300 dark:border-gray-600 text-sm font-medium text-gray-500 hover:border-primary-500 hover:text-primary-500 transition-colors">+ 添加API源</button>
        </div>
      </div>


      <div x-show="settingsTab==='data'" class="space-y-6">
        <div class="p-4 rounded-xl bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700">
          <div class="flex items-center justify-between mb-2">
            <label class="block text-sm font-medium flex items-center gap-2">
              <svg class="w-4 h-4 text-gray-500" fill="currentColor" viewBox="0 0 24 24"><path fill-rule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" clip-rule="evenodd"/></svg>
              GitHub Gist 同步
            </label>
            <a href="https://github.com/settings/tokens/new?scopes=gist&description=api_player%20sync" target="_blank" rel="noopener" class="text-xs text-primary-600 dark:text-primary-400 hover:underline">创建 Token</a>
          </div>
          <p class="text-xs text-gray-500 mb-3">把设置、API源、收藏、历史、搜索记录同步到私有 Gist，换设备也能恢复。</p>
          <div class="space-y-3">
            <div>
              <label class="block text-xs text-gray-500 mb-1">Personal Access Token（需 gist 权限）</label>
              <div class="relative">
                <input :type="gistShowToken ? 'text' : 'password'" x-model="gistCfg.token" @change="saveGistCfg()" placeholder="ghp_... 或 github_pat_..." class="w-full p-2.5 pr-16 rounded-xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 focus:ring-2 focus:ring-primary-500 text-sm outline-none">
                <button @click="gistShowToken=!gistShowToken" class="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-gray-500 hover:text-primary-500 px-2" x-text="gistShowToken?'隐藏':'显示'"></button>
              </div>
            </div>
            <div>
              <label class="block text-xs text-gray-500 mb-1">Gist ID（留空则首次上传时自动创建）</label>
              <input type="text" x-model="gistCfg.gistId" @change="saveGistCfg()" placeholder="例如 0d9f3a1b2c4e..." class="w-full p-2.5 rounded-xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 focus:ring-2 focus:ring-primary-500 text-sm outline-none">
            </div>
            <label class="flex items-center justify-between gap-3 p-2.5 rounded-xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 cursor-pointer">
              <span class="text-xs text-gray-600 dark:text-gray-300">自动同步（打开页面拉取，每 2 分钟推送变更）</span>
              <input type="checkbox" :checked="gistCfg.autoSync" @change="toggleGistAutoSync($event.target.checked)" class="w-4 h-4 rounded text-primary-600">
            </label>
            <div class="flex gap-2">
              <button @click="uploadGist()" :disabled="gistBusy" class="flex-1 p-2.5 rounded-xl bg-gradient-to-r from-primary-600 to-primary-500 text-white text-sm font-medium hover:shadow-lg transition-shadow disabled:opacity-50">上传到 Gist</button>
              <button @click="downloadGist()" :disabled="gistBusy" class="flex-1 p-2.5 rounded-xl bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-sm font-medium transition-colors disabled:opacity-50">从 Gist 下载</button>
            </div>
            <p class="text-xs min-h-4" :class="gistMsg.indexOf('失败')>=0 ? 'text-red-500' : 'text-gray-500'" x-text="gistMsg"></p>
            <p class="text-xs text-gray-400" x-show="gistCfg.syncedAt" x-text="syncTimeText(gistCfg.syncedAt)"></p>
            <p class="text-xs text-gray-400">Token 仅保存在本浏览器；建议使用仅勾选 gist 权限的独立 Token。下载会覆盖本地全部数据。</p>
          </div>
        </div>

        <div>
          <label class="block text-sm font-medium mb-2">全局数据</label>
          <p class="text-xs text-gray-500 mb-2">导出包含所有设置、API源、收藏、历史、搜索记录；导入将覆盖当前全部本地数据。</p>
          <div class="flex gap-2">
            <button @click="exportAllData()" class="flex-1 p-3 rounded-xl bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-sm font-medium transition-colors">导出全部</button>
            <button @click="$refs.importAllFile.click()" class="flex-1 p-3 rounded-xl bg-gradient-to-r from-primary-600 to-primary-500 text-white text-sm font-medium hover:shadow-lg transition-shadow">导入全部</button>
            <input type="file" x-ref="importAllFile" @change="importAllData($event)" accept=".json" class="hidden">
          </div>
        </div>

        <div>
          <label class="block text-sm font-medium mb-2">API源</label>
          <div class="flex gap-2">
            <button @click="exportSources()" class="flex-1 p-3 rounded-xl bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-sm font-medium transition-colors">导出源</button>
            <button @click="$refs.importFile.click()" class="flex-1 p-3 rounded-xl bg-gradient-to-r from-primary-600 to-primary-500 text-white text-sm font-medium hover:shadow-lg transition-shadow">导入源</button>
            <input type="file" x-ref="importFile" @change="importSources($event)" accept=".json" class="hidden">
          </div>
        </div>

        <div class="p-4 rounded-xl bg-gradient-to-r from-yellow-50 to-amber-50 dark:from-yellow-900/20 dark:to-amber-900/20 border border-yellow-200 dark:border-yellow-800">
          <div class="flex items-start gap-3">
            <svg class="w-5 h-5 text-yellow-600 flex-shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clip-rule="evenodd"/></svg>
            <div class="flex-1">
              <p class="text-sm font-medium text-yellow-900 dark:text-yellow-200 mb-1">关于数据存储</p>
              <p class="text-xs text-yellow-800 dark:text-yellow-300">默认所有数据仅保存在浏览器本地存储（LocalStorage）；只有你主动配置 GitHub Gist 同步后，数据才会上传到自己的私有 Gist。清除浏览器数据前请先导出或同步。</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
</div>
<div x-show="showSourceEdit" x-transition class="fixed inset-0 bg-black/50 backdrop-blur-sm z-[60] flex items-center justify-center p-4" @click.self="showSourceEdit=false">
  <div class="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-md p-6" @click.stop>
    <h3 class="font-bold text-lg mb-4" x-text="editingIdx===null?'添加API源':'编辑API源'"></h3>
    <div class="space-y-4">
      <div>
        <label class="block text-sm font-medium mb-1">源名称</label>
        <input type="text" x-model="editingSource.name" placeholder="苹果CMS源" class="w-full p-3 rounded-xl bg-gray-50 dark:bg-gray-800 border-0 focus:ring-2 focus:ring-primary-500 text-sm outline-none">
      </div>
      <div>
        <label class="block text-sm font-medium mb-1">API地址</label>
        <input type="text" x-model="editingSource.url" placeholder="https://example.com/api.php/provide/vod/" class="w-full p-3 rounded-xl bg-gray-50 dark:bg-gray-800 border-0 focus:ring-2 focus:ring-primary-500 text-sm outline-none">
        <p class="text-xs text-gray-500 mt-1">苹果CMS填到 /api.php/provide/vod/ 这一层</p>
      </div>
      <div class="pt-2 border-t border-gray-200 dark:border-gray-700 space-y-3">
        <div>
          <p class="text-xs font-medium text-gray-500 mb-2">本源跳过片头片尾（优先于全局设置）</p>
          <div class="flex items-center gap-4 mb-2">
            <label class="flex items-center gap-1.5 text-sm cursor-pointer">
              <input type="checkbox" x-model="editingSource.skipIntro" class="w-4 h-4 rounded text-primary-600"> 跳过片头
            </label>
            <div class="flex items-center gap-1">
              <input type="number" min="0" x-model.number="editingSource.introTime" class="w-14 px-2 py-1 rounded bg-gray-100 dark:bg-gray-700 text-xs text-center">
              <span class="text-xs text-gray-500">秒</span>
            </div>
          </div>
          <div class="flex items-center gap-4 mb-3">
            <label class="flex items-center gap-1.5 text-sm cursor-pointer">
              <input type="checkbox" x-model="editingSource.skipOutro" class="w-4 h-4 rounded text-primary-600"> 跳过片尾
            </label>
            <div class="flex items-center gap-1">
              <input type="number" min="0" x-model.number="editingSource.outroTime" class="w-14 px-2 py-1 rounded bg-gray-100 dark:bg-gray-700 text-xs text-center">
              <span class="text-xs text-gray-500">秒(倒计时)</span>
            </div>
          </div>
        </div>
        <div>
          <div x-show="editingIdx !== null">
            <div class="flex items-center justify-between mb-2">
              <p class="text-xs font-medium text-gray-500">本源分类黑名单</p>
              <button @click="showSourceBlacklistPicker=!showSourceBlacklistPicker" type="button" class="text-xs px-3 py-1 rounded-lg bg-primary-100 dark:bg-primary-900/30 text-primary-600 hover:bg-primary-200 dark:hover:bg-primary-900/50 transition-colors" x-text="showSourceBlacklistPicker ? '完成' : '可视化选择'"></button>
            </div>
            <p class="text-xs text-gray-400 mb-2">勾选后该分类在本源下隐藏。</p>
            <div x-show="showSourceBlacklistPicker" x-transition class="p-3 rounded-xl bg-gray-50 dark:bg-gray-800 max-h-48 overflow-y-auto">
              <div class="flex flex-wrap gap-2" x-show="allClassesList.length">
                <template x-for="c in allClassesList" :key="c.type_id">
                  <button @click="toggleSourceBlacklist(c)" type="button" class="px-3 py-1.5 rounded-lg text-xs font-medium transition-all" :class="isSourceBlacklisted(c)?'bg-red-500 text-white':'bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-300 dark:hover:bg-gray-600'" x-text="c.type_name"></button>
                </template>
              </div>
              <p x-show="!allClassesList.length" class="text-xs text-gray-400">该源分类尚未加载，请保存源后返回刷新分类。</p>
            </div>
          </div>
          <p x-show="editingIdx === null" class="text-xs text-gray-400">添加并保存源后，再次编辑此源可在此可视化选择分类黑名单。</p>
        </div>
        <div class="flex gap-3 mt-6">
          <button @click="showSourceEdit=false" class="flex-1 p-3 rounded-xl bg-gray-100 dark:bg-gray-800 font-medium">取消</button>
          <button @click="saveSource()" class="flex-1 p-3 rounded-xl bg-gradient-to-r from-primary-600 to-primary-500 text-white font-medium">保存</button>
        </div>
      </div>
    </div>
  </div>
</div>

<div x-show="showPlayer" x-transition class="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center" @click.self="closePlayer()">
  <div class="bg-white dark:bg-gray-900 w-full max-w-8xl overflow-hidden h-screen flex flex-col sm:flex-row relative" @click.stop>
    <div class="flex-1 flex flex-col min-w-0 relative">
      <div class="p-3 border-b border-gray-200 dark:border-gray-800 flex items-center gap-2 sm:hidden">
        <h3 class="font-bold text-sm truncate" x-text="playerTitle"></h3>
        <button @click="closePlayer()" class="ml-auto p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
        </button>
      </div>

      <div class="aspect-video bg-black relative h-full" id="playerBox" @mouseenter="playerHover=true"></div>

      <button @click="togglePlayerSidebar()"
        class="hidden sm:block absolute top-1/2 -translate-y-1/2 z-10 w-6 h-16 items-center justify-center transition-all opacity-0 hover:opacity-100"
        :class="playerHover?'opacity-100':'opacity-0'"
        style="right: 0;background:rgba(0,0,0,0.5)">
        <div class="w-full h-full flex items-center justify-center rounded-l-lg">
          <svg x-show="showPlayerSidebar" class="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>
          <svg x-show="!showPlayerSidebar" class="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/></svg>
        </div>
      </button>

      <div class="sm:hidden border-t border-gray-200 dark:border-gray-800 p-3 bg-gray-50 dark:bg-gray-800/50">
        <div class="flex gap-1.5 mb-2 overflow-x-auto scrollbar-hide pb-1">
          <template x-for="(g,i) in playGroups" :key="i">
            <button @click="selectPlaySource(i)" class="px-3 py-1 rounded-full text-xs font-medium whitespace-nowrap transition-all flex-shrink-0"
              :class="i===playSrc?'bg-primary-600 text-white':'bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-200'"
              x-text="g.sn"></button>
          </template>
        </div>
        <div class="flex gap-1.5 overflow-x-auto scrollbar-hide">
          <template x-for="(ep,i) in sortedEps()" :key="ep.n+i">
            <button @click="playEpisode(ep)" class="px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-all flex-shrink-0"
              :class="currentEps()[playEp]===ep?'bg-gradient-to-r from-primary-600 to-primary-500 text-white':'bg-white dark:bg-gray-700 hover:bg-gray-100 dark:hover:bg-gray-600'"
              x-text="ep.n"></button>
          </template>
        </div>
      </div>
    </div>

    <div x-show="showPlayerSidebar" class="hidden sm:flex w-72 lg:w-80 flex-col h-full min-h-0 border-l border-gray-200 dark:border-gray-800">
      <div class="p-4 border-b border-gray-200 dark:border-gray-800">
        <div class="flex items-start justify-between gap-2 mb-3">
          <h3 class="font-bold text-base leading-tight line-clamp-2 flex-1" x-text="playerTitle"></h3>
          <button @click="closePlayer()" class="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 flex-shrink-0">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
          </button>
        </div>

        <div class="flex gap-1.5 mb-3 flex-wrap">
          <template x-for="(g,i) in playGroups" :key="i">
            <button @click="selectPlaySource(i)" class="px-3 py-1 rounded-full text-xs font-medium whitespace-nowrap transition-all"
              :class="i===playSrc?'bg-primary-600 text-white':'bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700'"
              x-text="g.sn"></button>
          </template>
        </div>

        <div class="flex items-center gap-1.5">
          <button @click="prevEp()" class="flex-1 py-1.5 rounded-lg bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-sm font-medium transition-colors">上一集</button>
          <button @click="nextEp()" class="flex-1 py-1.5 rounded-lg bg-gradient-to-r from-primary-600 to-primary-500 text-white text-sm font-medium hover:shadow-lg transition-shadow">下一集</button>
        </div>
      </div>

      <div class="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
        <div class="flex items-center gap-2">
          <span class="text-xs text-gray-500">排序:</span>
          <button @click="toggleEpSort()" class="px-2 py-1 rounded text-xs font-medium transition-colors"
            :class="epSortAsc?'bg-primary-100 dark:bg-primary-900/30 text-primary-600':'bg-gray-100 dark:bg-gray-800 text-gray-600'">
            <span x-text="epSortAsc?'正序 ↓':'倒序 ↑'"></span>
          </button>
          <span class="text-xs text-gray-400 ml-auto" x-text="'共'+currentEps().length+'集'"></span>
        </div>

        <div class="grid grid-cols-4 gap-1.5">
          <template x-for="(ep,i) in sortedEps()" :key="ep.n+i">
            <button @click="playEpisode(ep)" class="py-1.5 rounded text-xs font-medium transition-all truncate"
              :class="currentEps()[playEp]===ep?'bg-gradient-to-r from-primary-600 to-primary-500 text-white':'bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300'"
              x-text="episodeLabel(ep)"></button>
          </template>
        </div>
      </div>
      <div class="border-t border-gray-200 dark:border-gray-700 pt-3 space-y-2">
          <div class="flex gap-2">
            <button @click="favCurrentItem()" class="flex-1 flex items-center justify-center gap-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors"
              :class="isFavCurrent()?'bg-red-50 dark:bg-red-900/20 text-red-500':'bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700'" title="收藏">
              <svg class="w-4 h-4" :class="isFavCurrent()?'fill-red-500':''" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z"/></svg>
            </button>
            <button @click="downloadCurrent()" class="flex-1 flex items-center justify-center gap-1 px-3 py-2 rounded-lg text-sm font-medium bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors" title="下载">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
            </button>
            <button @click="shareCurrent()" class="flex-1 flex items-center justify-center gap-1 px-3 py-2 rounded-lg text-sm font-medium bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors" title="分享">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z"/></svg>
            </button>
            <button @click="showPlayerSettings=!showPlayerSettings" class="flex-1 flex items-center justify-center gap-1 px-3 py-2 rounded-lg text-sm font-medium bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors" title="设置">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
            </button>
          </div>
    
      </div>
    </div>

    <div x-show="showPlayerSettings " x-transition class="absolute right-2 sm:right-4 top-16 w-72 bg-white dark:bg-gray-800 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700 p-4 z-20 space-y-3 max-h-[70vh] overflow-y-auto">
      <div class="flex items-center justify-between">
        <h4 class="font-semibold text-sm">播放器设置</h4>
        <button @click="showPlayerSettings=false" class="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
        </button>
      </div>
      <div class="space-y-3">
        <div>
          <label class="block text-sm font-medium mb-2">播放器内核</label>
          <div class="grid grid-cols-2 gap-2">
            <button @click="setPlayerType('native')" class="p-2 rounded-xl border-2 text-xs" :class="cfg.playerType==='native'?'border-primary-500 bg-primary-50 dark:bg-primary-900/20':'border-gray-200 dark:border-gray-700'">原生</button>
            <button @click="setPlayerType('art')" class="p-2 rounded-xl border-2 text-xs" :class="cfg.playerType==='art'?'border-primary-500 bg-primary-50 dark:bg-primary-900/20':'border-gray-200 dark:border-gray-700'">ArtPlayer</button>
          </div>
        </div>

        <label class="flex items-center justify-between text-sm cursor-pointer">
          <span>记忆倍速</span>
          <input type="checkbox" x-model="cfg.rememberSpeed" @change="saveCfg()" class="w-4 h-4 rounded text-primary-600">
        </label>

        <div class="border-t border-gray-200 dark:border-gray-700 pt-3 space-y-2">
          <label class="flex items-center justify-between text-sm cursor-pointer">
            <span>进度跳过(片头)</span>
          <input type="checkbox" x-model="cfg.skipIntro" @change="saveCfg()" class="w-4 h-4 rounded text-primary-600">
        </label>
        <div x-show="cfg.skipIntro" class="flex items-center gap-2 pl-4">
          <input type="number" min="0" x-model.number="cfg.introTime" @change="saveCfg()" class="w-16 px-2 py-1 rounded bg-gray-100 dark:bg-gray-700 text-xs text-center">
          <span class="text-xs text-gray-500">秒</span>
          <button @click="setIntroTimeFromPlayer()" class="px-2 py-1 rounded bg-primary-100 dark:bg-primary-900/30 text-primary-600 text-xs font-medium">获取当前</button>
        </div>
      </div>
      <div class="space-y-2">
        <label class="flex items-center justify-between text-sm cursor-pointer">
          <span>进度跳过(片尾)</span>
          <input type="checkbox" x-model="cfg.skipOutro" @change="saveCfg()" class="w-4 h-4 rounded text-primary-600">
        </label>
        <div x-show="cfg.skipOutro" class="flex items-center gap-2 pl-4">
          <input type="number" min="0" x-model.number="cfg.outroTime" @change="saveCfg()" class="w-16 px-2 py-1 rounded bg-gray-100 dark:bg-gray-700 text-xs text-center">
          <span class="text-xs text-gray-500">秒</span>
          <button @click="setOutroTimeFromPlayer()" class="px-2 py-1 rounded bg-primary-100 dark:bg-primary-900/30 text-primary-600 text-xs font-medium">获取当前</button>
        </div>
      </div>
      <div class="space-y-2">
        <label class="flex items-center justify-between text-sm cursor-pointer">
          <span>自动连播</span>
          <input type="checkbox" x-model="cfg.autoNext" @change="saveCfg()" class="w-4 h-4 rounded text-primary-600">
        </label>
      </div>
      <div class="space-y-2" x-show="sniffedUrl">
        <div class="text-xs text-gray-500 bg-gray-50 dark:bg-gray-700 rounded p-2 break-all">
          <span class="font-medium">嗅探结果:</span> <span x-text="sniffedUrlType"></span><br>
          <span class="font-medium">地址:</span> <span class="text-primary-600 dark:text-primary-400" x-text="sniffedUrl"></span>
        </div>
        <button @click="playSniffedUrl()" class="w-full py-2 px-3 rounded-lg text-sm font-medium bg-green-100 dark:bg-green-900/30 text-green-600 hover:bg-green-200 dark:hover:bg-green-900/50 transition-colors">
          播放嗅探地址
        </button>
      </div>

    </div>
  </div>
</div>

<script>
const GIST_FILENAME = 'api-player-sync.json';
function app() {// 应用函数
    return {
        placeholderImg: 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMzAwIiBoZWlnaHQ9IjQ1MCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMzAwIiBoZWlnaHQ9IjQ1MCIgZmlsbD0iI2U1ZTdlYiIvPjwvc3ZnPg==',
        sources: JSON.parse(localStorage.getItem('cms_src') || '[]'),
        cfg: JSON.parse(localStorage.getItem('cms_cfg') ||
            '{"theme":"auto","autoNext":true,"rememberSpeed":true,"playerType":"native","loadMode":"page","hiddenTypes":"","autoLoadMore":true,"skipIntro":false,"skipOutro":false,"introTime":0,"outroTime":0,"listLayout":"poster","cardWall":false,"cardTags":{"tl":"area","tr":"","bl":"","br":"hits","sub1":"type","sub2":"year"}}'
        ),
        currentUrlType: 'unknown',
        sniffedUrl: null,
        sniffedUrlType: '',
        fav: JSON.parse(localStorage.getItem('cms_fav') || '[]'),
        his: JSON.parse(localStorage.getItem('cms_his') || '[]'),
        searchHistory: JSON.parse(localStorage.getItem('cms_search_hist') || '[]'),
        classes: [],
        allClassesList: [],
        visibleClasses: [],
        hiddenClasses: [],
        videos: [],
        page: 1,
        totalPages: 1,
        currentType: '0',
        searchWd: '',
        showFav: false,
        showHist: false,
        showSettings: false,
        showSourceEdit: false,
        showPlayer: false,
        showMoreTypes: false,
        showSearchHist: false,
        mobileSearchOpen: false,
        showSourceBlacklistPicker: false,
        settingsTab: 'basic',
        editingIdx: null,
        editingSource: {
            name: '',
            url: ''
        },
        playGroups: [],
        playSrc: 0,
        playEp: 0,
        playSpeed: '1',
        playerTitle: '',
        currentItem: null,
        isWebPlayer: false,
        showPlayerSettings: false,
        showEpSort: false,
        epSortAsc: true,
        playerHover: false,
        showPlayerSidebar: true,
        loading: false,
        _art: null,
        _hls: null,
        _observer: null,
        _playToken: 0,
        _sniffController: null,
        _progressRAF: null,
        _imgRatios: {},
        _wallRetry: 0,
        _wallRO: null,
        _wallRaf: 0,
        _wallLayoutSeq: 0,
        _wallLastHeights: null,
        gistCfg: (() => { try { return Object.assign({ token: '', gistId: '', autoSync: false, syncedAt: '' }, JSON.parse(localStorage.getItem('cms_gist') || '{}')); } catch (e) { return { token: '', gistId: '', autoSync: false, syncedAt: '' }; } })(),
        gistBusy: false,
        gistMsg: '',
        gistShowToken: false,
        directMode: false,
        apiError: '',
        _gistLastPayload: '',
        _gistTimer: null,
        init() {// 初始化
            // 浏览器扩展没有同源服务端，改用直连模式（扩展 host_permissions 允许跨域请求）
            this.directMode = this.isExtensionContext();
            // 合并默认 cfg，兼容旧版本 localStorage 缺失字段
            const def = JSON.parse('{"theme":"auto","autoNext":true,"rememberSpeed":true,"playerType":"native","loadMode":"page","hiddenTypes":"","autoLoadMore":true,"skipIntro":false,"skipOutro":false,"introTime":0,"outroTime":0,"listLayout":"poster","cardWall":false,"apiProxy":"","cardTags":{"tl":"area","tr":"","bl":"","br":"hits","sub1":"type","sub2":"year"}}');
            this.cfg = Object.assign({}, def, this.cfg);
            this.cfg.cardTags = Object.assign({}, def.cardTags, this.cfg.cardTags || {});
            // 旧版本配置迁移：无限滚动开关是分页模式的唯一来源，cardWall 默认关闭
            this.cfg.autoLoadMore = this.cfg.loadMode === 'waterfall';
            this.applyTheme();
            this.normalizeSourceEnabled();
            const willSync = !!(this.gistCfg.autoSync && this.gistCfg.gistId && this.gistCfg.token);
            if (this.sources.length) {
                const src = this.getActiveSource();
                if (src && src.name) document.title = src.name;
                if (!willSync) this.loadClasses().then(() => this.loadData());
            }
            try {
                window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
                    if (this.cfg.theme === 'auto') this.applyTheme();
                });
            } catch (e) {}
            window.addEventListener('resize', () => {
                this.calcClasses();
                this._scheduleWallRelayout();
            });
            if (this.cfg.cardWall) this._ensureWallRO();
            this.setupAutoLoad();
            this.setupGistAutoSync();
            if (willSync) this.downloadGist(true);
          },
          setupAutoLoad() {// 设置自动加载
            const sentinel = document.getElementById('loadSentinel');
            if (!sentinel) return;
            if (this._observer) this._observer.disconnect();
            this._observer = new IntersectionObserver((entries) => {
                if (entries[0].isIntersecting && this.cfg.loadMode === 'waterfall' && this.page < this.totalPages && !this.loading) {
                    this.loadMore();
                }
            }, { rootMargin: '200px' });
            this._observer.observe(sentinel);
        },
        get activeSourceName() {// 当前 API 源名称（供顶栏显示）
            const s = this.getActiveSource();
            return s && s.name ? s.name : '';
        },
        setLoadMode(mode) {// 分页模式：page=上下页翻页，waterfall=无限滚动
            const next = mode === 'waterfall' ? 'waterfall' : 'page';
            const changed = this.cfg.loadMode !== next;
            this.cfg.loadMode = next;
            this.cfg.autoLoadMore = next === 'waterfall';
            this.saveCfg();
            this.setupAutoLoad();
            if (changed) { this.page = 1; this.loadData(); }
        },
        toggleCardWall(on) {// 主内容卡片墙瀑布流
            this.cfg.cardWall = !!on;
            this.saveCfg();
            this.$nextTick(() => {
                if (!this.cfg.cardWall) {
                    if (this._wallRO) { this._wallRO.disconnect(); this._wallRO = null; }
                    this.clearWallStyle(document.getElementById('mainWall'));
                } else {
                    this._ensureWallRO();
                }
                this.relayoutMainWall();
            });
            setTimeout(() => this.relayoutMainWall(), 60);
        },
        mainWallClass() {
            if (this.cfg.cardWall) return 'ts-wall';
            return this.cfg.listLayout === 'landscape' ? 'ts-grid-land' : 'ts-grid-poster';
        },
        relayoutMainWall() {
            if (!this.cfg.cardWall) return;
            const wrap = document.getElementById('mainWall');
            if (!wrap) return;
            this.renderWall(wrap, this.cfg.listLayout === 'landscape' ? 280 : 224);
        },
        renderWall(wrap, minColWidth) {
            if (!wrap) return;
            const gap = 12;
            const containerWidth = wrap.clientWidth || (wrap.parentElement ? wrap.parentElement.clientWidth : 0);
            if (containerWidth <= 0) {
                if (this._wallRetry < 10) {
                    this._wallRetry++;
                    if (this._wallTimer) clearTimeout(this._wallTimer);
                    this._wallTimer = setTimeout(() => this._scheduleWallRelayout(), 80);
                }
                return;
            }
            this._wallRetry = 0;
            const colCount = Math.max(1, Math.floor(containerWidth / minColWidth));
            const colItemWidth = containerWidth / colCount - gap;
            const nodes = Array.from(wrap.children).filter(n => n.classList && n.classList.contains('ts-wf-item'));
            nodes.forEach(item => {
                item.style.width = colItemWidth + 'px';
                this._watchWallImages(item);
                if (this._wallRO && !item.__wallObserved) { this._wallRO.observe(item); item.__wallObserved = true; }
            });
            // 先写完宽度与图片比例，再一次性读高度，避免反复强制布局
            const heights = nodes.map(n => n.offsetHeight || 0);
            const colHeights = new Array(colCount).fill(0);
            nodes.forEach((item, i) => {
                const minHeight = Math.min.apply(null, colHeights);
                const targetCol = colHeights.indexOf(minHeight);
                item.style.left = (targetCol * (colItemWidth + gap)) + 'px';
                item.style.top = colHeights[targetCol] + 'px';
                colHeights[targetCol] += heights[i] + gap;
            });
            wrap.style.height = Math.max.apply(null, colHeights) + 'px';
            // 记录本次布局依据的高度：ResizeObserver 据此区分真实变化与自身重排引起的回调，避免自激循环
            this._wallLastHeights = heights.slice();
            // 缩放或图片异步解码后，高度可能晚于本次读取才稳定，下一帧再校验一次
            const seq = ++this._wallLayoutSeq;
            requestAnimationFrame(() => {
                if (seq !== this._wallLayoutSeq || !this.cfg.cardWall) return;
                const cur = nodes.map(n => n.offsetHeight || 0);
                if (cur.some((h, i) => Math.abs(h - heights[i]) > 1)) this._scheduleWallRelayout();
            });
        },
        _scheduleWallRelayout() {
            if (this._wallRaf) cancelAnimationFrame(this._wallRaf);
            this._wallRaf = requestAnimationFrame(() => {
                this._wallRaf = 0;
                this.relayoutMainWall();
            });
        },
        _ensureWallRO() {
            if (this._wallRO || typeof ResizeObserver === 'undefined') return;
            const wrap = document.getElementById('mainWall');
            if (!wrap) return;
            this._wallRO = new ResizeObserver(() => {
                if (!this.cfg.cardWall || !this._wallLastHeights) return;
                const nodes = Array.from(wrap.children).filter(n => n.classList && n.classList.contains('ts-wf-item'));
                if (nodes.some((n, i) => Math.abs((n.offsetHeight || 0) - (this._wallLastHeights[i] || 0)) > 1)) this._scheduleWallRelayout();
            });
            Array.from(wrap.children).forEach(n => {
                if (n.classList && n.classList.contains('ts-wf-item')) this._wallRO.observe(n);
            });
        },
        _watchWallImages(item) {
            const img = item.querySelector ? item.querySelector('img') : null;
            if (!img) return;
            const media = img.parentElement;
            const apply = () => {
                const url = img.currentSrc || img.src || '';
                let ratio = url ? this._imgRatios[url] : 0;
                if (!ratio && img.complete && img.naturalWidth > 0) {
                    ratio = img.naturalHeight / img.naturalWidth;
                    if (ratio > 0 && url) this._imgRatios[url] = ratio;
                }
                if (ratio > 0 && media) media.style.aspectRatio = '1 / ' + ratio;
            };
            apply();
            if (img.__wallBound) return;
            img.__wallBound = true;
            // 不能只在 !img.complete 时监听：缓存命中 / 解码延迟的 complete 状态会漏掉后续 load，导致比例定了却不重排
            const onReady = () => {
                img.removeEventListener('load', onReady);
                img.removeEventListener('error', onReady);
                apply();
                this._scheduleWallRelayout();
            };
            img.addEventListener('load', onReady);
            img.addEventListener('error', onReady);
        },
        clearWallStyle(wrap) {
            if (!wrap) return;
            wrap.style.height = '';
            Array.from(wrap.children).forEach(n => {
                if (n.classList && n.classList.contains('ts-wf-item')) {
                    n.style.width = ''; n.style.left = ''; n.style.top = '';
                    const media = n.querySelector ? n.querySelector('.card-media') : null;
                    if (media) media.style.aspectRatio = '';
                }
            });
        },
        openMobileSearch() {
            this.mobileSearchOpen = !this.mobileSearchOpen;
            if (this.mobileSearchOpen) {
                this.$nextTick(() => { const el = this.$refs.mobileSearchInput; if (el) el.focus(); });
            } else {
                this.showSearchHist = false;
            }
        },
        // CSP 兼容辅助方法：把 HTML 属性里不被 CSP 解析器支持的表达式移到这里
        bodyOverlayClass() {
            return {
                'overflow-hidden': this.showPlayer || this.showSettings || this.showFav || this.showHist
            };
        },
        favButtonClass() {
            return this.showFav ? 'bg-primary-100 dark:bg-primary-900/30 text-primary-600' : '';
        },
        histButtonClass() {
            return this.showHist ? 'bg-primary-100 dark:bg-primary-900/30 text-primary-600' : '';
        },
        toggleFavPanel() {
            this.showFav = !this.showFav;
            this.showHist = false;
            this.showSettings = false;
        },
        toggleHistPanel() {
            this.showHist = !this.showHist;
            this.showFav = false;
            this.showSettings = false;
        },
        toggleSettingsPanel() {
            this.showSettings = !this.showSettings;
            this.showFav = false;
            this.showHist = false;
        },
        closeFavPanel() {
            this.showFav = false;
        },
        openFavItem(item) {
            this.openPlayer(item);
            this.closeFavPanel();
        },
        episodeLabel(ep) {
            return String((ep && ep.n) || '').replace(/第|集/g, '');
        },
        selectSearchHistory(term) {
            this.searchWd = term;
            this.doSearch();
        },
        doMobileSearch() {
            this.doSearch();
            this.mobileSearchOpen = false;
        },
        selectMobileSearchHistory(term) {
            this.searchWd = term;
            this.doSearch();
            this.mobileSearchOpen = false;
        },
        selectAllTypes() {
            this.selectType('0');
        },
        openSettingsSources() {
            this.showSettings = true;
            this.settingsTab = 'sources';
        },
        prevPage() {
            if (this.page > 1) { this.page--; this.loadData(); }
        },
        goPage(p) {
            this.page = p;
            this.loadData();
        },
        nextPage() {
            if (this.page < this.totalPages) { this.page++; this.loadData(); }
        },
        openHistItem(item) {
            this.openPlayer(item);
            this.showHist = false;
        },
        removeSource(i) {
            this.sources.splice(i, 1);
            this.normalizeSourceEnabled();
            this.saveSources();
            this.page = 1;
            this.loadClasses();
            this.loadData();
        },
        togglePlayerSidebar() {
            this.showPlayerSidebar = !this.showPlayerSidebar;
            this.playerHover = false;
        },
        selectPlaySource(i) {
            this.playSrc = i;
            this.playEp = 0;
            this.renderPlayer();
        },
        playEpisode(ep) {
            this.playEp = this.currentEps().indexOf(ep);
            this.renderPlayer();
        },
        setIntroTimeFromPlayer() {
            this.cfg.introTime = this.getPlayerTime();
            this.saveCfg();
        },
        setOutroTimeFromPlayer() {
            this.cfg.outroTime = this.getRemainingTime();
            this.saveCfg();
        },
        hideSearchHistLater() {
            const self = this;
            setTimeout(function () { self.showSearchHist = false; }, 200);
        },
        selectType(id) {
            this.currentType = String(id);
            this.page = 1;
            this.loadData();
        },
        selectTypeCloseMore(id) {
            this.selectType(id);
            this.showMoreTypes = false;
        },
        typeKey(id) { return String(id); },
        typeIsActive(id) { return this.currentType === String(id); },
        syncTimeText(v) {
            return '上次同步：' + String(v || '').replace('T', ' ').slice(0, 19);
        },
        toggleMoreTypes(ev) {
            this.showMoreTypes = !this.showMoreTypes;
            if (this.showMoreTypes && ev && ev.target && ev.target.closest) {
                var box = ev.target.closest('.relative');
                var el = box && box.querySelector('div');
                if (el && el.focus) el.focus();
            }
        },
        setListLayout(mode) {
            this.cfg.listLayout = mode;
            this.saveCfg();
            var self = this;
            this.$nextTick(function () { self.relayoutMainWall(); });
        },
        favCurrentItem() {
            if (this.currentItem) this.toggleFav(this.currentItem);
        },
        isFavCurrent() {
            return !!(this.currentItem && this.isFav(this.currentItem.vod_id));
        },
        reloadAfterProxyChange() {
            this.saveCfg();
            this.apiError = '';
            this.loadClasses().then(() => this.loadData());
        },
        setPlayerType(mode) {
            this.cfg.playerType = mode;
            this.saveCfg();
            if (this.showPlayer) this.renderPlayer();
        },
        toggleThemeMode() {// 切换主题模式
            if (this.cfg.theme === 'auto') this.cfg.theme = 'light';
            else if (this.cfg.theme === 'light') this.cfg.theme = 'dark';
            else this.cfg.theme = 'auto';
            this.saveCfg();
        },
        applyTheme() {// 应用主题
            const dark = this.cfg.theme === 'dark' || (this.cfg.theme === 'auto' && matchMedia(
                '(prefers-color-scheme:dark)').matches);
            document.documentElement.classList.toggle('dark', dark);
        },
        saveCfg() {// 保存配置
            this.cfg.autoLoadMore = this.cfg.loadMode === 'waterfall';
            localStorage.setItem('cms_cfg', JSON.stringify(this.cfg));
            this.applyTheme()
        },
        saveSources() {// 保存源
            localStorage.setItem('cms_src', JSON.stringify(this.sources));
        },
        normalizeSourceEnabled() {// 归一化源启用状态
            if (!Array.isArray(this.sources)) this.sources = [];
            let enabledIndex = this.sources.findIndex(s => s.enabled);
            if (enabledIndex === -1 && this.sources.length) enabledIndex = 0;
            this.sources = this.sources.map((s, i) => ({
                ...s,
                enabled: i === enabledIndex
            }));
            this.saveSources()
        },
        setActiveSource(i) {// 设置当前启用的源
            this.sources = this.sources.map((s, idx) => ({
                ...s,
                enabled: idx === i
            }));
            this.saveSources();
            const src = this.getActiveSource();
            if (src && src.name) document.title = src.name;
            this.page = 1;
            this.currentType = '0';
            this.searchWd = '';
            this.mobileSearchOpen = false;
            this.loadClasses().then(() => this.loadData());
        },
        getActiveSource() {// 获取当前启用的源
            return this.sources.find(s => s.enabled)
        },
        makeApiUrl(base, params) {// 生成API URL
            const url = new URL(base);
            Object.entries(params).forEach(e => url.searchParams.set(e[0], e[1]));
            return url.toString();
        },
        isExtensionContext() {// 识别扩展环境：兼容 chrome.* / browser.* 以及 extensions: 等协议
            try {
                var proto = String((location && location.protocol) || '').toLowerCase();
                if (proto.indexOf('extension') === 0) return true;
                var chromeRuntime = (typeof chrome !== 'undefined' && chrome && chrome.runtime) ? chrome.runtime : null;
                var browserRuntime = (typeof browser !== 'undefined' && browser && browser.runtime) ? browser.runtime : null;
                return !!((chromeRuntime && chromeRuntime.id) || (browserRuntime && browserRuntime.id));
            } catch (e) {
                return false;
            }
        },
        async apiFetch(api) {// 统一 API 请求：自定义代理优先 > 扩展直连 > 同源代理
            const base = String(this.cfg.apiProxy || '').trim().replace(/\\/+$/, '');
            // 扩展里如果显式配置了代理地址，尊重用户选择；否则直连 API 源。
            if (!base && this.directMode) {
                try {
                    return await fetch(api);
                } catch (e) {
                    throw new Error('扩展直连 API 失败（' + api + '）：' + (e && e.message ? e.message : e) + '。请检查 API 地址是否正确、扩展 host_permissions 是否包含该域名、以及网络是否可达。');
                }
            }
            const url = (base ? base : '') + '/?u=' + encodeURIComponent(api);
            let r;
            try {
                r = await fetch(url);
            } catch (e) {
                throw new Error('无法连接 API 代理（' + (base || '当前站点') + '）：' + (e && e.message ? e.message : e));
            }
            // 纯静态服务器（npx serve / http-server 等）没有 /?u= 路由，会回退成 index.html。
            // 不能只看 Content-Type：源站给 JSON 时也常返回 text/html，所以按正文首字符判断。
            const text = await r.text();
            if (text.replace(/^\\s+/, '').charAt(0) === '<') {
                throw new Error('API 代理未生效：返回的是网页而不是 JSON。当前站点很可能是纯静态服务器，没有 /?u= 代理接口。请改用 node server.js / npx . 启动，或在「设置 → 基础 → API 代理地址」填入已部署的 Worker 服务地址。');
            }
            // 统一规整为 JSON 响应，避免源站错误的 Content-Type 影响后续 .json()
            return new Response(text, { status: r.status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
        },
        filterClasses(classes) {
            const hidden = String(this.cfg.hiddenTypes || '').split(',').map(s => s.trim()).filter(Boolean);
            const src = this.getActiveSource();
            if (src && src.blacklist) {
                const srcBlack = String(src.blacklist).split(',').map(s => s.trim()).filter(Boolean);
                for (const b of srcBlack) if (!hidden.includes(b)) hidden.push(b);
            }
            if (!hidden.length) return classes || [];
            return (classes || []).filter(c => !hidden.includes(String(c.type_id)) && !hidden.includes(String(c.type_name)))
        },
        currentTypeName() {// 当前分类名称
            if (this.currentType === '0') return '全部';
            const c = this.classes.find(x => String(x.type_id) === String(this.currentType));
            return c ? c.type_name : '全部';
        },
        calcClasses() {// 计算分类：动态测量各按钮宽度，超出或被"更多"遮挡的移入下拉菜单
            const container = document.getElementById('typeNavContainer');
            if (!container || !this.classes.length) {
                this.visibleClasses = this.classes || [];
                this.hiddenClasses = [];
                return;
            }

            // 创建可复用的测量元素（与真实按钮样式一致）
            const m = document.createElement('button');
            m.className = 'px-4 py-1.5 rounded-full text-sm font-medium whitespace-nowrap';
            m.style.cssText = 'position:absolute;visibility:hidden;left:0;top:0;';
            document.body.appendChild(m);

            // 测量"更多"图标按钮的实际宽度（三横线图标 + padding）
            m.innerHTML = '<svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"/></svg>';
            const moreBtnWidth = m.offsetWidth;
            const moreSectionWidth = moreBtnWidth + 8; // 8 = pl-2

            // 获取 flex 行实际内容宽度（全宽容器减去左右内边距，即真实可用宽度）
            const flexRow = container.querySelector('.flex.items-center.py-2');
            if (!flexRow) {
                this.visibleClasses = this.classes;
                this.hiddenClasses = [];
                document.body.removeChild(m);
                return;
            }
            // 可用宽度 = flex 行宽度 - "更多"按钮区域 - flex 行 padding(没有) = flexRow.clientWidth
            // ul 有 flex-1，其宽度 = flexRow.clientWidth - moreSectionWidth
            const maxWidth = flexRow.clientWidth - moreSectionWidth;

            this.visibleClasses = [];
            this.hiddenClasses = [];
            let totalWidth = 0;
            const gap = 4; // ul 的 gap-1 = 4px

            // 测量"全部"按钮
            m.textContent = '全部';
            totalWidth += m.offsetWidth + gap;

            // 逐个测量分类按钮，判断是否超出可用宽度
            for (const c of this.classes) {
                m.textContent = c.type_name;
                const w = m.offsetWidth + gap;
                if (totalWidth + w <= maxWidth) {
                    totalWidth += w;
                    this.visibleClasses.push(c);
                } else {
                    this.hiddenClasses.push(c);
                }
            }

            document.body.removeChild(m);
        },
        async loadClasses() {// 加载分类
            const activeSource = this.getActiveSource();
            if (!activeSource) {
                this.classes = [];
                this.allClassesList = [];
                return;
            }
            const cacheKey = 'cms_cls_' + activeSource.url;
            const cached = localStorage.getItem(cacheKey);
            if (cached) {
                try {
                    const cls = JSON.parse(cached);
                    this.allClassesList = cls;
                    this.classes = this.filterClasses(cls);
                    this.$nextTick(() => this.calcClasses());
                    return;
                } catch (e) {}
            }
            try {
                const api = this.makeApiUrl(activeSource.url, {});
                const r = await this.apiFetch(api);
                const d = await r.json();
                this.apiError = '';
                let cls = [];
                if (Array.isArray(d.class)) cls = d.class;
                else if (Array.isArray(d.list)) cls = d.list;
                else if (d.data && Array.isArray(d.data.class)) cls = d.data.class;
                else if (d.data && Array.isArray(d.data.list)) cls = d.data.list;
                else if (Array.isArray(d.data)) cls = d.data;
                else cls = [];
                localStorage.setItem(cacheKey, JSON.stringify(cls));
                this.allClassesList = cls;
                this.classes = this.filterClasses(cls);
                if (this.currentType !== '0' && !this.classes.some(c => String(c.type_id) === String(this.currentType))) {
                    this.currentType = '0';
                }
                this.$nextTick(() => this.calcClasses());
            } catch (e) {
                console.warn('loadClasses error:', e);
                this.apiError = (e && e.message) ? e.message : String(e);
                this.classes = [];
                this.allClassesList = [];
            }
        },
        async loadData(loadMore = false) {// 加载数据
            const activeSource = this.getActiveSource();
            if (!activeSource) {
                this.videos = [];
                this.totalPages = 1;
                return;
            }
            this.loading = true;
            try {
                const params = {
                    ac: this.searchWd ? 'search' : 'videolist',
                    pg: this.page
                };
                if (this.currentType !== '0') params.t = this.currentType;
                if (this.searchWd) params.wd = this.searchWd;
                const api = this.makeApiUrl(activeSource.url, params);
                const r = await this.apiFetch(api);
                const d = await r.json();
                this.apiError = '';
                let list = [];
                if (Array.isArray(d.list)) list = d.list;
                else if (d.data && Array.isArray(d.data.list)) list = d.data.list;
                else if (Array.isArray(d.data)) list = d.data;
                this.totalPages = Number(d.pagecount || d.totalpage || d.page_count || (d.data && (d.data.pagecount || d.data.totalpage || d.data.page_count)) || 1) || 1;
                if (loadMore) {
                    const merged = this.videos.concat(list);
                    const seen = new Set();
                    this.videos = merged.filter(item => {
                        const key = String(item.vod_id || '') + '_' + String(item.vod_name || '');
                        if (seen.has(key)) return false;
                        seen.add(key);
                        return true;
                    });
                } else {
                    this.videos = list;
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                }
            } catch (e) {
                console.warn('loadData error:', e);
                this.apiError = (e && e.message) ? e.message : String(e);
                if (!loadMore) this.videos = [];
                this.totalPages = 1;
            } finally {
                this.loading = false;
                this.$nextTick(() => this.relayoutMainWall());
            }
        },
        async loadMore() {// 加载更多
            if (this.page >= this.totalPages || this.loading) return;
            this.page++;
            await this.loadData(true);
        },

    doSearch() {// 搜索
      if (!this.searchWd.trim()) return;
      
      this.searchHistory = this.searchHistory.filter(t => t !== this.searchWd);
      this.searchHistory.unshift(this.searchWd);
      if (this.searchHistory.length > 20) this.searchHistory = this.searchHistory.slice(0, 20);
      localStorage.setItem('cms_search_hist', JSON.stringify(this.searchHistory));

      this.page = 1;
      this.currentType = '0';
      this.showSearchHist = false;
      this.loadData();
    },

    clearSearchHistory() {// 清空搜索历史
      this.searchHistory = [];
      localStorage.setItem('cms_search_hist', '[]');
    },
    removeSearchHistory(term) {// 删除单条搜索历史
      this.searchHistory = this.searchHistory.filter(t => t !== term);
      localStorage.setItem('cms_search_hist', JSON.stringify(this.searchHistory));
    },
        pageRange() {// 分页范围
            const r = [];
            for (let i = Math.max(1, this.page - 2); i <= Math.min(this.totalPages, this.page + 2); i++) r.push(i);
            return r;
        },
        isFav(id) {// 是否收藏
            return this.fav.some(f => String(f.vod_id) === String(id))
        },
        tagVal(field, item) {// 根据字段 key 取视频对象的对应值
            if (!item || !field) return '';
            const map = {
                type: item.type_name,
                hits: item.vod_hits,
                lang: item.vod_lang,
                year: item.vod_year,
                area: item.vod_area,
                actor: item.vod_actor,
                director: item.vod_director,
                tag: item.vod_tag,
                duration: item.vod_duration,
                state: item.vod_state,
                remarks: item.vod_remarks,
                pubdate: item.vod_pubdate
            };
            let v = map[field];
            if (v === undefined || v === null) return '';
            return String(v);
        },
        activeCardTags() {// 取当前激活源的卡片标签配置（无则全局默认）
            const src = this.getActiveSource();
            return (src && src.cardTags) ? src.cardTags : (this.cfg.cardTags || {});
        },
        setCardTag(slot, val) {// 设置卡片标签字段（写入当前激活源，无源则写全局）
            const src = this.getActiveSource();
            if (src) {
                if (!src.cardTags) src.cardTags = {};
                src.cardTags[slot] = val;
                this.saveSources();
            } else {
                if (!this.cfg.cardTags) this.cfg.cardTags = {};
                this.cfg.cardTags[slot] = val;
                this.saveCfg();
            }
        },
        cardTagText(cornerOrSub, item) {// 取卡片某角/某行标签文本
            const f = this.activeCardTags()[cornerOrSub];
            return this.tagVal(f, item);
        },
        isSourceBlacklisted(c) {// 检查类型是否在当前编辑源的黑名单中（按 type_id）
            const bl = this.editingSource.blacklist || '';
            const arr = String(bl).split(',').map(s => s.trim()).filter(Boolean);
            return arr.includes(String(c.type_id));
        },
        toggleSourceBlacklist(c) {// 切换当前编辑源黑名单
            const bl = String(this.editingSource.blacklist || '');
            let arr = bl.split(',').map(s => s.trim()).filter(Boolean);
            const tid = String(c.type_id);
            if (this.isSourceBlacklisted(c)) {
                arr = arr.filter(x => x !== tid);
            } else {
                arr.push(tid);
            }
            this.editingSource.blacklist = arr.join(',');
        },
        toggleFav(item) {// 切换收藏
            const idx = this.fav.findIndex(f => String(f.vod_id) === String(item.vod_id));
            if (idx > -1) this.fav.splice(idx, 1);
            else this.fav.unshift({
                ...item,
                fav_time: Date.now()
            });
            localStorage.setItem('cms_fav', JSON.stringify(this.fav))
        },
        clearHist() {// 清空播放历史
            if (!confirm('确定清空所有播放历史？')) return;
            this.his = [];
            localStorage.setItem('cms_his', '[]');
        },
        formatTime(ts) {// 格式化时间
            return ts ? new Date(ts).toLocaleString() : ''
        },
        addSource() {// 添加源
            this.editingIdx = null;
            this.editingSource = {
                name: '',
                url: '',
                skipIntro: false,
                introTime: 0,
                skipOutro: false,
                outroTime: 0,
                blacklist: ''
            };
            this.showSourceEdit = true
        },
        editSource(i) {// 编辑源
            this.editingIdx = i;
            this.editingSource = {
                skipIntro: false, introTime: 0, skipOutro: false, outroTime: 0, blacklist: '',
                ...this.sources[i]
            };
            this.showSourceEdit = true;
        },
        saveSource() {// 保存源
            if (!this.editingSource.name || !this.editingSource.url) {
                alert('请填写名称和地址');
                return;
            }
            if (this.editingIdx !== null) {
                this.sources[this.editingIdx] = {
                    ...this.sources[this.editingIdx],
                    ...this.editingSource
                }
            } else {
                const hasEnabled = this.sources.some(s => s.enabled);
                this.sources.push({
                    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
                    ...this.editingSource,
                    enabled: !hasEnabled
                });
            }
            this.normalizeSourceEnabled();
            this.saveSources();
            this.showSourceEdit = false;
            this.page = 1;
            this.loadClasses().then(() => this.loadData());
        },
        exportSources() {// 导出源
            const blob = new Blob([JSON.stringify(this.sources, null, 2)], {
                type: 'application/json'
            });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'cms_sources.json';
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 1000)
        },
        importSources(e) {// 导入源
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = ev => {
                try {
                    const data = JSON.parse(ev.target.result);
                    if (Array.isArray(data)) {
                        this.sources = this.sources.concat(data.map(s => ({
                            id: s.id || Date.now().toString(36) + Math.random().toString(36).slice(
                                2, 6),
                            name: s.name || '未命名源',
                            url: s.url || '',
                            enabled: false
                        })).filter(s => s.url));
                        this.normalizeSourceEnabled();
                        this.saveSources();
                        this.page = 1;
                        this.loadClasses().then(() => this.loadData())
                    } else {
                        alert('文件格式错误')
                    }
                } catch (err) {
                    alert('文件格式错误')
                }
            };
            reader.readAsText(file);
            e.target.value = '';
        },
        buildBackupData() {// 构造完整数据快照（文件导出与 Gist 同步共用）
            return {
                app: 'api_player',
                version: 1,
                exportedAt: new Date().toISOString(),
                cms_cfg: this.cfg,
                cms_src: this.sources,
                cms_fav: this.fav,
                cms_his: this.his,
                cms_search_hist: this.searchHistory
            };
        },
        applyBackupData(d) {// 应用快照到本地（覆盖），文件导入与 Gist 下载共用
            if (!d || typeof d !== 'object') throw new Error('数据格式错误');
            if (d.cms_cfg && typeof d.cms_cfg === 'object') {
                this.cfg = Object.assign({}, this.cfg, d.cms_cfg);
                this.cfg.cardTags = Object.assign({}, this.cfg.cardTags || {}, d.cms_cfg.cardTags || {});
                this.saveCfg();
            }
            if (Array.isArray(d.cms_src)) {
                this.sources = d.cms_src.map(s => ({ id: s.id || Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: s.name || '未命名源', url: s.url || '', enabled: false, ...s })).filter(s => s.url);
                this.normalizeSourceEnabled();
                this.saveSources();
                const src = this.getActiveSource();
                if (typeof document !== 'undefined' && src && src.name) document.title = src.name;
            }
            if (Array.isArray(d.cms_fav)) { this.fav = d.cms_fav; localStorage.setItem('cms_fav', JSON.stringify(this.fav)); }
            if (Array.isArray(d.cms_his)) { this.his = d.cms_his; localStorage.setItem('cms_his', JSON.stringify(this.his)); }
            if (Array.isArray(d.cms_search_hist)) { this.searchHistory = d.cms_search_hist; localStorage.setItem('cms_search_hist', JSON.stringify(this.searchHistory)); }
            this.applyTheme();
        },
        exportAllData() {// 导出全局全部数据
            const data = this.buildBackupData();
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'cms_backup_' + new Date().toISOString().slice(0, 10) + '.json';
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 1000)
        },
        importAllData(e) {// 导入全局全部数据（覆盖）
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = ev => {
                try {
                    this.applyBackupData(JSON.parse(ev.target.result));
                    alert('导入成功，即将刷新页面应用');
                    setTimeout(() => location.reload(), 300);
                } catch (err) {
                    alert('文件格式错误：' + (err && err.message ? err.message : err));
                }
            };
            reader.readAsText(file);
            e.target.value = '';
        },

        saveGistCfg() {// 保存 Gist 同步设置
            localStorage.setItem('cms_gist', JSON.stringify(this.gistCfg));
        },
        toggleGistAutoSync(on) {// 自动同步开关
            this.gistCfg.autoSync = !!on;
            this.saveGistCfg();
            this.gistMsg = this.gistCfg.autoSync ? '自动同步已开启：打开页面时拉取，每 2 分钟推送变更' : '自动同步已关闭';
            this.setupGistAutoSync();
            if (this.gistCfg.autoSync && this.gistCfg.gistId && this.gistCfg.token) this.downloadGist();
        },
        setupGistAutoSync() {// 定时推送（无变更则跳过）
            if (this._gistTimer) { clearInterval(this._gistTimer); this._gistTimer = null; }
            if (!this.gistCfg.autoSync) return;
            this._gistTimer = setInterval(() => this.uploadGist(true), 120000);
        },
        gistHeaders() {// GitHub API 公共请求头
            const token = String(this.gistCfg.token || '').trim();
            if (!token) throw new Error('请先填写 GitHub Personal Access Token');
            return {
                'Accept': 'application/vnd.github+json',
                'Authorization': 'Bearer ' + token,
                'X-GitHub-Api-Version': '2022-11-28'
            };
        },
        async gistRequest(path, options) {// 统一处理 GitHub API 响应与错误
            const headers = this.gistHeaders();
            const opt = Object.assign({}, options || {}, { headers: Object.assign(headers, (options && options.headers) || {}) });
            if (opt.body) headers['Content-Type'] = 'application/json';
            let resp;
            try {
                resp = await fetch('https://api.github.com' + path, opt);
            } catch (e) {
                throw new Error('网络请求失败：' + (e && e.message ? e.message : e));
            }
            if (!resp.ok) {
                let msg = resp.status + ' ' + resp.statusText;
                try { const j = await resp.json(); if (j && j.message) msg = j.message; } catch (e) {}
                if (resp.status === 401) msg = 'Token 无效或缺少 gist 权限（401）';
                if (resp.status === 403) msg = '访问被拒绝或请求过于频繁（403）';
                if (resp.status === 404) msg = 'Gist 不存在或无权访问（404）';
                throw new Error(msg);
            }
            return resp.status === 204 ? null : resp.json();
        },
        async uploadGist(silent) {// 上传本地全量数据；无 gistId 时自动创建私有 Gist
            if (this.gistBusy) return;
            if (!String(this.gistCfg.token || '').trim()) {
                if (!silent) this.gistMsg = '请先填写 GitHub Personal Access Token';
                return;
            }
            const payload = JSON.stringify(this.buildBackupData(), null, 2);
            if (silent && payload === this._gistLastPayload) return;
            this.gistBusy = true;
            if (!silent) this.gistMsg = '正在上传到 GitHub Gist…';
            try {
                const files = {};
                files[GIST_FILENAME] = { content: payload };
                const id = String(this.gistCfg.gistId || '').trim();
                let res = null;
                if (id) {
                    try {
                        res = await this.gistRequest('/gists/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ files }) });
                    } catch (e) {
                        if (!/404/.test(String(e && e.message))) throw e;
                        this.gistCfg.gistId = '';
                    }
                }
                if (!this.gistCfg.gistId) {
                    res = await this.gistRequest('/gists', {
                        method: 'POST',
                        body: JSON.stringify({
                            description: 'api_player 数据同步（设置 / API源 / 收藏 / 历史 / 搜索记录）',
                            public: false,
                            files
                        })
                    });
                    this.gistCfg.gistId = res && res.id ? res.id : '';
                }
                this.gistCfg.syncedAt = new Date().toISOString();
                this._gistLastPayload = payload;
                this.saveGistCfg();
                this.gistMsg = '上传成功 · ' + this.gistCfg.gistId + ' · ' + new Date().toLocaleString();
            } catch (e) {
                this.gistMsg = '上传失败：' + (e && e.message ? e.message : e);
            } finally {
                this.gistBusy = false;
            }
        },
        async downloadGist(silent) {// 下载并覆盖本地数据，走与文件导入相同的 applyBackupData
            if (this.gistBusy) return;
            const id = String(this.gistCfg.gistId || '').trim();
            if (!id) {
                if (!silent) this.gistMsg = '请先填写 Gist ID，或先上传一次';
                return;
            }
            this.gistBusy = true;
            if (!silent) this.gistMsg = '正在从 GitHub Gist 下载…';
            try {
                const res = await this.gistRequest('/gists/' + encodeURIComponent(id));
                const files = (res && res.files) || {};
                const file = files[GIST_FILENAME] || files[Object.keys(files)[0]];
                if (!file) throw new Error('Gist 中没有 ' + GIST_FILENAME + ' 文件');
                let raw = file.content || '';
                if (file.truncated && file.raw_url) {
                    const r2 = await fetch(file.raw_url, { headers: this.gistHeaders() });
                    if (!r2.ok) throw new Error('读取完整文件失败（' + r2.status + '）');
                    raw = await r2.text();
                }
                const d = JSON.parse(raw);
                this.applyBackupData(d);
                this._gistLastPayload = JSON.stringify(this.buildBackupData(), null, 2);
                this.gistCfg.syncedAt = new Date().toISOString();
                this.saveGistCfg();
                this.gistMsg = '下载成功 · ' + new Date().toLocaleString();
                this.page = 1;
                this.loadClasses().then(() => this.loadData());
            } catch (e) {
                this.gistMsg = '下载失败：' + (e && e.message ? e.message : e);
                if (this.sources.length) this.loadClasses().then(() => this.loadData());
            } finally {
                this.gistBusy = false;
            }
        },

        parsePlayGroups(item) {// 解析播放地址组
            const f = String(item.vod_play_from || '').split('$$$').filter(Boolean);
            const u = String(item.vod_play_url || '').split('$$$').filter(Boolean);
            return u.map((g, j) => ({
                sn: f[j] || ('线路' + (j + 1)),
                ep: g.split('#').map((e, k) => {
                    const x = e.indexOf('\$');
                    if (x < 0) return {
                        n: '第' + (k + 1) + '集',
                        u: e.trim()
                    };
                    return {
                        n: e.slice(0, x).trim() || ('第' + (k + 1) + '集'),
                        u: e.slice(x + 1).trim()
                    }
                }).filter(e => e.u)
            })).filter(g => g.ep.length)
        },
        detectUrlType(url) {// 检测播放地址类型
            if (!url) {
                this.currentUrlType = 'unknown';
                return 'unknown';
            }
            const u = url.toLowerCase();
            if (u.includes('.m3u8')) {
                this.currentUrlType = 'm3u8';
                return 'm3u8';
            }
            if (u.includes('.mp4') || u.includes('.webm') || u.includes('.mov') || u.includes('.avi')) {
                this.currentUrlType = 'direct';
                return 'direct';
            }
            if (u.includes('.html') || u.includes('.htm') || u.includes('/play/') || u.includes('/player/')) {
                this.currentUrlType = 'webpage';
                return 'webpage';
            }
            if (u.includes('iframe') || u.includes('<iframe')) {
                this.currentUrlType = 'iframe';
                return 'iframe';
            }
            if (u.includes('aliyun') || u.includes('alibaba') || u.includes('aliyundrive')) {
                this.currentUrlType = 'aliyun';
                return 'aliyun';
            }
            if (u.includes('txy') || u.includes('txcloud') || u.includes('qcloud')) {
                this.currentUrlType = 'tencent';
                return 'tencent';
            }
            this.currentUrlType = 'unknown';
            return 'unknown';
        },
        rebuildM3u8Url() {// 重建构建m3u8播放地址
            const eps = this.currentEps();
            if (!eps[this.playEp]) return;
            const rawUrl = eps[this.playEp].u;
            if (!rawUrl || !rawUrl.includes('.m3u8')) return;
            let newUrl = rawUrl;
            this.renderPlayerWithUrl(newUrl);
        },
        async sniffMediaUrl(rawUrl) {// 嗅探播放地址
            const base = String(this.cfg.apiProxy || '').trim().replace(/\\/+$/, '');
            // 扩展环境没有 /parse/ 服务端，直接用原始地址，由播放器自行解析；
            // 若用户显式配置了代理地址，则仍走代理的 /parse/。
            if (this.directMode && !base) { this.sniffedUrl = rawUrl; this.sniffedUrlType = 'original'; return; }
            // 新一次嗅探先取消上一次，避免旧的异步结果在关闭播放器后继续渲染
            if (this._sniffController) { try { this._sniffController.abort(); } catch (e) {} }
            const controller = new AbortController();
            this._sniffController = controller;
            const timer = setTimeout(() => controller.abort(), 15000);
            try {
                this.sniffedUrl = null;
                this.sniffedUrlType = '';
                const resp = await fetch(base + '/parse/' + encodeURIComponent(rawUrl), {
                    signal: controller.signal
                });
                const data = await resp.json();
                if (data.m3u8) {
                    this.sniffedUrl = data.m3u8;
                    this.sniffedUrlType = 'm3u8';
                } else if (data.url && data.resolved) {
                    this.sniffedUrl = data.url;
                    this.sniffedUrlType = data.type || 'unknown';
                } else {
                    this.sniffedUrl = rawUrl;
                    this.sniffedUrlType = 'original';
                }
            } catch (e) {
                this.sniffedUrl = rawUrl;
                this.sniffedUrlType = 'original';
            } finally {
                clearTimeout(timer);
                if (this._sniffController === controller) this._sniffController = null;
            }
        },
        playSniffedUrl() {// 播放嗅探到的播放地址
            if (!this.sniffedUrl) return;
            this.renderPlayerWithUrl(this.sniffedUrl);
        },
        renderPlayerWithUrl(url) {// 渲染播放器
            this._playToken++; // 作废仍在等待中的异步嗅探结果
            const box = document.getElementById('playerBox');
            this.destroyPlayers();
            box.innerHTML = '<div class="sm:absolute inset-0 flex items-center justify-center"><div class="w-full h-full" id="playerMount"></div></div>';
            this.isWebPlayer = false;
            if (this.cfg.playerType === 'art') {
                this.renderArtPlayer(url, box);
                this.saveHistory(0);
                return;
            }
            if (this.cfg.playerType === 'native') {
                this.renderNativePlayer(url, box);
                this.saveHistory(0);
                return;
            }
            window.location.href = this.cfg.playerType + '://' + url;
            this.saveHistory(0);
        },
        openPlayer(item) {// 打开播放器
            this._playToken++;
            const g = this.parsePlayGroups(item);
            if (!g.length) {
                alert('无播放地址');
                return;
            }
            this.playGroups = g;
            this.playSrc = 0;
            this.playEp = 0;
            this.playerTitle = item.vod_name || '未命名';
            this.currentItem = item;
            this.isWebPlayer = false;
            this.showPlayerSettings = false;
            this.showPlayerSidebar = true;
            const h = this.his.find(x => String(x.vod_id) === String(item.vod_id));
            if (h) {
                this.playSrc = Math.min(h.last_source_index || 0, g.length - 1);
                this.playEp = Math.min(h.last_episode_index || 0, (this.playGroups[this.playSrc] ? this.playGroups[this.playSrc].ep.length : 1) - 1);
            }
            this.playSpeed = this.cfg.rememberSpeed ? (localStorage.getItem('cms_spd') || '1') : '1';
            this.showPlayer = true;
            this.$nextTick(() => this.renderPlayer())
        },
        isWebPlayerUrl(url) {// 检查是否为网页播放地址
            if (!url) return false;
            const u = url.toLowerCase();
            return u.includes('.html') || u.includes('.htm') || u.includes('/play/') || u.includes('/player/') || u.includes('iframe');
        },
        currentEps() {// 获取当前剧集列表
            return this.playGroups[this.playSrc] ? this.playGroups[this.playSrc].ep : [];
        },
        getActiveSkipSettings() {// 取当前激活源的跳过设置，覆盖全局 cfg（用于本次播放）
            const src = this.getActiveSource();
            if (src && (src.skipIntro || src.skipOutro)) {
                return {
                    skipIntro: !!src.skipIntro,
                    introTime: Number(src.introTime) || 0,
                    skipOutro: !!src.skipOutro,
                    outroTime: Number(src.outroTime) || 0
                };
            }
            return {
                skipIntro: this.cfg.skipIntro,
                introTime: this.cfg.introTime,
                skipOutro: this.cfg.skipOutro,
                outroTime: this.cfg.outroTime
            };
        },
        async renderPlayer() {// 渲染播放器
            const token = ++this._playToken;
            try {
            if (!this.showPlayer) return;
            const eps = this.currentEps();
            if (!eps[this.playEp]) return;
            const rawUrl = eps[this.playEp].u;
            this._skip = this.getActiveSkipSettings();
            this.$nextTick(() => this.applyPortraitNarrow());
            // 先填充 playerBox 占位，避免空白
            const box0 = document.getElementById('playerBox');
            if (box0) box0.innerHTML = '<div class="absolute inset-0 flex items-center justify-center text-gray-400 text-sm">加载中…</div>';
            this.detectUrlType(rawUrl);
            let playUrl = rawUrl;
            // 仅对非 m3u8/direct 类型嗅探，且不阻塞主渲染
            if (this.currentUrlType !== 'm3u8' && this.currentUrlType !== 'direct') {
                try {
                    await this.sniffMediaUrl(rawUrl);
                    // 关闭/切换后不再继续渲染（否则隐藏的容器仍会创建 Hls 并持续拉 .ts）
                    if (token !== this._playToken || !this.showPlayer) return;
                    if (this.sniffedUrl && this.sniffedUrlType !== 'original') {
                        playUrl = this.sniffedUrl;
                        this.detectUrlType(playUrl);
                    }
                } catch (e) {
                    this.sniffedUrl = rawUrl;
                    this.sniffedUrlType = 'original';
                }
            } else {
                this.sniffedUrl = null;
                this.sniffedUrlType = '';
            }
            if (token !== this._playToken || !this.showPlayer) return;
            const url = playUrl;
            const box = document.getElementById('playerBox');
            this.destroyPlayers();
            box.innerHTML = '<div class="sm:absolute inset-0 flex items-center justify-center"><div class="w-full h-full" id="playerMount"></div></div>';
            if (this.currentUrlType === 'webpage' || this.currentUrlType === 'iframe' || this.currentUrlType === 'unknown') {
                if (this.sniffedUrlType === 'original' || !this.sniffedUrl) {
                    this.isWebPlayer = true;
                    box.innerHTML = '<iframe src="' + playUrl + '" class="w-full h-full border-0" allowfullscreen allow="autoplay; fullscreen; picture-in-picture"></iframe>';
                    this.saveHistory(0);
                    return;
                }
            }
            this.isWebPlayer = false;
            if (this.cfg.playerType === 'art') {
                this.renderArtPlayer(url, box);
                this.saveHistory(0);
                return;
            }
            this.renderNativePlayer(url, box);
            this.saveHistory(0);
            } catch (err) {
                if (token !== this._playToken || !this.showPlayer) return;
                const box = document.getElementById('playerBox');
                if (box) box.innerHTML = '<div class="absolute inset-0 flex items-center justify-center text-red-400 text-sm p-4 text-center">播放失败：' + (err && err.message ? err.message : err) + '</div>';
            }
        },
        renderNativePlayer(url, box) {// 渲染原生播放器
            const mount = document.getElementById('playerMount') || box;
            mount.innerHTML =
                '<video id="pv" controls autoplay playsinline webkit-playsinline class="w-full h-full bg-black object-contain"><\\/video>';
            const v = document.getElementById('pv');
            const isM3u8 = url.includes('.m3u8');
            if (isM3u8 && window.Hls && Hls.isSupported()) {
                this.destroyHls();
                this._hls = this.createHls();
                this._hls.loadSource(url);
                this._hls.attachMedia(v);
            } else {
                v.src = url;
            }
            v.playbackRate = parseFloat(this.playSpeed) || 1;
            const h = this.his.find(x => String(x.vod_id) === String(this.currentItem.vod_id));
            const doSeek = (target) => { try { if (target > 0 && target < v.duration - 5) v.currentTime = target; } catch (e) {} };
            if (h && h.last_source_index === this.playSrc && h.last_episode_index === this.playEp && h.last_time) {
                v.addEventListener('loadedmetadata', () => doSeek(h.last_time), { once: true });
            }
            // 片头跳过：视频可播放后跳到指定秒数
            if (this._skip.skipIntro && this._skip.introTime > 0) {
                v.addEventListener('loadedmetadata', () => doSeek(this._skip.introTime), { once: true });
            }
            // 片尾跳过：距结束还剩 outroTime 秒时跳下一集
            let outroFired = false;
            v.ontimeupdate = () => {
                const ct = v.currentTime || 0;
                this.saveHistory(ct);
                if (!outroFired && this._skip.skipOutro && this._skip.outroTime > 0 && v.duration > 0) {
                    if (ct >= v.duration - this._skip.outroTime) {
                        outroFired = true;
                        if (this.cfg.autoNext) this.nextEp();
                    }
                }
            };
            v.onended = () => {
                if (this.cfg.autoNext) this.nextEp();
            };
            v.onratechange = () => {
                this.playSpeed = String(v.playbackRate);
                if (this.cfg.rememberSpeed) localStorage.setItem('cms_spd', this.playSpeed)
            };
        },
        renderArtPlayer(url, box) {// 渲染artplayer
            let introSkipped = false;
            let outroFired = false;
            this._art = new Artplayer({
                container: box,
                url: url,
                autoplay: true,
                autoSize: true,
                fullscreen: true,
                fullscreenWeb: true,
                playbackRate: true,
                setting: true,
                pip: true,
                mutex: true,
                customType: {
                    m3u8: (video, m3u8Url) => {
                        if (window.Hls && Hls.isSupported()) {
                            // 关键：Hls 实例必须交给 app 持有，关闭时才能销毁并停止 .ts 分片下载
                            this.destroyHls();
                            this._hls = this.createHls();
                            this._hls.loadSource(m3u8Url);
                            this._hls.attachMedia(video);
                        } else {
                            video.src = m3u8Url;
                        }
                    }
                }
            });
            this._art.on('ready', () => {
                try {
                    this._art.video.playbackRate = parseFloat(this.playSpeed) || 1;
                    // 片头跳过
                    if (!introSkipped && this._skip.skipIntro && this._skip.introTime > 0) {
                        introSkipped = true;
                        const dur = this._art.video.duration;
                        if (this._skip.introTime < dur - 5) this._art.video.currentTime = this._skip.introTime;
                    }
                } catch (e) {}
            });
            this._art.on('video:timeupdate', () => {
                try {
                    const ct = this._art.video.currentTime || 0;
                    this.saveHistory(ct);
                    // 片尾跳过
                    if (!outroFired && this._skip.skipOutro && this._skip.outroTime > 0 && this._art.video.duration > 0) {
                        if (ct >= this._art.video.duration - this._skip.outroTime) {
                            outroFired = true;
                            if (this.cfg.autoNext) this.nextEp();
                        }
                    }
                } catch (e) {}
            });
            this._art.on('video:ended', () => {
                if (this.cfg.autoNext) this.nextEp();
            });
        },
        prevEp() {// 上一剧集
            let ne = this.playEp - 1;
            let ns = this.playSrc;
            if (ne < 0) {
                ns--;
                if (ns < 0) return;
                ne = (this.playGroups[ns] ? this.playGroups[ns].ep.length : 1) - 1
            }
            this.playSrc = ns;
            this.playEp = ne;
            this.renderPlayer()
        },
        nextEp() {// 下一剧集
            let ne = this.playEp + 1;
            let ns = this.playSrc;
            if (ne >= this.currentEps().length) {
                ns++;
                ne = 0;
                if (ns >= this.playGroups.length) return
            }
            this.playSrc = ns;
            this.playEp = ne;
            this.renderPlayer()
        },
        saveHistory(currentTime = 0) {// 保存播放历史
            if (!this.currentItem) return;
            this.his = this.his.filter(h => String(h.vod_id) !== String(this.currentItem.vod_id));
            this.his.unshift({
                ...this.currentItem,
                last_watch_time: Date.now(),
                last_source_index: this.playSrc,
                last_episode_index: this.playEp,
                last_time: currentTime || 0
            });
            if (this.his.length > 200) this.his = this.his.slice(0, 200);
            localStorage.setItem('cms_his', JSON.stringify(this.his));
        },
        fallbackCopy(text) {// 复制文本到剪贴板
            const ta = document.createElement('textarea');
            ta.value = text;
            document.body.appendChild(ta);
            ta.select();
            try {
                document.execCommand('copy');
                alert('已复制')
            } catch (e) {
                alert('复制失败')
            }
            document.body.removeChild(ta);
        },
        createHls() {// 统一创建 Hls：关闭逐分片调试日志，避免每个 .ts 分片打印一条刷屏
            // hls.js 默认 debug:false，但显式声明并在 logger 层拦截，防止版本默认值变化或误开导致刷屏。
            // log/info（含逐分片加载信息）默认静默；warn/error 保留，但做节流避免错误风暴刷屏。
            const self = this;
            if (!self._hlsLogThrottle) self._hlsLogThrottle = {};
            const throttled = (level) => function () {
                const key = level + ':' + (arguments[0] && String(arguments[0]).slice(0, 120));
                const now = Date.now();
                if (now - (self._hlsLogThrottle[key] || 0) < 3000) return;
                self._hlsLogThrottle[key] = now;
                console[level].apply(console, arguments);
            };
            const logger = {
                log: function () {},
                info: function () {},
                debug: function () {},
                warn: throttled('warn'),
                error: throttled('error')
            };
            return new Hls({ debug: false, logger: logger, enableWorker: true });
        },
        destroyHls() {// 销毁 Hls 实例并断开媒体，彻底停止分片请求
            if (!this._hls) return;
            try { this._hls.stopLoad(); } catch (e) {}
            try { this._hls.detachMedia(); } catch (e) {}
            try { this._hls.destroy(); } catch (e) {}
            this._hls = null;
        },
        destroyPlayers() {// 销毁所有播放器并停止一切媒体请求
            // 1) 取消进行中的嗅探请求
            if (this._sniffController) {
                try { this._sniffController.abort(); } catch (e) {}
                this._sniffController = null;
            }
            // 2) 停掉自定义进度条的 rAF 循环
            if (this._progressRAF) {
                try { cancelAnimationFrame(this._progressRAF); } catch (e) {}
                this._progressRAF = null;
            }
            const box = document.getElementById('playerBox');
            // 3) 先停 video / iframe，再销毁播放器实例
            if (box) {
                box.querySelectorAll('video').forEach(v => {
                    try { v.pause(); } catch (e) {}
                    try { v.srcObject = null; } catch (e) {}
                    try { v.removeAttribute('src'); v.load(); } catch (e) {}
                });
                box.querySelectorAll('iframe').forEach(f => {
                    try { f.src = 'about:blank'; } catch (e) {}
                });
            }
            this.destroyHls();
            if (this._art) {
                try { this._art.destroy(false); } catch (e) {}
                this._art = null;
            }
            if (box) { try { box.innerHTML = ''; } catch (e) {} }
        },
        closePlayer() {// 关闭播放器
            this._playToken++; // 作废尚未完成的渲染 / 嗅探
            this.showPlayer = false;
            this.destroyPlayers();
            this.sniffedUrl = null;
            this.sniffedUrlType = '';
            this.isWebPlayer = false;
            this.showPlayerSettings = false;
        },
        sortedEps() {// 排序剧集
            let eps = [...(this.currentEps() || [])];
            if (!this.epSortAsc) eps.reverse();
            return eps;
        },
        toggleEpSort() {// 切换剧集排序
            this.epSortAsc = !this.epSortAsc;
        },
        getPlayerTime() {// 获取当前播放时间（兼容三种播放器）
            if (this._art && this._art.video) return Math.floor(this._art.video.currentTime || 0);
            const v = document.getElementById('pv');
            if (v) return Math.floor(v.currentTime || 0);
            return 0;
        },
        getDuration() {// 获取视频总时长（兼容三种播放器）
            if (this._art && this._art.video) return Math.floor(this._art.video.duration || 0);
            const v = document.getElementById('pv');
            if (v) return Math.floor(v.duration || 0);
            return 0;
        },
        applyPortraitNarrow() {// 小屏播放时把播放器区域压成 16:9，避免竖屏海报把页面撑高
            const pb = document.getElementById('playerBox');
            if (!pb) return;
            if (window.innerWidth < 640) pb.style.height = (window.innerWidth * 9 / 16) + 'px';
            else pb.style.height = '';
        },
        getRemainingTime() {// 片尾场景：距结束还剩多少秒 = 总时长 - 当前时间
            const dur = this.getDuration();
            const cur = this.getPlayerTime();
            if (dur <= 0 || cur <= 0) return 0;
            return Math.max(0, dur - cur);
        },
        shareCurrent() {// 分享当前视频
            const text = location.origin + '?v=' + encodeURIComponent(this.currentItem ? this.currentItem.vod_id : '');
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).then(() => alert('分享链接已复制')).catch(() => this.fallbackCopy(text));
            } else {
                this.fallbackCopy(text);
            }
        },
        downloadCurrent() {// 下载当前视频
            const eps = this.currentEps();
            if (!eps[this.playEp]) return;
            window.open(eps[this.playEp].u, '_blank');
        },
    }
}
// 用 Alpine.data 注册组件：标准版与 CSP 版都支持 x-data="app" 写法，
// 且组件方法在 JS 中定义（不经 CSP 表达式解析器），满足 MV3 扩展的无 eval 要求。
document.addEventListener('alpine:init', function () {
    if (window.Alpine && window.Alpine.data) window.Alpine.data('app', app);
});
<\/script>
</body>
</html>`;

export default {
    async fetch(req, env) {
        const url = new URL(req.url);
        const path = url.pathname;
        //  OPTIONS请求直接返回
        if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
        //  直接返回u参数
        if (url.searchParams.has('u')) return proxy(req);
        //  m3u8代理
        if (url.searchParams.has('m3u8')) {// 处理m3u8地址
            const m3u8Url = url.searchParams.get('m3u8');
            const skip = Math.max(0, parseInt(url.searchParams.get('skip') || '1', 10));
            // 逐条日志按需开启：请求参数 debug=1 或环境变量 DEBUG_MEDIA=1
            const debug = MEDIA_DEBUG || url.searchParams.has('debug') || !!(env && env.DEBUG_MEDIA);
            try {
                let text = await handleM3u8Proxy(m3u8Url, skip, debug);
                return new Response(text, {
                    headers: {
                        'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
                        'Cache-Control': 'no-store',
                        ...CORS
                    }
                });
            } catch (e) {
                // 错误与异常保留：单条输出，便于排障，且不会随分片数量增长
                console.warn('[m3u8] proxy error:', e && e.message ? e.message : e);
                return new Response(JSON.stringify({ error: e.message }), {
                    status: 502,
                    headers: { 'Content-Type': 'application/json', ...CORS }
                });
            }
        }

        if (path.startsWith('/parse/')) {// 解析播放地址
            return handleParse(path.slice(7));
        }

        return new Response(HTML, {
            headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
    }
};
async function handleParse(rawUrl) {// 解析播放地址
    let url = rawUrl;
    if (!url.startsWith('http')) url = 'https://' + url;
    try {
        const result = await parsePlayUrl(url);
        return new Response(JSON.stringify(result), {
            headers: { 'Content-Type': 'application/json', ...CORS }
        });
    } catch (e) {
        return new Response(JSON.stringify({ error: e.message, url }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', ...CORS }
        });
    }
}
