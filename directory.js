import { normalizeTitle, pageUrl, safeImageUrl } from './core.js?v=0.3.0';
import { loadWikiPage, wikiRequest, cleanText } from './wiki.js?v=0.3.0';

export const PROFESSIONS = ['先锋', '近卫', '重装', '狙击', '术师', '医疗', '辅助', '特种'];
export const STORY_CATEGORIES = [
    { id: 'main', title: '主线剧情', en: 'MAIN STORY', description: '沿主线章节，追溯泰拉的脉络。', background: 'bg_cher_5' },
    { id: 'events', title: '活动剧情', en: 'SIDE STORY', description: '各地的故事与限时活动记录。', background: 'bg_churchmeadow' },
    { id: 'intermezzi', title: '插曲', en: 'INTERMEZZI', description: '按 Wiki 插曲分类收录的篇章。', background: '24_g1_snowyforest' },
    { id: 'memory', title: '干员密录', en: 'OPERATOR RECORDS', description: '以人物为入口，阅读他们的故事。', background: 'bg_infirmary' },
    { id: 'other', title: '其他剧情', en: 'OTHER STORIES', description: '特殊剧情、四月辑录与其他记录。', background: 'bg_ri_1' },
];

export function backgroundUrl(key) {
    return /^[a-z0-9_$-]+$/i.test(key || '') ? `https://torappu.prts.wiki/assets/avg/background/${encodeURIComponent(key)}.png` : '';
}

function docFor(html) { return new DOMParser().parseFromString(html, 'text/html'); }

export function extractOperators(page) {
    const doc = docFor(page.html);
    const operators = [...doc.querySelectorAll('#filter-data > [data-zh]')].flatMap(node => {
        const get = name => node.getAttribute(`data-${name}`) || '';
        const name = get('zh'), rawRarity = Number(get('rarity'));
        if (!name || !get('char-id') || !PROFESSIONS.includes(get('profession'))) return [];
        return [{ name, en: get('en'), characterId: get('char-id'), profession: get('profession'),
            branch: get('subprofession'), rarity: Number.isFinite(rawRarity) ? Math.max(1, Math.min(6, rawRarity + 1)) : 1,
            order: Number(get('sortid')) || 0, faction: get('logo') || get('nation'), race: get('race'),
            tags: get('tag'), trait: cleanText(node), source: pageUrl(name) }];
    });
    if (!operators.length) throw new Error('Wiki 干员目录结构发生变化，无法读取图鉴。请稍后重试或使用备用链接入口。');
    return { id: 'index:operators', kind: 'index', title: '干员一览', fetchedAt: Date.now(),
        revision: page.revision, operators: [...new Map(operators.map(o => [o.name, o])).values()], portraits: {} };
}

export const loadOperatorDirectory = async () => extractOperators(await loadWikiPage('干员一览'));

export function filterOperators(operators, { query = '', profession = '', rarity = '', sort = 'release-desc' } = {}) {
    const term = query.trim().toLowerCase();
    const list = operators.filter(o => (!profession || o.profession === profession) && (!rarity || o.rarity === Number(rarity))
        && (!term || [o.name, o.en, o.characterId, o.faction, o.race, o.branch, o.tags].some(value => String(value || '').toLowerCase().includes(term))));
    return list.sort((a, b) => {
        const name = a.name.localeCompare(b.name, 'zh-CN', { numeric: true });
        if (sort === 'name-asc') return name;
        if (sort === 'name-desc') return -name;
        if (sort === 'rarity-asc') return a.rarity - b.rarity || b.order - a.order || name;
        if (sort === 'rarity-desc') return b.rarity - a.rarity || b.order - a.order || name;
        return (sort === 'release-asc' ? a.order - b.order : b.order - a.order) || name;
    });
}

/** 仅查询当前页缩略图，不逐个下载全部角色档案。缺失半身像回退到头像。 */
export async function lookupPortraits(operators, mode) {
    const files = operators.flatMap(o => mode === 'avatar' ? [`头像_${o.name}.png`] : [`半身像_${o.name}_1.png`, `头像_${o.name}.png`]);
    const urls = new Map();
    for (let offset = 0; offset < files.length; offset += 50) {
        const response = await wikiRequest({ prop: 'imageinfo', titles: files.slice(offset, offset + 50).map(f => `文件:${f}`).join('|'), iiprop: 'url', iiurlwidth: '300' });
        for (const page of Object.values(response.query?.pages || {})) {
            const info = page.imageinfo?.[0];
            if (info) urls.set(page.title.replace(/^.*?:/, '').replace(/ /g, '_'), safeImageUrl(info.thumburl || info.url));
        }
    }
    return Object.fromEntries(operators.map(o => [`${mode}:${o.name}`,
        mode === 'portrait' ? urls.get(`半身像_${o.name}_1.png`) || urls.get(`头像_${o.name}.png`) || '' : urls.get(`头像_${o.name}.png`) || '']));
}

function storyLinks(container) {
    const result = [];
    for (const a of container.querySelectorAll('a[href]')) {
        try {
            const url = new URL(a.getAttribute('href'), 'https://prts.wiki');
            if (url.hostname !== 'prts.wiki' || !url.pathname.startsWith('/w/')) continue;
            const title = normalizeTitle(url.href);
            if (!/\/(?:BEG|END|NBT|ENTRY|剧情\d*|干员密录\/\d+)(?:\/[^/]+)?$/.test(title) || /[：:]/.test(title)) continue;
            result.push({ title, label: a.textContent.trim() || title });
        } catch { /* 非具体剧情入口 */ }
    }
    return [...new Map(result.map(item => [item.title, item])).values()];
}

function directHeader(row) { return [...row.children].find(c => c.tagName === 'TH' && c.classList.contains('navbox-group')); }

export function extractStoryDirectory(page) {
    const doc = docFor(page.html), groups = [];
    for (const row of doc.querySelectorAll('tr')) {
        const header = directHeader(row);
        // 只在叶子行采集，保留祖先行作为大章节/活动，不重复展开整棵子表。
        if (!header || row.querySelector('table')) continue;
        const links = storyLinks(row);
        if (!links.length) continue;
        const ancestors = [];
        let table = row.closest('table');
        const visited = new Set();
        let rootTitle = '';
        while (table && !visited.has(table)) {
            visited.add(table);
            const root = [...table.querySelectorAll('th.navbox-title')].find(th => th.closest('table') === table);
            if (root) rootTitle = root.textContent.trim();
            const parentRow = table.parentElement?.closest('tr');
            if (!parentRow) break;
            const h = directHeader(parentRow);
            if (h) ancestors.unshift(h.textContent.trim());
            table = parentRow.closest('table');
        }
        const leaf = header.textContent.trim();
        let category = /主线/.test(rootTitle) ? 'main' : 'events';
        if (ancestors.some(a => /插曲/.test(a))) category = 'intermezzi';
        else if (ancestors.some(a => /特殊|四月辑录/.test(a)) || /特殊/.test(leaf)) category = 'other';
        const title = ['主线', '支线', '剧情'].includes(leaf) ? ancestors.at(-1) || leaf : leaf;
        const context = [...ancestors, leaf].filter((s, i, a) => s && a.indexOf(s) === i);
        const key = `${category}:${rootTitle}/${context.join('/')}`;
        groups.push({ id: key, category, title, context: context.join(' / '), links });
    }
    const unique = [...new Map(groups.map(g => [g.id, g])).values()];
    if (!unique.length) throw new Error('未能识别 Wiki 的剧情分类目录，请稍后重试。');
    return { id: 'index:stories', kind: 'index', title: page.title, fetchedAt: Date.now(), revision: page.revision, groups: unique };
}

export function applyRetroClassification(directory, retro) {
    const intermezzi = new Set(Object.values(retro?.retroActList || {}).filter(a => a.type === 'BRANCHLINE' && typeof a.name === 'string').map(a => a.name));
    if (!intermezzi.size) throw new Error('常驻插曲分类数据为空。');
    return { ...directory, groups: directory.groups.map(group => group.category === 'events' && intermezzi.has(group.title)
        ? { ...group, category: 'intermezzi', context: `常驻插曲 / ${group.title}` } : group),
    classificationSource: 'https://torappu.prts.wiki/gamedata/latest/excel/retro_table.json' };
}

export async function loadStoryDirectory() {
    const directory = extractStoryDirectory(await loadWikiPage('剧情一览'));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
        // Wiki 剧情导航将插曲混列于活动；用站内公开游戏元数据识别常驻插曲，不手写名单。
        const response = await fetch('https://torappu.prts.wiki/gamedata/latest/excel/retro_table.json', { signal: controller.signal, credentials: 'omit' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return applyRetroClassification(directory, await response.json());
    } catch (error) {
        return { ...directory, classificationWarning: `常驻插曲分类暂不可用（${error.message}）；未确认的篇章保留在活动分类，可刷新重试。` };
    } finally { clearTimeout(timer); }
}

export async function loadMemoryDirectory() {
    const groups = new Map();
    for (let offset = 0; offset < 5000; offset += 500) {
        const data = await wikiRequest({ action: 'cargoquery', tables: 'char_memory', fields: '_pageName=page,storySetName,storyTxt,storyIndex', limit: '500', offset: String(offset), order_by: '_pageName,storyIndex' });
        const rows = data.cargoquery || [];
        for (const { title: row } of rows) {
            if (!row?.page || !row.storyTxt) continue;
            let title;
            try { title = normalizeTitle(row.storyTxt); } catch { continue; }
            if (!/\/干员密录\/\d+$/.test(title)) continue;
            const id = `memory:${row.page}`;
            if (!groups.has(id)) groups.set(id, { id, category: 'memory', title: row.page, context: '干员密录', links: [] });
            const item = groups.get(id);
            if (!item.links.some(l => l.title === title)) item.links.push({ title, label: row.storySetName || title });
        }
        if (rows.length < 500) break;
    }
    if (!groups.size) throw new Error('Wiki 暂未返回干员密录目录，请稍后重试。');
    return { id: 'index:memories', kind: 'index', title: '干员密录一览', fetchedAt: Date.now(), groups: [...groups.values()] };
}
