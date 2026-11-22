
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
            const base = String(this.cfg.apiProxy || '').trim().replace(/\/+$/, '');
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
            if (text.replace(/^\s+/, '').charAt(0) === '<') {
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
                    const x = e.indexOf('$');
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
            const base = String(this.cfg.apiProxy || '').trim().replace(/\/+$/, '');
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
                '<video id="pv" controls autoplay playsinline webkit-playsinline class="w-full h-full bg-black object-contain"><\/video>';
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
