import { PROFESSIONS, STORY_CATEGORIES, filterOperators, backgroundUrl } from './directory.js?v=0.2.0';
import { safeImageUrl } from './core.js?v=0.2.0';

const PROF_SYMBOLS = { 先锋: '△', 近卫: '⚔', 重装: '⬡', 狙击: '⌁', 术师: '♜', 医疗: '✚', 辅助: '◇', 特种: '⌘' };
const TABS = [
    ['basic', '基础档案', s => /基础档案/.test(s.title)],
    ['exam', '综合体检', s => /体检/.test(s.title)],
    ['resume', '客观履历', s => /履历/.test(s.title)],
    ['archive', '档案资料', s => !/基础档案|体检|履历|语音|模组/.test(s.title)],
    ['voice', '语音记录', s => /语音/.test(s.title)],
    ['module', '模组叙事', s => /模组/.test(s.title)],
];

export function archiveFacts(text) {
    return [...String(text).matchAll(/【([^】]+)】\s*([\s\S]*?)(?=【|$)/g)].map(m => ({ label: m[1].trim(), value: m[2].trim() })).filter(f => f.label && f.value);
}

export function createViews(api) {
    const { el, button, hint, badge, link, field, state, records, render, titleBlock } = api;
    const opIndex = () => state.operatorIndex;
    const change = work => { work(); render(); };
    const image = (src, alt, attrs = {}) => src ? el('img', { src, alt, loading: 'lazy', referrerpolicy: 'no-referrer', onerror: e => { e.target.style.visibility = 'hidden'; }, ...attrs }) : null;
    const picture = (key, alt) => image(backgroundUrl(key), alt, { class: 'ta-cover-image' });

    function select(label, value, choices, action) {
        const node = el('select', { 'aria-label': label, onchange: e => action(e.target.value), disabled: state.busy }, choices.map(([key, text]) => el('option', { value: key }, text)));
        node.value = value;
        return node;
    }

    function operatorCard(op, mode) {
        const view = mode === 'portrait' ? 'portrait' : 'avatar';
        const src = safeImageUrl(opIndex()?.portraits?.[`${view}:${op.name}`]);
        const loaded = records.has(`character:${op.name}`);
        const active = api.chatState().characters.some(c => c.id === `character:${op.name}`);
        return button(el('div', { class: 'ta-op-card-inner' },
            el('div', { class: 'ta-op-portrait' }, el('span', { class: 'ta-portrait-placeholder', 'aria-hidden': true }, op.name.slice(0, 1)), image(src, `${op.name}的${view === 'portrait' ? '半身像' : '头像'}`),
                el('span', { class: 'ta-profession-icon', title: op.profession }, PROF_SYMBOLS[op.profession] || '◇'),
                el('span', { class: 'ta-rarity', 'aria-label': `${op.rarity}星` }, '★'.repeat(op.rarity))),
            el('div', { class: 'ta-op-card-caption' }, el('strong', {}, op.name), el('span', { class: 'ta-op-english' }, op.en || op.branch),
                el('small', {}, `${op.profession} / ${op.branch}`), active ? el('span', { class: 'ta-card-state active' }, '已启用') : loaded ? el('span', { class: 'ta-card-state' }, '已缓存') : null)),
        () => api.openCharacter(op.name), { class: `ta-op-card ${active ? 'is-active' : ''}`, title: `${op.name} · ${op.profession} · ${op.rarity}星`, 'aria-label': `查看${op.name}的资料` });
    }

    function operatorGrid() {
        const directory = opIndex();
        const options = { query: state.opQuery, profession: state.opProfession, rarity: state.opRarity, sort: state.opSort };
        const filtered = filterOperators(directory?.operators || [], options);
        const pageCount = Math.max(1, Math.ceil(filtered.length / state.opPageSize));
        const currentPage = Math.min(state.opPage, pageCount - 1);
        const visible = filtered.slice(currentPage * state.opPageSize, (currentPage + 1) * state.opPageSize);
        api.ensurePortraits(visible, state.opMode === 'portrait' ? 'portrait' : 'avatar');
        const pagination = () => el('div', { class: 'ta-pagination' },
            button('← 上一页', () => change(() => { state.opPage = Math.max(0, currentPage - 1); }), { disabled: state.busy || currentPage === 0 }),
            el('span', {}, `${currentPage + 1} / ${pageCount} 页 · ${filtered.length} 位干员`),
            button('下一页 →', () => change(() => { state.opPage = currentPage + 1; }), { disabled: state.busy || currentPage + 1 >= pageCount }));
        return el('div', { class: 'ta-directory-view' },
            el('div', { class: 'ta-directory-heading' }, titleBlock('OPERATORS / PRTS INDEX', '人物档案', '以 Wiki 干员一览为图鉴目录。点击人物卡片即可加载，不必先记住名字。'),
                el('div', { class: 'ta-directory-utilities' }, button('刷新图鉴', () => api.refreshDirectory('characters')), link('Wiki 图鉴 ↗', 'https://prts.wiki/w/干员一览'))),
            el('div', { class: 'ta-directory-toolbar' },
                field('筛选名称、阵营、分支或代号…', state.opQuery, value => change(() => { state.opQuery = value; state.opPage = 0; }), 'operator-filter'),
                select('排序方式', state.opSort, [['release-desc', '实装倒序'], ['release-asc', '实装顺序'], ['name-asc', '名称升序'], ['name-desc', '名称降序'], ['rarity-desc', '稀有度降序'], ['rarity-asc', '稀有度升序']], value => change(() => { state.opSort = value; state.opPage = 0; })),
                el('div', { class: 'ta-segmented' }, [['portrait', '半身像'], ['avatar', '头像'], ['list', '列表']].map(([mode, label]) => button(label, () => change(() => { state.opMode = mode; }), { class: `ta-mode ${state.opMode === mode ? 'active' : ''}`, 'aria-pressed': state.opMode === mode })))),
            el('div', { class: 'ta-directory-filters' },
                el('div', { class: 'ta-profession-tabs' }, ['', ...PROFESSIONS].map(profession => button(profession || '全部', () => change(() => { state.opProfession = profession; state.opPage = 0; }), { class: `ta-filter-tab ${state.opProfession === profession ? 'active' : ''}` }))),
                select('稀有度筛选', state.opRarity, [['', '全部星级'], ...[6, 5, 4, 3, 2, 1].map(n => [String(n), `${n} 星`])], value => change(() => { state.opRarity = value; state.opPage = 0; }))),
            directory ? el('div', {}, pagination(),
                visible.length ? el('div', { class: `ta-operator-grid mode-${state.opMode}` }, visible.map(op => operatorCard(op, state.opMode))) : api.empty('没有匹配的干员', '试试其他职业、星级或关键字。'),
                pagination(), hint(`目录更新于 ${new Date(directory.fetchedAt).toLocaleString()} · 仅按当前页加载缩略图；点击人物后才读取档案。`))
                : api.empty(state.busy ? '正在同步 Wiki 图鉴' : '图鉴暂未载入', '首次打开会自动读取目录。若联网失败，可点击刷新图鉴重试；原有缓存不会清除。'),
            el('details', { class: 'ta-section ta-compact-import' }, el('summary', {}, '备用入口 · 按链接打开 / 本机缓存'),
                el('form', { class: 'ta-search', onsubmit: e => { e.preventDefault(); api.openCharacter(state.query); } }, field('人物名字或 PRTS 链接', state.query, v => { state.query = v; }, 'character-query'), el('button', { type: 'submit', class: 'ta-button', disabled: state.busy }, '打开')),
                api.recordsList('character')));
    }

    function sectionView(item, section, active) {
        const facts = archiveFacts(section.text);
        const isExam = /体检/.test(section.title);
        const ratings = { 缺陷: 20, 普通: 40, 标准: 60, 优良: 80, 卓越: 100 };
        return el('section', { class: 'ta-dossier-section' },
            el('header', { class: 'ta-section-title' }, el('h3', {}, section.title), badge(section.condition || (section.basic ? '基础条目' : '按需启用'))),
            el('label', { class: 'ta-checkbox' }, el('input', { type: 'checkbox', checked: active?.sectionIds.includes(section.id), disabled: !active || state.busy,
                onchange: e => api.chooseSection(item, section.id, e.target.checked) }), '供当前聊天参考'),
            facts.length ? el('dl', { class: isExam ? 'ta-rating-grid' : 'ta-fact-grid' }, facts.map(fact => el('div', {}, el('dt', {}, fact.label), el('dd', {}, fact.value),
                isExam && ratings[fact.value] ? el('span', { class: 'ta-rating-track', 'aria-hidden': 'true' }, el('i', { style: `width:${ratings[fact.value]}%` })) : null))) : el('div', { class: 'ta-prose' }, section.text),
            isExam ? hint('条形仅辅助展示档案评级，不代表游戏战斗数值。') : null,
            section.truncated ? hint('条目过长，缓存内容已标注截断，请通过原页查看完整资料。') : null);
    }

    function dossier(item) {
        const active = api.characterSelection(item.id);
        const meta = opIndex()?.operators.find(o => o.name === item.title || o.characterId === item.characterId);
        const artIndex = Math.min(state.artworkIndex || 0, Math.max(0, item.images.length - 1));
        const art = item.images[artIndex];
        const tab = TABS.find(t => t[0] === state.dossierTab) || TABS[0];
        const sections = item.sections.filter(tab[2]);
        return el('div', { class: 'ta-dossier-view' },
            el('div', { class: 'ta-breadcrumbs' }, button('← 返回人物图鉴', () => change(() => { state.characterOpen = false; }), { class: 'ta-text-button', disabled: false }), badge(active ? '当前聊天已启用' : '仅查看资料'), link('查看原页 ↗', item.source)),
            el('div', { class: 'ta-dossier-layout' },
                el('aside', { class: 'ta-dossier-art-column' },
                    el('div', { class: 'ta-dossier-hero' }, picture('bg_cher_5', ''),
                        art ? image(api.imageSource(art), art.name, { class: 'ta-dossier-illustration', loading: 'eager' }) : el('span', { class: 'ta-art-placeholder' }, '暂无立绘'),
                        el('div', { class: 'ta-dossier-hero-label' }, el('span', { class: 'ta-kicker' }, meta?.en || item.characterId || 'OPERATOR'), el('h2', {}, item.title),
                            el('div', {}, badge(meta?.profession || '干员'), meta?.branch ? badge(meta.branch) : null, meta?.rarity ? el('span', { class: 'ta-rarity-inline' }, '★'.repeat(meta.rarity)) : null))),
                    el('div', { class: 'ta-dossier-thumbnails', 'aria-label': '切换立绘' }, item.images.map((artwork, index) => button(el('div', {}, image(api.imageSource(artwork), artwork.name), el('span', {}, /skin/.test(artwork.name) ? `时装 ${index}` : index === 0 ? '默认立绘' : '精英立绘')),
                        () => change(() => { state.artworkIndex = index; }), { class: `ta-art-thumbnail ${index === artIndex ? 'active' : ''}`, 'aria-label': `选择${artwork.name}` }))),
                    el('div', { class: 'ta-actions' }, button(active ? '从聊天移除' : '加入当前聊天', () => api.toggleCharacter(item), { class: `ta-button ${active ? '' : 'primary'}` }), button('更新资料', () => api.updateCharacter(item))),
                    art ? el('div', { class: 'ta-actions' }, link('查看原图 ↗', art.url), button(art.blob ? '此图已缓存' : '缓存当前立绘', () => api.cacheImage(item, art), { disabled: state.busy || !!art.blob })) : null,
                    hint(item.imageWarning || '立绘来自人物页，不自动发送给模型。高信赖档案与语音需主动勾选。')),
                el('article', { class: 'ta-dossier-body' },
                    el('nav', { class: 'ta-dossier-tabs', 'aria-label': '档案分区' }, TABS.map(([id, title, filter]) => button(title, () => change(() => { state.dossierTab = id; }), { class: `ta-dossier-tab ${tab[0] === id ? 'active' : ''}`, 'aria-pressed': tab[0] === id, title: `${item.sections.filter(filter).length} 个条目` }))),
                    el('div', { class: 'ta-dossier-nameplate' }, el('span', { class: 'ta-kicker' }, 'OPERATOR DOSSIER / PRTS'), el('h2', {}, item.title), hint(`${meta?.faction || ''} ${meta?.race ? ` / ${meta.race}` : ''}`)),
                    !active ? hint('当前仅查看。加入聊天后，可逐条勾选模型需要的资料；默认不开放高信赖秘密。') : null,
                    sections.length ? sections.map(section => sectionView(item, section, active)) : api.empty('本分区暂无可识别资料', '不会用 AI 生成内容补充缺失的官方档案。请通过原页核对。'),
                    tab[0] === 'basic' && item.sections.some(s => /客观履历/.test(s.title)) ? el('section', { class: 'ta-dossier-section' }, el('h3', {}, '干员简介'),
                        el('p', { class: 'ta-prose' }, item.sections.find(s => /客观履历/.test(s.title)).text)) : null,
                    item.storyLinks?.length ? el('section', { class: 'ta-dossier-section' }, el('h3', {}, '相关干员密录'), el('div', { class: 'ta-actions' }, item.storyLinks.map(l => button(l.label, () => api.openStory(l.title))))) : null,
                    hint(`资料更新：${new Date(item.fetchedAt).toLocaleString()} · 原干员和异格分别管理。`))));
    }

    function storyBrowser() {
        const category = STORY_CATEGORIES.find(c => c.id === state.storyCategory);
        const allGroups = category?.id === 'memory' ? state.memoryIndex?.groups || [] : state.storyIndex?.groups || [];
        const categoryGroups = category ? allGroups.filter(g => g.category === category.id) : [];
        const group = categoryGroups.find(g => g.id === state.storyGroup);
        const query = state.storyFilter.trim().toLowerCase();
        const filtered = categoryGroups.filter(g => !query || `${g.title} ${g.context} ${g.links.map(l => l.label).join(' ')}`.toLowerCase().includes(query));
        const card = (cat, index) => button(el('div', { class: 'ta-category-inner' }, picture(cat.background, `${cat.title}氛围背景`), el('span', { class: 'ta-paper-number' }, String(index + 1).padStart(2, '0')),
            el('div', { class: 'ta-category-caption' }, el('span', {}, cat.en), el('h3', {}, cat.title), el('p', {}, cat.description), el('b', { 'aria-hidden': 'true' }, '→'))),
        () => { state.storyCategory = cat.id; state.storyGroup = null; state.storyFilter = ''; state.storyLimit = 36; render(); api.ensureDirectory('stories'); }, { class: `ta-category-card ${cat.id === category?.id ? 'active' : ''}` });
        return el('div', { class: 'ta-story-browser' },
            el('div', { class: 'ta-directory-heading' }, titleBlock('STORIES / WIKI CHAPTER INDEX', '剧情档案', '先选择剧情分类，再进入大章节、活动或干员，最后选择具体剧情。'),
                button('刷新目录', () => api.refreshDirectory('stories'))),
            el('div', { class: 'ta-category-grid' }, STORY_CATEGORIES.map(card)),
            hint('卡片使用剧情背景作氛围图，不冒充对应章节或活动的官方封面。章节名称与入口均取自 Wiki。'),
            state.storyIndex?.classificationWarning ? el('p', { class: 'ta-warning' }, state.storyIndex.classificationWarning) : null,
            category ? el('section', { class: 'ta-story-category-content' },
                el('div', { class: 'ta-directory-toolbar' }, el('div', { class: 'ta-breadcrumbs' }, button('剧情分类', () => change(() => { state.storyCategory = ''; state.storyGroup = null; }), { class: 'ta-text-button' }),
                    el('span', {}, '/'), group ? button(category.title, () => change(() => { state.storyGroup = null; }), { class: 'ta-text-button' }) : el('strong', {}, category.title), group ? el('span', {}, `/ ${group.title}`) : null),
                    field(group ? '筛选本篇剧情入口…' : '筛选大章节、活动或人物…', state.storyFilter, value => change(() => { state.storyFilter = value; state.storyLimit = 36; }), 'chapter-filter')),
                group ? chapterEntries(group, category, query) : categoryGroups.length ? el('div', {},
                    el('div', { class: 'ta-chapter-grid' }, filtered.slice(0, state.storyLimit).map((g, index) => button(el('div', {}, picture(category.background, ''),
                        el('span', { class: 'ta-chapter-number' }, String(index + 1).padStart(2, '0')), el('div', { class: 'ta-chapter-copy' }, el('small', {}, g.context), el('h3', {}, g.title), el('span', {}, `${g.links.length} 个剧情入口`))),
                    () => change(() => { state.storyGroup = g.id; state.storyFilter = ''; }), { class: 'ta-chapter-card', 'aria-label': `打开${g.title}` }))),
                    filtered.length > state.storyLimit ? button('显示更多篇章', () => change(() => { state.storyLimit += 36; })) : null,
                    hint(`当前分类：${filtered.length} 个篇章 / 人物。编号仅为目录序号，不代表官方章号。`))
                    : api.empty(state.busy ? '正在读取分类目录' : '当前分类没有可用目录', '网络失败可刷新重试；没有数据时不会编造章节。'))
                : el('div', { class: 'ta-story-home-summary' }, el('section', {}, el('span', { class: 'ta-kicker' }, 'STORY COLLECTION'), el('h3', {}, '选择一条故事线'), hint('不再一次展开所有关卡。主线按大章节，活动与插曲按篇章，密录按人物整理。')),
                    el('section', {}, el('h3', {}, '本机最近读取'), [...records.values()].filter(r => r.kind === 'story').sort((a, b) => b.fetchedAt - a.fetchedAt).slice(0, 4).map(r => button(r.title, () => api.openStory(r.title), { class: 'ta-recent-story' })), hint('点击入口只加载这一篇，不会自动下载整章或全站剧情。'))),
            el('details', { class: 'ta-section ta-compact-import' }, el('summary', {}, '备用入口 · 直接打开剧情链接'),
                el('form', { class: 'ta-search', onsubmit: e => { e.preventDefault(); api.openStory(state.storyQuery); } }, field('具体剧情页链接', state.storyQuery, value => { state.storyQuery = value; }, 'story-query'), el('button', { type: 'submit', class: 'ta-button', disabled: state.busy }, '打开剧情'))));
    }

    function chapterEntries(group, category, query) {
        const links = group.links.filter(l => !query || `${l.title} ${l.label}`.toLowerCase().includes(query));
        return el('div', { class: 'ta-chapter-detail' },
            el('aside', { class: 'ta-chapter-description' }, picture(category.background, ''), el('div', {}, el('span', { class: 'ta-kicker' }, category.en), el('h2', {}, group.title), hint(group.context),
                el('p', {}, `${group.links.length} 个剧情入口 · 来源于 PRTS Wiki`), hint('先阅读剧情，再确认需要提供给聊天的进度。查看目录不会推进剧情。'))),
            el('div', { class: 'ta-episode-grid' }, links.map((entry, index) => button(el('div', {}, el('small', {}, String(index + 1).padStart(2, '0')),
                el('strong', {}, entry.label), el('span', {}, records.has(`story:${entry.title}`) ? '已缓存 · 打开 →' : '载入这一篇 →')),
            () => api.openStory(entry.title), { class: 'ta-episode-card', title: entry.title }))));
    }

    return {
        characters: () => state.characterOpen && records.get(state.selected)?.kind === 'character' ? dossier(records.get(state.selected)) : operatorGrid(),
        stories: () => {
            const item = records.get(state.selected);
            if (state.storyOpen && item?.kind === 'story') return el('div', {}, el('div', { class: 'ta-breadcrumbs' }, button('← 返回章节目录', () => change(() => { state.storyOpen = false; }), { class: 'ta-text-button', disabled: false }),
                el('span', {}, 'STORY / READING')), api.storyDetail(item));
            return storyBrowser();
        },
    };
}
