import { KEY, PROMPT_KEY, VERSION, normalizeChatState, defaultChatState, normalizeTitle, safeImageUrl, storyPath, renderEntry, parseStory, buildReference } from './core.js?v=0.3.0';
import { allRecords, putRecord, deleteRecord } from './storage.js?v=0.3.0';
import { searchCharacters, loadCharacter, loadStory, loadCatalog, cacheArtwork } from './wiki.js?v=0.3.0';
import { loadOperatorDirectory, loadStoryDirectory, loadMemoryDirectory, lookupPortraits } from './directory.js?v=0.3.0';
import { createViews } from './views.js?v=0.3.0';
import { characterText, storyText, collectCollection, copyText } from './export.js?v=0.3.0';

// 与酒馆助手脚本一样，优先挂在可访问的父页面，而非脚本所在的小 iframe。
const window = (() => {
    try { return globalThis.window.parent?.document ? globalThis.window.parent : globalThis.window; }
    catch { return globalThis.window; }
})();
const document = window.document;
const context = () => (window.SillyTavern || globalThis.SillyTavern)?.getContext?.();
const records = new Map();
const state = { tab: 'characters', selected: null, busy: false, status: '', error: '', query: '', storyQuery: '', candidates: [], catalog: null, filter: '', catalogLimit: 60,
    operatorIndex: null, storyIndex: null, memoryIndex: null,
    opQuery: '', opProfession: '', opRarity: '', opSort: 'release-desc', opMode: 'portrait', opPage: 0, opPageSize: 24, operatorToolsOpen: false, artToolsOpen: false,
    characterOpen: false, storyOpen: false, dossierTab: 'basic', artworkIndex: 0,
    storyCategory: '', storyGroup: null, storyFilter: '', storyLimit: 36 };
const directoryAttempts = new Set(), portraitPending = new Set();
let settings = { enabled: true, maxChars: 12000 };
let shadow, host, dialog, content, statusBar, lastFocus, transferSheet, downloadUrl;
let collectionController = null, collectionProgress = null;
const blobUrls = new Map();
let offEvents = [];

// 显示偏好只存当前设备（localStorage），手机和电脑可以各用各的尺寸。
const DISPLAY_KEY = 'terra-archive-display';
const clampNumber = (value, min, max, fallback) => { const n = Number(value); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback; };
function normalizeDisplay(value = {}) {
    return {
        artHeight: Number(value.artHeight) ? clampNumber(value.artHeight, 20, 95, 0) : 0,
        artZoom: clampNumber(value.artZoom, 50, 250, 100),
        artFit: value.artFit === 'cover' ? 'cover' : 'contain',
        artY: clampNumber(value.artY, 0, 100, 25),
        cardSize: Number(value.cardSize) ? clampNumber(value.cardSize, 80, 300, 0) : 0,
    };
}
let display = (() => { try { return normalizeDisplay(JSON.parse(window.localStorage.getItem(DISPLAY_KEY) || '{}')); } catch { return normalizeDisplay(); } })();
function saveDisplay(patch) {
    display = normalizeDisplay({ ...display, ...patch });
    try { window.localStorage.setItem(DISPLAY_KEY, JSON.stringify(display)); } catch { /* 隐私模式等情况下仅本次有效 */ }
    applyDisplay();
}
function adjustArt(kind, delta) {
    if (kind === 'zoom') saveDisplay({ artZoom: display.artZoom + delta });
    else if (kind === 'height') saveDisplay({ artHeight: (display.artHeight || 60) + delta });
    else if (kind === 'reset') saveDisplay({ artHeight: 0, artZoom: 100, artFit: 'contain', artY: 25 });
}
function applyDisplay() {
    if (!host) return;
    const style = host.style;
    style.setProperty('--ta-art-zoom', String(display.artZoom / 100));
    style.setProperty('--ta-art-fit', display.artFit);
    style.setProperty('--ta-art-y', `${display.artY}%`);
    style.setProperty('--ta-art-height', `${display.artHeight || 60}vh`);
    style.setProperty('--ta-card-size', `${display.cardSize || 160}px`);
    dialog?.classList.toggle('ta-custom-art-height', !!display.artHeight);
    dialog?.classList.toggle('ta-custom-card-size', !!display.cardSize);
}

function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
        if (value === undefined || value === null || value === false) continue;
        if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
        else if (key === 'class') node.className = value;
        else if (key === 'checked' || key === 'disabled' || key === 'value') node[key] = value;
        else node.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children.flat(Infinity)) {
        if (child !== null && child !== undefined && child !== false) node.append(child instanceof window.Node ? child : document.createTextNode(String(child)));
    }
    return node;
}
function button(text, action, options = {}) {
    return el('button', { type: 'button', class: 'ta-button', onclick: action, disabled: state.busy, ...options }, text);
}
const link = (text, url) => el('a', { href: url, target: '_blank', rel: 'noopener noreferrer', class: 'ta-link' }, text);
const hint = text => el('p', { class: 'ta-hint' }, text);
const badge = text => el('span', { class: 'ta-badge' }, text);

function chatId() { return context()?.getCurrentChatId?.() || ''; }
function chatState() { return chatId() ? normalizeChatState(context()?.chatMetadata?.[KEY]) : defaultChatState(); }

function saveChat(next) {
    const ctx = context();
    if (!chatId() || !ctx?.chatMetadata) { notify('请先打开一个聊天，再启用资料。', true); return false; }
    ctx.chatMetadata[KEY] = normalizeChatState(next);
    if (typeof ctx.saveMetadataDebounced === 'function') ctx.saveMetadataDebounced();
    else Promise.resolve(ctx.saveMetadata?.()).catch(e => notify(`聊天配置保存失败：${e.message}`, true));
    refreshPrompt();
    return true;
}

function saveSettings() {
    const ctx = context();
    if (!ctx?.extensionSettings) return;
    ctx.extensionSettings[KEY] = { ...settings };
    ctx.saveSettingsDebounced?.();
    refreshPrompt();
}

function reference() { return settings.enabled ? buildReference(chatState(), records, settings.maxChars) : { text: '', chars: 0, truncated: false }; }
function refreshPrompt() {
    const ctx = context();
    // 仅使用独立提示槽，不写角色卡、正文或其他记忆插件的数据。
    const text = chatId() ? reference().text : '';
    ctx?.setExtensionPrompt?.(PROMPT_KEY, text, 1, 1, false, 0, null);
    return text;
}
globalThis.terra_archive_interceptor = window.terra_archive_interceptor = () => { refreshPrompt(); };

function notify(message, error = false) {
    state.status = error ? '' : message;
    state.error = error ? message : '';
    renderStatus();
}
function renderStatus() {
    if (!statusBar) return;
    const ref = reference();
    statusBar.replaceChildren(el('span', { class: state.error ? 'ta-error' : '' , role: state.error ? 'alert' : 'status' },
        state.error || state.status || '资料仅供参考 · AI 互动不等于官方剧情'),
    el('span', {}, settings.enabled ? `本轮参考 ${ref.chars.toLocaleString()} 字符${ref.truncated ? ' · 已截断' : ''}` : '参考注入已关闭'));
    if (collectionProgress) statusBar.append(el('div', { class: 'ta-collection-progress' },
        el('span', { role: 'status' }, `${collectionProgress.group}：${collectionProgress.completed}/${collectionProgress.total} · ${collectionProgress.title}`),
        button(collectionController?.signal.aborted ? '将在当前篇完成后停止' : '停止故事集下载', () => { collectionController?.abort(); renderStatus(); },
            { disabled: !!collectionController?.signal.aborted, class: 'ta-button' })));
}

async function task(label, work) {
    if (state.busy) return;
    state.busy = true;
    state.error = '';
    state.status = label;
    render();
    try { await work(); }
    catch (error) { notify(error.message || String(error), true); console.warn('[泰拉档案馆]', error); }
    finally {
        state.busy = false; if (!state.error && state.status === label) state.status = '操作完成'; render();
        if (dialog?.open) queueMicrotask(() => ensureDirectory(state.tab));
    }
}

function ensureDirectory(tab, force = false) {
    if (state.busy) return;
    const type = tab === 'characters' ? 'operators' : tab === 'stories' ? state.storyCategory === 'memory' ? 'memories' : 'stories' : null;
    if (!type) return;
    const field = { operators: 'operatorIndex', stories: 'storyIndex', memories: 'memoryIndex' }[type];
    if (!force && (state[field] || directoryAttempts.has(type))) return;
    directoryAttempts.add(type);
    return task(`正在同步 Wiki ${type === 'operators' ? '干员图鉴' : type === 'memories' ? '干员密录目录' : '剧情分类目录'}…`, async () => {
        const item = await ({ operators: loadOperatorDirectory, stories: loadStoryDirectory, memories: loadMemoryDirectory }[type])();
        if (type === 'operators' && state.operatorIndex?.portraits) item.portraits = Object.fromEntries(Object.entries(state.operatorIndex.portraits).filter(([, value]) => value));
        await putRecord(item); state[field] = item;
        notify(type === 'operators' ? `已同步 ${item.operators.length} 位干员，点击卡片即可查看。` : `已同步 ${item.groups.length} 个篇章 / 人物目录。`);
    });
}

function ensurePortraits(operators, mode) {
    if (!state.operatorIndex) return;
    state.operatorIndex.portraits ||= {};
    const missing = operators.filter(op => !Object.hasOwn(state.operatorIndex.portraits, `${mode}:${op.name}`) && !portraitPending.has(`${mode}:${op.name}`));
    if (!missing.length) return;
    for (const op of missing) portraitPending.add(`${mode}:${op.name}`);
    queueMicrotask(async () => {
        try {
            const result = await lookupPortraits(missing, mode);
            Object.assign(state.operatorIndex.portraits, result);
            await putRecord(state.operatorIndex);
        } catch (error) {
            for (const op of missing) state.operatorIndex.portraits[`${mode}:${op.name}`] = '';
            notify(`缩略图暂不可用：${error.message}；人物卡片仍可打开，刷新图鉴可重试。`, true);
        } finally {
            for (const op of missing) portraitPending.delete(`${mode}:${op.name}`);
            if (dialog?.open) render();
        }
    });
}

async function store(item) {
    await putRecord(item);
    records.set(item.id, item);
    refreshPrompt();
}
async function fetchItem(kind, title, force = false) {
    const id = `${kind}:${normalizeTitle(title)}`;
    const cached = records.get(id);
    const item = cached && !force ? cached : await (kind === 'character' ? loadCharacter(title) : loadStory(title));
    if (item !== cached) await store(item);
    state.selected = item.id;
    state.tab = kind === 'character' ? 'characters' : 'stories';
    if (kind === 'character') { state.characterOpen = true; state.dossierTab = 'basic'; state.artworkIndex = 0; }
    else { state.storyOpen = true; state.readerPage = null; }
    notify(`${item.title} 已${item === cached ? '从本机缓存打开' : '载入'}${item.imageWarning ? '；图片列表暂未获取，可稍后更新' : ''}`);
    return item;
}

function openCharacter(title) { return task('正在载入人物档案与立绘索引…', () => fetchItem('character', title)); }
function openStory(title) { return task('正在读取剧情与选项结构…', () => fetchItem('story', title)); }

function characterSelection(id) { return chatState().characters.find(c => c.id === id); }
function toggleCharacter(item) {
    const next = chatState();
    const active = next.characters.find(c => c.id === item.id);
    if (active) next.characters = next.characters.filter(c => c.id !== item.id);
    else {
        if (next.characters.length >= 12) { notify('一个聊天最多启用 12 位人物，请先移除部分资料。', true); return; }
        next.characters.push({ id: item.id, sectionIds: item.sections.filter(s => s.basic).map(s => s.id) });
    }
    if (saveChat(next)) notify(active ? '人物已从当前聊天移除；本机缓存仍保留。' : '已加入当前聊天，默认只启用基础档案与客观履历。');
    render();
}

function chooseSection(item, sectionId, checked) {
    const next = chatState(), active = next.characters.find(c => c.id === item.id);
    if (!active) return;
    active.sectionIds = checked ? [...new Set([...active.sectionIds, sectionId])] : active.sectionIds.filter(id => id !== sectionId);
    saveChat(next);
    renderStatus();
}

function setStoryProgress(item, cursor) {
    const next = chatState();
    const existing = next.story?.id === item.id ? next.story : { id: item.id, cursor: -1, selections: {} };
    next.story = { ...existing, cursor };
    if (saveChat(next)) notify(cursor >= 0 ? '剧情参考已更新，只注入确认进度之前的最近片段。' : '剧情已关联；尚未标记已读，不会注入正文。');
    render();
}

function chooseBranch(item, entry, value) {
    const next = chatState();
    const existing = next.story?.id === item.id ? next.story : { id: item.id, cursor: -1, selections: {} };
    const selections = Object.fromEntries(Object.entries(existing.selections).filter(([id]) => Number(id) < entry.id));
    selections[entry.id] = value;
    next.story = { id: item.id, cursor: entry.id, selections };
    if (saveChat(next)) notify('选项已确认；后续选项和旧分支进度已重置。');
    render();
}

function field(placeholder, value, oninput, name) {
    return el('input', { type: 'text', placeholder, value, oninput: e => oninput(e.target.value), 'aria-label': placeholder, 'data-focus': name, autocomplete: 'off' });
}

function titleBlock(kicker, title, description) {
    return el('header', { class: 'ta-page-title' }, el('span', { class: 'ta-kicker' }, kicker), el('h2', {}, title), hint(description));
}

function recordsList(kind) {
    const list = [...records.values()].filter(r => r.kind === kind).sort((a, b) => b.fetchedAt - a.fetchedAt);
    return el('div', { class: 'ta-recent-list' }, list.length ? list.map(item => button(item.title, () => {
        state.selected = item.id; state.characterOpen = kind === 'character'; state.storyOpen = kind === 'story'; state.dossierTab = 'basic'; state.artworkIndex = 0; render();
    }, { class: `ta-record ${state.selected === item.id ? 'is-current' : ''}` })) : hint('还没有缓存。输入名称或链接，载入第一份资料。'));
}

function characterPage() {
    const search = el('form', { class: 'ta-search', onsubmit: e => { e.preventDefault(); openCharacter(state.query); } },
        field('人物名字或 PRTS 人物页链接', state.query, value => { state.query = value; }, 'character-query'),
        el('button', { class: 'ta-button primary', type: 'submit', disabled: state.busy }, '载入人物'));
    const tools = el('div', { class: 'ta-actions' }, button('查找候选', () => task('正在查找人物…', async () => {
        state.candidates = await searchCharacters(state.query); notify('请选择候选人物；异格与原干员分别管理。');
    })), button('载入当前角色', () => {
        const name = context()?.name2;
        if (!name) { notify('当前没有可识别的角色名，请手动输入。', true); return; }
        state.query = name; openCharacter(name);
    }));
    const candidates = state.candidates.length ? el('div', { class: 'ta-candidates' }, state.candidates.map(name => button(name, () => openCharacter(name)))) : null;
    const item = records.get(state.selected);
    return el('div', {}, titleBlock('OPERATOR DOSSIER', '人物档案', '输入名字即可载入，不再来回翻找 Wiki。档案与图片来源可追溯。'), search, tools, candidates,
        el('div', { class: 'ta-workspace' }, el('aside', { class: 'ta-library' }, el('h3', {}, '本机人物'), recordsList('character')),
            item?.kind === 'character' ? characterDetail(item) : empty('从一个名字开始', '试试“絮雨”或“圣聆初雪”。这里不内置任何游戏资料。')));
}

function imageSource(image) {
    if (!safeImageUrl(image.url)) return '';
    if (!(image.blob instanceof Blob)) return image.url;
    if (!blobUrls.has(image.blob)) blobUrls.set(image.blob, URL.createObjectURL(image.blob));
    return blobUrls.get(image.blob);
}

function characterDetail(item) {
    const active = characterSelection(item.id);
    const actions = el('div', { class: 'ta-actions' }, button(active ? '从聊天移除' : '加入当前聊天', () => toggleCharacter(item), { class: `ta-button ${active ? '' : 'primary'}` }),
        button('更新资料', () => task('正在更新人物资料…', async () => {
            if (!globalThis.confirm('更新将替换本机文本并重新获取图片索引。为避免新档案意外泄密，当前聊天对此人物的勾选会恢复为基础条目。继续？')) return;
            const updated = await fetchItem('character', item.title, true);
            const next = chatState(), selected = next.characters.find(c => c.id === item.id);
            if (selected) { selected.sectionIds = updated.sections.filter(s => s.basic).map(s => s.id); saveChat(next); }
        })), link('查看原页 ↗', item.source));
    const sections = item.sections.map(section => el('details', { class: 'ta-section', open: section.basic },
        el('summary', {}, el('span', {}, section.title), section.basic ? badge('基础') : badge('可选 · 可能剧透')),
        hint(section.condition || (section.basic ? '默认参考条目' : '不会自动注入，按需勾选')),
        el('label', { class: 'ta-checkbox' }, el('input', { type: 'checkbox', checked: active?.sectionIds.includes(section.id), disabled: !active || state.busy,
            onchange: e => chooseSection(item, section.id, e.target.checked) }), '供当前聊天参考'),
        el('div', { class: 'ta-prose' }, section.text), section.truncated ? hint('旧缓存内容已截断，全部复制时会尝试补读完整人物页。') : null));
    const images = el('section', { class: 'ta-section ta-artworks' }, el('h3', {}, '人物立绘'),
        hint('立绘与剧情差分不是同一类图片。本版加载此人物页的立绘与时装；不会把图片自动发给模型。'),
        item.imageWarning ? hint(item.imageWarning) : null,
        item.images.length ? el('div', { class: 'ta-art-grid' }, item.images.map(image => el('figure', {},
            el('img', { src: imageSource(image), alt: image.name, loading: 'lazy', referrerpolicy: 'no-referrer' }),
            el('figcaption', {}, image.name.replace(/^立绘_/, ''), image.blob ? badge('已缓存') : null),
            el('div', { class: 'ta-actions' }, link('原图 ↗', image.url), button(image.blob ? '已存本机' : '缓存此图', () => task('正在缓存图片，可能需要一些时间…', async () => {
                const blob = await cacheArtwork(image);
                const updated = { ...item, images: item.images.map(i => i.url === image.url ? { ...i, blob } : i) };
                await store(updated); notify('图片已存入当前浏览器，可离线查看。');
            }), { disabled: state.busy || !!image.blob }))))) : hint('没有匹配到立绘；这不代表人物没有图片，可通过原页核对。'));
    return el('article', { class: 'ta-detail' }, el('div', { class: 'ta-detail-head' }, el('div', {}, el('h3', {}, item.title), hint(`${item.characterId || '干员资料'} · ${new Date(item.fetchedAt).toLocaleString()}`)), badge(active ? '当前聊天已启用' : '仅查看')),
        actions, !active ? hint('加入聊天后才能选择注入条目。高信赖档案、模组与语音不会默认启用。') : null,
        sections, images, item.storyLinks?.length ? el('section', { class: 'ta-section' }, el('h3', {}, '人物相关密录'),
            item.storyLinks.map(l => button(l.label, () => openStory(l.title)))) : null);
}

function empty(title, text) { return el('div', { class: 'ta-empty' }, el('span', { class: 'ta-empty-symbol', 'aria-hidden': 'true' }, '◇'), el('h3', {}, title), hint(text)); }

function storyPage() {
    const search = el('form', { class: 'ta-search', onsubmit: e => { e.preventDefault(); openStory(state.storyQuery); } },
        field('剧情页链接，如 0-7 感染/BEG', state.storyQuery, value => { state.storyQuery = value; }, 'story-query'),
        el('button', { type: 'submit', class: 'ta-button primary', disabled: state.busy }, '载入剧情'));
    const tools = el('div', { class: 'ta-actions' }, button('打开剧情目录', () => task('正在读取剧情目录…', async () => {
        state.catalog = await loadCatalog('剧情一览'); state.catalogLimit = 60; notify(`目录已读取，共 ${state.catalog.links.length} 个具体剧情入口。`);
    })), button('浏览此链接的目录', () => task('正在读取页面中的剧情入口…', async () => {
        state.catalog = await loadCatalog(state.storyQuery); state.catalogLimit = 60;
        notify(state.catalog.links.length ? `找到 ${state.catalog.links.length} 个剧情入口。` : '未找到具体剧情入口，请查看原页。');
    })));
    const item = records.get(state.selected);
    return el('div', {}, titleBlock('STORY ARCHIVE', '剧情资料', '不播放动画，不调用模型改写。阅读脚本中的对白与场景，按确认进度提供参考。'), search, tools,
        state.catalog ? catalogPanel() : null,
        el('div', { class: 'ta-workspace' }, el('aside', { class: 'ta-library' }, el('h3', {}, '本机剧情'), recordsList('story')),
            item?.kind === 'story' ? storyDetail(item) : empty('连接一个剧情节点', '从目录选择具体剧情，或粘贴行动前、行动后、干员密录的链接。')));
}

function catalogPanel() {
    const list = el('div', { class: 'ta-catalog-list' });
    // replaceChildren 不接受 null，使用一层容器承载可选节点。
    const safeUpdate = () => {
        const query = state.filter.trim().toLowerCase();
        const filtered = state.catalog.links.filter(l => `${l.title} ${l.label}`.toLowerCase().includes(query));
        list.replaceChildren(el('div', {}, hint(`匹配 ${filtered.length} 条 · 已展示 ${Math.min(filtered.length, state.catalogLimit)} 条`),
            el('div', { class: 'ta-catalog-buttons' }, filtered.slice(0, state.catalogLimit).map(item => button(item.label, () => openStory(item.title), { title: item.title }))),
            filtered.length > state.catalogLimit ? button('显示更多', () => { state.catalogLimit += 60; safeUpdate(); }) : null));
    };
    safeUpdate();
    return el('details', { class: 'ta-section', open: true }, el('summary', {}, `目录 · ${state.catalog.title}`),
        field('筛选章节、关卡或人物名', state.filter, value => { state.filter = value; state.catalogLimit = 60; safeUpdate(); }, 'catalog-filter'), list);
}

function storyDetail(item) {
    const active = chatState().story;
    const current = active?.id === item.id ? active : { cursor: -1, selections: {} };
    const path = storyPath(item.entries, current.selections);
    const display = path.filter(e => e.kind !== 'cast');
    const cursor = display.findIndex(e => e.id >= current.cursor && current.cursor >= 0);
    const start = Math.max(0, Math.floor(Math.max(0, cursor) / 60) * 60);
    const pageStart = state.readerPage?.id === item.id ? state.readerPage.start : start;
    const rows = display.slice(pageStart, pageStart + 60);
    const progress = current.cursor < 0 ? '尚未确认已读' : `已确认至脚本第 ${current.cursor + 1} 行`;
    const pager = () => el('div', { class: 'ta-actions' },
        button('上一页', () => { state.readerPage = { id: item.id, start: Math.max(0, pageStart - 60) }; render(); }, { disabled: state.busy || pageStart === 0 }),
        el('span', { class: 'ta-hint' }, `${display.length ? pageStart + 1 : 0}–${Math.min(display.length, pageStart + 60)} / ${display.length} 条`),
        button('下一页', () => { state.readerPage = { id: item.id, start: pageStart + 60 }; render(); }, { disabled: state.busy || pageStart + 60 >= display.length }));
    return el('article', { class: 'ta-detail' }, el('h3', {}, item.title), hint(progress),
        el('div', { class: 'ta-actions' }, button(active?.id === item.id ? '已关联当前聊天' : '关联当前聊天', () => setStoryProgress(item, -1), { disabled: state.busy || active?.id === item.id }),
            button('复制本篇全部剧情', () => copyStory(item)),
            button('清除此剧情进度', () => { if (globalThis.confirm('清除本篇选项和已读进度？')) { const next = chatState(); if (next.story?.id === item.id) { next.story = null; saveChat(next); } state.readerPage = null; render(); } }),
            link('原文 / 完整演出 ↗', item.source)),
        hint('查看下一页不会自动推进聊天进度。点“确认至此”才会把这一位置之前的最近片段作为参考；这不是全自动剧情导演。'),
        pager(),
        el('div', { class: 'ta-story-lines' }, rows.map(entry => {
            if (entry.kind === 'choice') return el('section', { class: 'ta-choice' }, el('h4', {}, '博士的选项'), entry.options.map(option => button(option.text, () => chooseBranch(item, entry, option.value), {
                class: `ta-button ${current.selections[String(entry.id)] === option.value ? 'primary' : ''}`,
            })), hint('切换选项会清除后续分支与进度。'));
            if (entry.kind === 'unsupported') return el('section', { class: 'ta-warning', role: 'note' }, entry.text, ' 请通过原页继续；此后的内容不会自动注入。');
            if (entry.kind === 'scene') return el('div', { class: 'ta-scene' }, entry.text);
            return el('section', { class: `ta-line ${entry.id <= current.cursor ? 'is-read' : ''}` },
                el('div', { class: 'ta-line-head' }, el('strong', {}, entry.speaker || '旁白'),
                    button(entry.id === current.cursor ? '当前进度' : '确认至此', () => setStoryProgress(item, entry.id), { class: 'ta-text-button', title: `确认已读到脚本第 ${entry.line} 行` })),
                el('p', { class: 'ta-prose' }, entry.text));
        })), pager());
}

function closeTransferSheet() {
    transferSheet?.remove(); transferSheet = null;
    if (downloadUrl) { const previous = downloadUrl; window.setTimeout(() => window.URL.revokeObjectURL(previous), 60000); downloadUrl = null; }
}

function transferPanel(title) {
    closeTransferSheet();
    const box = el('section', { class: 'ta-transfer-card', role: 'dialog', 'aria-label': title },
        el('header', { class: 'ta-transfer-heading' }, el('h3', {}, title), button('关闭 ×', closeTransferSheet, { disabled: false })));
    transferSheet = el('div', { class: 'ta-transfer-sheet' }, box);
    dialog.append(transferSheet);
    return box;
}

function showManualCopy(title, text) {
    const box = transferPanel(title);
    const area = el('textarea', { class: 'ta-copy-text', readonly: true, 'aria-label': '完整待复制内容' });
    area.value = text;
    const status = hint('浏览器未允许自动复制，可点“再次复制”，或长按文本 → 全选 → 复制。');
    box.append(status, area, el('div', { class: 'ta-actions' },
        button('全选文本', () => { area.focus(); area.select(); area.setSelectionRange(0, text.length); }, { disabled: false }),
        button('再次复制', async () => {
            try { await copyText(text, { window, document, container: box }); notify(`已复制 ${text.length.toLocaleString()} 字符。`); closeTransferSheet(); }
            catch { status.textContent = '仍未获复制权限，请长按文本后全选、复制。'; area.focus(); area.select(); }
        }, { disabled: false })));
    area.focus(); area.select();
}

async function copyPrepared(title, text) {
    try {
        await copyText(text, { window, document, container: dialog });
        notify(`${title}：已复制 ${text.length.toLocaleString()} 字符，不受当前页签或注入上限限制。`);
    } catch { showManualCopy(title, text); }
}

function copyCharacter(item) {
    if (item.sections.some(s => s.truncated)) return task('旧缓存含截断内容，正在补读完整人物页…', async () => {
        const full = await loadCharacter(item.title);
        await store({ ...full, images: item.images });
        await copyPrepared('全部人物档案', characterText(full));
    });
    return copyPrepared('全部人物档案', characterText(item));
}

function copyStory(item) {
    if (!item.script) return task('正在补读本篇完整剧情脚本…', async () => {
        const full = await loadStory(item.title); await store(full);
        await copyPrepared('本篇全部剧情', storyText(full));
    });
    return copyPrepared('本篇全部剧情', storyText(item));
}

function showCollectionFile(result) {
    const box = transferPanel(result.complete ? '故事集已完整准备' : '故事集仅部分准备完成');
    const blob = new window.Blob(['\uFEFF', result.content], { type: 'text/markdown;charset=utf-8' });
    downloadUrl = window.URL.createObjectURL(blob);
    const save = el('a', { href: downloadUrl, download: result.filename, target: '_blank', rel: 'noopener', class: 'ta-button primary' }, '保存故事集文件');
    box.append(hint(`成功 ${result.success}/${result.total} 篇，失败 ${result.failed.length} 篇${result.cancelled ? '；你已停止任务' : ''}。`),
        hint(result.complete ? '文件包括该故事集目录内的全部剧情入口及分支标记，不包含图片。' : '文件名和正文已标注“部分导出”，失败或未处理篇目不会被当作已完成。'),
        el('div', { class: 'ta-actions' }, save),
        hint('已尝试自动下载。如手机没有弹出保存提示，请点击上方按钮；iOS 可在打开文件后使用“分享 → 存储到文件”。'));
    if (result.failed.length) box.append(el('details', {}, el('summary', {}, '查看失败清单'), el('ul', {}, result.failed.map(r => el('li', {}, `${r.title}：${r.error}`)))));
    save.click();
}

function downloadCollection(group) {
    const snapshot = { ...group, links: group.links.map(link => ({ ...link })) };
    return task(`正在准备故事集“${group.title}”…`, async () => {
        const controller = new window.AbortController();
        collectionController = controller;
        collectionProgress = { group: snapshot.title, completed: 0, total: snapshot.links.length, title: '开始读取' };
        renderStatus();
        try {
            const result = await collectCollection(snapshot, {
                getCached: id => records.get(id), load: loadStory, save: store, signal: controller.signal,
                onProgress: progress => { collectionProgress = { ...progress, group: snapshot.title }; renderStatus(); },
            });
            showCollectionFile(result);
            notify(result.complete ? `故事集已准备完成：${result.total} 篇。` : `故事集部分完成：成功 ${result.success}/${result.total} 篇，请查看下载说明。`);
        } finally { collectionController = null; collectionProgress = null; renderStatus(); }
    });
}

function downloadJson() {
    const data = { format: 'terra-archive', version: 1, exportedAt: new Date().toISOString(), records: [...records.values()].map(item => ({
        ...item, images: (item.images || []).map(({ blob, ...image }) => image),
    })) };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = el('a', { href: url, download: `泰拉档案馆-本机资料-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
    notify('已导出本机文本与图片来源索引；不包含图片二进制和聊天选择。请勿未经许可公开分发游戏资源。');
}

function validateRecord(value) {
    if (!value || !['character', 'story'].includes(value.kind)) throw new Error('资料类型无效。');
    const title = normalizeTitle(value.title);
    const source = new URL(value.source);
    if (source.protocol !== 'https:' || source.hostname !== 'prts.wiki') throw new Error('资料来源必须是 PRTS。');
    const common = { id: `${value.kind}:${title}`, kind: value.kind, title, source: source.href, fetchedAt: Number(value.fetchedAt) || Date.now(), revision: value.revision,
        images: (Array.isArray(value.images) ? value.images : []).slice(0, 40).filter(i => safeImageUrl(i.url)).map(i => ({ name: String(i.name || '图片').slice(0, 120), url: safeImageUrl(i.url) })) };
    if (value.kind === 'character') {
        if (!Array.isArray(value.sections) || value.sections.length > 80) throw new Error('人物档案格式不正确。');
        return { ...common, characterId: String(value.characterId || '').slice(0, 100), storyLinks: [], sections: value.sections.map((s, i) => ({
            id: String(s.id || `import-${i}`).slice(0, 100), title: String(s.title || '资料').slice(0, 160), text: String(s.text || '').slice(0, 100000), basic: s.basic === true,
            truncated: s.truncated === true || String(s.text || '').length > 100000,
        })) };
    }
    if (!Array.isArray(value.entries) || value.entries.length > 30000) throw new Error('剧情条目格式不正确。');
    let previousId = -1;
    const entries = value.entries.map((e, i) => {
        if (!Number.isSafeInteger(e.id) || e.id <= previousId || e.id > 1000000) throw new Error('剧情条目编号无效或乱序。');
        previousId = e.id;
        const base = { id: e.id, line: e.id + 1, scene: 0 };
        if (e.kind === 'text' || e.kind === 'scene' || e.kind === 'cast' || e.kind === 'unsupported') return { ...base, kind: e.kind, speaker: String(e.speaker || '').slice(0, 200), text: String(e.text || '').slice(0, 20000) };
        if (e.kind === 'choice' && Array.isArray(e.options) && e.options.length <= 30) return { ...base, kind: 'choice', options: e.options.map(o => ({ text: String(o.text).slice(0, 2000), value: String(o.value).slice(0, 100) })) };
        if (e.kind === 'predicate' && Array.isArray(e.values)) return { ...base, kind: 'predicate', values: e.values.slice(0, 30).map(v => String(v).slice(0, 100)) };
        throw new Error('剧情包含不支持的条目。');
    });
    if (typeof value.script === 'string') {
        if (value.script.length > 2000000) throw new Error('单篇原始剧情脚本过大。');
        return { ...common, script: value.script, entries: parseStory(value.script) };
    }
    return { ...common, entries };
}

async function importJson(file) {
    if (!file) return;
    if (file.size > 16000000) throw new Error('导入文件不能超过 16 MB，请分批导出。');
    const data = JSON.parse(await file.text());
    if (data.format !== 'terra-archive' || data.version !== 1 || !Array.isArray(data.records) || data.records.length > 100) throw new Error('不是本插件支持的资料备份（一次最多 100 份）。');
    const checked = data.records.map(validateRecord);
    if (checked.some(item => records.has(item.id)) && !globalThis.confirm('导入会替换同名本机资料，当前聊天所有资料勾选与剧情关联将清除以防错位。继续？')) return;
    for (const item of checked) await store(item);
    if (chatId()) saveChat(defaultChatState());
    notify(`导入完成，共 ${checked.length} 份资料。请重新选择当前聊天要启用的条目。`);
}

function libraryPage() {
    const current = chatState();
    const importInput = el('input', { type: 'file', accept: '.json,application/json', 'aria-label': '导入资料备份', onchange: e => task('正在导入资料…', () => importJson(e.target.files[0])) });
    return el('div', {}, titleBlock('LOCAL COLLECTION', '资料库与当前聊天', '缓存保存在当前设备的浏览器中。导出文本与图片索引，可在手机上导入；图片离线缓存需要分别保存。'),
        el('section', { class: 'ta-section' }, el('h3', {}, '当前聊天启用'),
            !chatId() ? hint('尚未打开聊天。') : null,
            current.characters.length ? current.characters.map(c => el('div', { class: 'ta-library-row' },
                el('span', {}, c.id.slice('character:'.length), badge(`${c.sectionIds.length} 个条目`), !records.has(c.id) ? badge('本机缺缓存') : null),
                button('移除', () => { const next = chatState(); next.characters = next.characters.filter(x => x.id !== c.id); saveChat(next); render(); }))) : hint('尚未启用人物。'),
            current.story ? el('div', { class: 'ta-library-row' }, el('span', {}, current.story.id.slice(6)), button('解除剧情关联', () => { const next = chatState(); next.story = null; saveChat(next); render(); })) : hint('尚未关联剧情。'),
            button('补载本机缺失资料', () => task('正在补载当前聊天资料…', async () => {
                const selected = chatState();
                for (const item of selected.characters) if (!records.has(item.id)) await fetchItem('character', item.id.slice(10));
                if (selected.story && !records.has(selected.story.id)) await fetchItem('story', selected.story.id.slice(6));
                notify('缺失资料补载完成。不同 Wiki 版本可能改变条目，请重新核对勾选与进度。');
            }))),
        el('section', { class: 'ta-section' }, el('h3', {}, `本机缓存 · ${records.size} 份`),
            el('div', { class: 'ta-actions' }, button('导出文本与图片索引', downloadJson)), importInput,
            hint('备份不包含图片二进制，也不自动跨设备同步。聊天选择与进度随酒馆聊天保存。'),
            [...records.values()].map(item => el('div', { class: 'ta-library-row' },
                button(item.title, () => { state.selected = item.id; state.tab = item.kind === 'character' ? 'characters' : 'stories'; state.characterOpen = item.kind === 'character'; state.storyOpen = item.kind === 'story'; state.dossierTab = 'basic'; render(); }), badge(item.kind === 'character' ? '人物' : '剧情'),
                button('删除缓存', () => task('正在删除本机缓存…', async () => {
                    if (!globalThis.confirm(`只删除本机“${item.title}”缓存？其他聊天的关联保留，但补载前不会注入缺失内容。`)) return;
                    await deleteRecord(item.id); records.delete(item.id);
                    const next = chatState(); next.characters = next.characters.filter(c => c.id !== item.id); if (next.story?.id === item.id) next.story = null;
                    if (chatId()) saveChat(next); else refreshPrompt();
                    if (state.selected === item.id) state.selected = null;
                    for (const url of blobUrls.values()) URL.revokeObjectURL(url); blobUrls.clear();
                    notify('已删除本机缓存。');
                }), { class: 'ta-button danger' })))));
}

function slider(label, value, min, max, step, unit, onchange, format = v => `${v}${unit}`) {
    const output = el('output', { class: 'ta-range-value' }, format(value));
    return el('label', { class: 'ta-range' }, el('span', {}, label), el('input', { type: 'range', min, max, step, value, 'aria-label': label,
        oninput: e => { const v = Number(e.target.value); output.textContent = format(v); onchange(v); } }), output);
}

function displaySection() {
    const auto = v => v ? null : '自动';
    return el('section', { class: 'ta-section' }, el('h3', {}, '显示设置'),
        hint('以下设置只保存在当前设备的浏览器中，手机和电脑可以分别调整，互不影响。'),
        hint('入口：输入框旁的魔棒扩展菜单 → 泰拉档案馆；也可从扩展设置中的“打开泰拉档案馆”进入。本版不再创建悬浮按钮。'),
        el('h4', {}, '人物立绘'),
        slider('立绘缩放', display.artZoom, 50, 250, 5, '%', v => saveDisplay({ artZoom: v })),
        slider('立绘区域高度', display.artHeight, 0, 95, 5, 'vh', v => saveDisplay({ artHeight: v }), v => auto(v) || `${v}% 屏高`),
        slider('立绘垂直位置', display.artY, 0, 100, 5, '%', v => saveDisplay({ artY: v }), v => v <= 10 ? `${v}%（偏上）` : v >= 90 ? `${v}%（偏下）` : `${v}%`),
        el('label', { class: 'ta-checkbox' }, el('input', { type: 'checkbox', checked: display.artFit === 'cover', onchange: e => saveDisplay({ artFit: e.target.checked ? 'cover' : 'contain' }) }), '铺满立绘区域（会裁掉部分边缘）'),
        el('h4', {}, '人物图鉴卡片'),
        slider('卡片最小宽度', display.cardSize, 0, 300, 10, 'px', v => saveDisplay({ cardSize: v }), v => auto(v) || `${v}px`),
        hint('高度、卡片宽度拖到最左即为“自动”（按屏幕大小自适应）。人物详情页立绘下方也有 ＋ / − 快捷按钮。'),
        el('div', { class: 'ta-actions' }, button('显示设置全部恢复默认', () => {
            display = normalizeDisplay(); try { window.localStorage.removeItem(DISPLAY_KEY); } catch { /* 忽略 */ }
            applyDisplay(); render();
        })));
}

function settingsPage() {
    const ctx = context();
    const supported = typeof ctx?.setExtensionPrompt === 'function';
    return el('div', {}, titleBlock('ARCHIVE CONTROL', '设置与使用说明', `泰拉档案馆 ${VERSION} · 独立扩展 · 不覆盖角色卡与柏宝书`),
        displaySection(),
        el('section', { class: 'ta-section' }, el('h3', {}, '聊天参考'),
            el('label', { class: 'ta-checkbox' }, el('input', { type: 'checkbox', checked: settings.enabled, onchange: e => { settings.enabled = e.target.checked; saveSettings(); renderStatus(); } }), '向当前聊天提供已启用的资料'),
            el('label', { class: 'ta-setting' }, '参考总上限（字符，不是 token）', el('input', { type: 'number', min: 1000, max: 30000, step: 500, value: settings.maxChars, onchange: e => {
                settings.maxChars = Math.max(1000, Math.min(30000, Number(e.target.value) || 12000)); saveSettings(); e.target.value = settings.maxChars; renderStatus();
            } })),
            hint('当前剧情片段优先，其后按加入顺序放人物资料。超过上限会明确标注截断；可移除无关档案节省上下文。'),
            hint(supported ? '酒馆参考注入接口可用。' : '没有检测到酒馆注入接口，当前只能查阅资料。请在酒馆内使用本扩展。')),
        el('section', { class: 'ta-section' }, el('h3', {}, '第一版的明确边界'),
            el('ul', {}, ...[
                '人物：输入名字或人物页链接 → 载入 → 加入当前聊天 → 勾选需要的档案。原干员与异格分开保存。',
                '剧情：从目录或具体链接载入 → 选择简单分支 → 确认至此。只注入已确认位置之前的最近片段，不会自动随聊天推进。',
                '这不是完整 AVG 执行器。复杂跳转与嵌套分支会暂停；不宣称自动识别所有游戏剧情格式。',
                '本版提供干员立绘与时装。未实装 NPC 档案、剧情表情差分、自动关联所有出场人物尚未支持。',
                '档案勾选仅控制注入条目，不是自动按章节解锁的防剧透系统。即使基础履历也可能包含后续发展，请自行核对。',
                '图片不会自动发送给模型；点击缓存后可在本机离线查看，未经缓存的图片仍需联网。',
                '文本缓存只在当前浏览器；设置与聊天关联通过酒馆保存。更换设备请导入备份或补载资料。',
                '请求只访问 PRTS 的公开接口并限速。站点不可用时不绕过限制，已有缓存仍可用。',
                '游戏文字与美术版权属于权利人；插件不内置游戏原文或素材，不提供全站批量镜像。请勿未经许可公开分发采集内容。',
            ].map(text => el('li', {}, text))), link('PRTS Wiki ↗', 'https://prts.wiki/w/首页')));
}

function render() {
    if (!content) return;
    const focused = shadow.activeElement;
    const focusKey = focused?.getAttribute?.('data-focus');
    const selection = focused?.selectionStart;
    const scroll = content.scrollTop;
    const nav = shadow.querySelector('.ta-navigation');
    nav.replaceChildren(...[
        ['characters', '01', '人物'], ['stories', '02', '剧情'], ['library', '03', '资料库'], ['settings', '04', '设置'],
    ].map(([tab, number, label]) => button([number, label].join('  '), () => { state.tab = tab; state.error = ''; content.scrollTop = 0; render(); ensureDirectory(tab); },
        { class: `ta-nav-item ${state.tab === tab ? 'active' : ''}`, 'aria-current': state.tab === tab ? 'page' : undefined, disabled: false })));
    content.replaceChildren(({ characters: directoryViews.characters, stories: directoryViews.stories, library: libraryPage, settings: settingsPage }[state.tab] || directoryViews.characters)());
    content.scrollTop = scroll;
    if (focusKey) {
        const input = [...content.querySelectorAll('[data-focus]')].find(n => n.getAttribute('data-focus') === focusKey);
        input?.focus({ preventScroll: true });
        if (typeof selection === 'number') input?.setSelectionRange?.(selection, selection);
    }
    renderStatus();
}

function openPanel() {
    if (!dialog.open) { lastFocus = document.activeElement; render(); dialog.showModal(); }
    ensureDirectory(state.tab);
}
function closePanel() { dialog.close(); lastFocus?.focus?.(); }
export function openArchive() { openPanel(); }

async function initialize() {
    if (document.getElementById('terra-archive-host')) return;
    const ctx = context();
    const saved = ctx?.extensionSettings?.[KEY];
    settings = { enabled: saved?.enabled !== false, maxChars: Math.max(1000, Math.min(30000, Number(saved?.maxChars) || 12000)) };
    host = el('div', { id: 'terra-archive-host' });
    // Shadow DOM 不保护宿主本身。隔离酒馆移动端/主题对 body 子节点的布局与隐藏规则。
    for (const [property, value] of Object.entries({
        display: 'block', position: 'fixed', inset: '0', width: 'auto', height: 'auto',
        'min-width': '0', 'min-height': '0', 'max-width': 'none', 'max-height': 'none',
        margin: '0', padding: '0', border: '0', overflow: 'visible',
        visibility: 'visible', opacity: '1', transform: 'none', filter: 'none',
        contain: 'none', 'clip-path': 'none', 'pointer-events': 'none', 'z-index': '2147483000',
    })) host.style.setProperty(property, value, 'important');
    shadow = host.attachShadow({ mode: 'open' });
    shadow.append(el('link', { rel: 'stylesheet', href: new URL(`./style.css?v=${VERSION}`, import.meta.url).href }));
    shadow.append(el('link', { rel: 'stylesheet', href: new URL(`./gallery.css?v=${VERSION}`, import.meta.url).href }));
    document.getElementById('terra-archive-launcher')?.remove();
    document.getElementById('terra-archive-launcher-style')?.remove();
    dialog = el('dialog', { class: 'ta-dialog', 'aria-labelledby': 'ta-dialog-title', oncancel: () => { lastFocus?.focus?.(); } });
    const close = button('关闭 ×', closePanel, { class: 'ta-close', disabled: false, 'aria-label': '关闭泰拉档案馆' });
    content = el('main', { class: 'ta-content', tabindex: '-1' });
    statusBar = el('footer', { class: 'ta-status' });
    dialog.append(el('div', { class: 'ta-shell' },
        el('aside', { class: 'ta-sidebar' }, el('div', { class: 'ta-brand' }, el('span', { class: 'ta-brand-mark', 'aria-hidden': 'true' }, '◇'),
            el('div', {}, el('strong', { id: 'ta-dialog-title' }, '泰拉档案馆'), el('span', {}, 'TERRA / ARCHIVE'))),
            el('nav', { class: 'ta-navigation', 'aria-label': '档案馆导航' }), el('div', { class: 'ta-sidebar-note' }, '人物 · 剧情 · 记忆线索', el('br'), `LOCAL EDITION / ${VERSION}`)),
        el('div', { class: 'ta-main' }, el('div', { class: 'ta-topbar' }, el('span', {}, 'ARKNIGHTS REFERENCE TERMINAL'), close), content, statusBar)));
    dialog.addEventListener('click', e => { if (e.target === dialog) closePanel(); });
    shadow.append(dialog);
    document.body.append(host);
    applyDisplay();
    dialog.addEventListener('cancel', event => { if (transferSheet) { event.preventDefault(); closeTransferSheet(); } });
    try {
        for (const item of await allRecords()) {
            if (item.id === 'index:operators') state.operatorIndex = item;
            else if (item.id === 'index:stories') state.storyIndex = item;
            else if (item.id === 'index:memories') state.memoryIndex = item;
            else if (item.kind === 'character' || item.kind === 'story') records.set(item.id, item);
        }
    }
    catch (error) { notify(error.message, true); }
    const eventSource = ctx?.eventSource, types = ctx?.eventTypes;
    const onChatChanged = () => {
        state.readerPage = null;
        refreshPrompt(); if (dialog.open) render();
    };
    if (eventSource && types?.CHAT_CHANGED) {
        eventSource.on(types.CHAT_CHANGED, onChatChanged);
        offEvents.push(() => eventSource.off?.(types.CHAT_CHANGED, onChatChanged));
    }
    // 保存资料的源头是本机缓存；切聊天只换关联，绝不继承上个聊天的启用项。
    refreshPrompt(); render();
    window.addEventListener('pagehide', event => {
        if (event.persisted) return;
        for (const off of offEvents) off(); offEvents = [];
        for (const url of blobUrls.values()) URL.revokeObjectURL(url);
        collectionController?.abort(); closeTransferSheet();
    }, { once: true });
}

const directoryViews = createViews({ el, button, hint, badge, link, field, state, records, render, titleBlock, empty, recordsList,
    chatState, characterSelection, toggleCharacter, chooseSection, imageSource, openCharacter, openStory, storyDetail, ensureDirectory, ensurePortraits, adjustArt,
    copyCharacter, downloadCollection,
    openDisplaySettings: () => { state.tab = 'settings'; state.error = ''; content.scrollTop = 0; render(); },
    refreshDirectory: tab => ensureDirectory(tab, true),
    updateCharacter: item => task('正在更新人物资料…', async () => {
        if (!globalThis.confirm('更新将替换本机文本与图片索引，并将当前聊天对此人物的勾选恢复为基础条目。继续？')) return;
        const updated = await fetchItem('character', item.title, true);
        const next = chatState(), selected = next.characters.find(c => c.id === item.id);
        if (selected) { selected.sectionIds = updated.sections.filter(s => s.basic).map(s => s.id); saveChat(next); }
    }),
    cacheImage: (item, image) => task('正在缓存图片…', async () => {
        const blob = await cacheArtwork(image);
        await store({ ...item, images: item.images.map(i => i.url === image.url ? { ...i, blob } : i) });
        notify('图片已存入当前浏览器，可离线查看。');
    }),
});

export const ready = (async () => {
    if (document.readyState === 'loading') await new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve, { once: true }));
    await initialize();
})();
