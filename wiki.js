import { normalizeTitle, pageUrl, parseStory, safeImageUrl } from './core.js?v=0.2.0';

const API = 'https://prts.wiki/api.php';
let queue = Promise.resolve();
let lastRequest = 0;

// 只访问固定公开 API；单并发、限速、超时，不转发凭据、不提供任意网址代理。
export function wikiRequest(params) {
    const task = queue.then(async () => {
        const wait = Math.max(0, lastRequest + 450 - Date.now());
        if (wait) await new Promise(resolve => setTimeout(resolve, wait));
        lastRequest = Date.now();
        const url = new URL(API);
        url.search = new URLSearchParams({ action: 'query', format: 'json', origin: '*', ...params });
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 25000);
        try {
            const response = await fetch(url, { credentials: 'omit', signal: controller.signal, referrerPolicy: 'no-referrer' });
            if (!response.ok) throw new Error(`PRTS 请求失败（HTTP ${response.status}），请稍后重试。`);
            const data = await response.json();
            if (data.error) throw new Error(data.error.info || 'Wiki 返回错误。');
            return data;
        } catch (error) {
            if (controller.signal.aborted) throw new Error('PRTS 访问超时，请检查网络后重试。');
            if (error instanceof TypeError) throw new Error('无法连接 PRTS。可能是网络、跨域策略或站点暂不可用；可先打开原站检查。');
            throw error;
        } finally { clearTimeout(timer); }
    });
    queue = task.catch(() => {});
    return task;
}

export async function searchCharacters(input) {
    const title = normalizeTitle(input);
    const data = await wikiRequest({ list: 'prefixsearch', pssearch: title, psnamespace: '0', pslimit: '12' });
    const candidates = (data.query?.prefixsearch || []).map(x => x.title).filter(t => !t.includes('/'));
    return [...new Set([title, ...candidates])];
}

export async function loadWikiPage(input) {
    const title = normalizeTitle(input);
    const result = await wikiRequest({ action: 'parse', page: title, prop: 'text|wikitext|revid', redirects: '1', disableeditsection: '1' });
    if (!result.parse?.text?.['*']) throw new Error('页面没有可读取的内容。');
    return { title: result.parse.title || title, html: result.parse.text['*'], raw: result.parse.wikitext?.['*'] || '', revision: result.parse.revid };
}

function parseDocument(html) {
    return new DOMParser().parseFromString(html, 'text/html');
}

export function cleanText(node) {
    const copy = node.cloneNode(true);
    copy.querySelectorAll('script,style,noscript,.mw-editsection,.reference,.noprint,button,.tooltip-content').forEach(e => e.remove());
    copy.querySelectorAll('br').forEach(e => e.replaceWith('\n'));
    copy.querySelectorAll('p,div,tr,li,h2,h3,h4').forEach(e => e.append('\n'));
    return copy.textContent.replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function fragmentFor(doc, title) {
    const headings = [...doc.querySelectorAll('h2,h3,h4')];
    const position = headings.findIndex(h => h.textContent.trim() === title);
    if (position < 0) return null;
    const heading = headings[position];
    const wrapper = h => h.parentElement?.classList.contains('mw-heading') ? h.parentElement : h;
    const next = headings.slice(position + 1).find(h => Number(h.tagName.slice(1)) <= Number(heading.tagName.slice(1)));
    // 不依赖 Range，兼容移动端与测试 DOM。
    const container = doc.createElement('div');
    let sibling = wrapper(heading).nextSibling;
    const end = next && wrapper(next);
    while (sibling && sibling !== end) { container.append(sibling.cloneNode(true)); sibling = sibling.nextSibling; }
    return container;
}

export function extractCharacter(page) {
    const doc = parseDocument(page.html);
    const archive = fragmentFor(doc, '干员档案');
    if (!archive) throw new Error('这个页面不是含干员档案的人物页。请检查名称，或在“剧情”页加载剧情角色相关内容。');
    const sections = [];
    let title = '', condition = '';
    for (const row of archive.querySelectorAll('tr')) {
        const header = row.querySelector('th .poem');
        if (header) { title = cleanText(header); condition = ''; }
        else if (row.querySelector('th small')) condition = cleanText(row.querySelector('th small'));
        const cell = row.querySelector('td');
        if (cell && title) {
            const text = cleanText(cell);
            if (text) sections.push({ id: `archive:${title}`, title, condition, text, basic: /基础档案|客观履历/.test(title) });
        }
    }
    if (!sections.length) throw new Error('档案结构发生变化，暂时无法可靠分条。请用原文链接核对，不会猜造人物资料。');
    const module = fragmentFor(doc, '模组');
    if (module) {
        const seen = new Set();
        for (const el of module.querySelectorAll('.equip-base-content, .poem')) {
            const text = cleanText(el);
            if (text.length < 120 || seen.has(text)) continue;
            seen.add(text);
            const name = el.closest('.equiptemplate')?.querySelector('.equip-name-box b')?.textContent?.trim() || '模组叙事';
            sections.push({ id: `module:${name}`, title: `${name}（模组 · 含剧透）`, text, basic: false });
        }
    }
    const voice = fragmentFor(doc, '语音记录');
    if (voice) {
        const text = cleanText(voice);
        if (text.length > 100) sections.push({ id: 'voice', title: '语音补充（可能含多语言与剧透）', text: text.slice(0, 50000), basic: false, truncated: text.length > 50000 });
    }
    const links = [...doc.querySelectorAll('a[href]')].flatMap(a => {
        try {
            const url = new URL(a.getAttribute('href'), 'https://prts.wiki');
            if (url.hostname !== 'prts.wiki' || !url.pathname.startsWith('/w/')) return [];
            const t = normalizeTitle(url.href);
            return /\/干员密录\/\d+$/.test(t) ? [{ title: t, label: a.textContent.trim() || t }] : [];
        } catch { return []; }
    });
    return {
        id: `character:${page.title}`, kind: 'character', title: page.title, source: pageUrl(page.title),
        revision: page.revision, fetchedAt: Date.now(), sections,
        characterId: /\|干员id\s*=\s*([^\r\n|}]+)/.exec(page.raw)?.[1]?.trim() || '',
        images: [], storyLinks: [...new Map(links.map(l => [l.title, l])).values()],
    };
}

export async function loadCharacter(input) {
    const page = await loadWikiPage(input);
    const item = extractCharacter(page);
    try {
        const data = await wikiRequest({ list: 'allimages', aiprefix: `立绘_${page.title.replace(/ /g, '_')}_`, ailimit: '30', aiprop: 'url|size' });
        item.images = (data.query?.allimages || []).filter(i => safeImageUrl(i.url)).map(i => ({
            name: i.name, url: safeImageUrl(i.url), width: i.width, height: i.height,
        }));
    } catch (error) { item.imageWarning = error.message; }
    return item;
}

export function extractStory(page) {
    const doc = parseDocument(page.html);
    const script = doc.querySelector('#datas_txt')?.textContent?.trim();
    if (!script) throw new Error('这不是具体剧情页。请选择“行动前 / 行动后 / 密录”等链接，或用“打开剧情目录”查找。');
    const entries = parseStory(script);
    if (!entries.some(e => e.kind === 'text')) throw new Error('未识别到剧情对白，暂不保存。');
    return { id: `story:${page.title}`, kind: 'story', title: page.title, source: pageUrl(page.title), revision: page.revision,
        fetchedAt: Date.now(), entries, images: [] };
}

export const loadStory = async input => extractStory(await loadWikiPage(input));

export function extractCatalog(page) {
    const doc = parseDocument(page.html);
    const items = [];
    for (const a of doc.querySelectorAll('.mw-parser-output a[href], body > a[href]')) {
        try {
            const href = new URL(a.getAttribute('href'), 'https://prts.wiki');
            if (href.hostname !== 'prts.wiki' || !href.pathname.startsWith('/w/')) continue;
            const title = normalizeTitle(href.href);
            if (/[：:]/.test(title) || !(/\/(?:BEG|END|NBT|ENTRY|剧情\d*|干员密录\/\d+)(?:\/[^/]+)?$/.test(title))) continue;
            const label = a.textContent.trim();
            if (label) items.push({ title, label });
        } catch { /* 不处理站外链接、文件和维护页面 */ }
    }
    return [...new Map(items.map(i => [i.title, i])).values()];
}

export const loadCatalog = async input => {
    const page = await loadWikiPage(input || '剧情一览');
    return { title: page.title, links: extractCatalog(page), source: pageUrl(page.title) };
};

export async function cacheArtwork(image) {
    const url = safeImageUrl(image.url);
    if (!url) throw new Error('图片来源不在允许列表中。');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
        const response = await fetch(url, { signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
        if (!response.ok) throw new Error(`图片下载失败：HTTP ${response.status}`);
        if (Number(response.headers.get('content-length')) > 18000000) throw new Error('图片超过 18 MB，已跳过。');
        const blob = await response.blob();
        if (blob.size > 18000000 || !/^image\/(png|jpeg|webp|gif)$/.test(blob.type)) throw new Error('图片格式或大小不支持离线缓存。');
        return blob;
    } finally { clearTimeout(timer); }
}
