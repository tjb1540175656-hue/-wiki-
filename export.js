import { normalizeTitle, pageUrl } from './core.js?v=0.3.0';

const heading = text => String(text || '').replace(/[\r\n]+/g, ' ').trim();
export function filename(value) {
    return heading(value).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 120) || '泰拉档案馆导出';
}

export function characterText(item) {
    if (item.kind !== 'character') throw new Error('不是人物档案。');
    if (item.sections.some(s => s.truncated)) throw new Error('缓存含截断条目，请先更新资料再全部复制。');
    return [`# ${heading(item.title)} · 全部人物档案`, '', `来源：${item.source}`, '',
        '包含本人物页已读取的全部档案、语音补充及模组叙事，不受页签、勾选或注入上限限制。', '',
        ...item.sections.flatMap(section => [`## ${heading(section.title)}`, '', ...(section.condition ? [`开放条件：${section.condition}`, ''] : []), section.text, '']),
    ].join('\n');
}

/** 导出全部脚本条目，而不是 storyPath 的当前分支或分页结果。 */
export function storyText(item) {
    if (item.kind !== 'story') throw new Error('不是剧情资料。');
    const rawLines = item.script?.replace(/\r\n?/g, '\n').split('\n');
    const lines = [`# ${heading(item.title)}`, '', `来源：${item.source}`, '',
        '说明：按原脚本顺序提取，包含全部选项和条件分支；互斥分支并非同时发生。不执行跳转，不包含音乐、动画和图片。', ''];
    for (const entry of item.entries) {
        if (entry.kind === 'text') lines.push(entry.speaker ? `${entry.speaker}：${entry.text}` : entry.text, '');
        else if (entry.kind === 'scene') lines.push(`【${entry.text}】`, '');
        else if (entry.kind === 'choice') lines.push('【选项】', ...entry.options.map(o => `- [${o.value}] ${o.text}`), '');
        else if (entry.kind === 'predicate') lines.push(entry.values.length ? `【分支条件引用：${entry.values.join(' / ')}】` : '【条件结束 / 公共段落】', '');
        else if (entry.kind === 'unsupported') lines.push(`【原脚本控制：${rawLines?.[entry.line - 1] || entry.text}】`, '');
    }
    return lines.join('\n');
}

export async function collectCollection(group, { getCached, load, save, onProgress = () => {}, signal }) {
    const links = [...new Map(group.links.map(link => { const title = normalizeTitle(link.title); return [title, { ...link, title }]; })).values()];
    if (!links.length) throw new Error('这个故事集没有剧情入口。');
    const results = [];
    for (const [index, link] of links.entries()) {
        if (signal?.aborted) break;
        onProgress({ completed: index, total: links.length, title: link.label || link.title });
        try {
            let item = getCached(`story:${link.title}`);
            // 旧版本只有提取后的条目，重新读取一次才能核实完整脚本。
            if (!item?.script) { item = await load(link.title); await save(item); }
            results.push({ title: link.title, label: link.label || link.title, text: storyText(item), ok: true });
        } catch (error) {
            results.push({ title: link.title, label: link.label || link.title, error: error.message || String(error), ok: false });
        }
        onProgress({ completed: index + 1, total: links.length, title: link.label || link.title });
    }
    const cancelled = !!signal?.aborted && results.length < links.length;
    const failed = results.filter(r => !r.ok), success = results.filter(r => r.ok).length;
    const complete = !cancelled && !failed.length && results.length === links.length;
    const status = complete ? '完整导出' : cancelled ? '已停止 · 部分导出' : '存在失败篇目 · 部分导出';
    const content = [`# ${heading(group.title)} · 故事集`, '', `状态：${status}`, '',
        `共 ${links.length} 篇；成功 ${success} 篇；失败 ${failed.length} 篇；未处理 ${links.length - results.length} 篇。`, '',
        '目录顺序来自 Wiki。文件含分支标记，不将互斥分支当作同时发生；不包含图片或动画。', '',
        '## 目录与处理结果', '', ...links.map((link, i) => {
            const result = results[i];
            return `- ${link.label || link.title}：${!result ? '未处理' : result.ok ? '成功' : `失败：${heading(result.error)}`}`;
        }), '', ...results.flatMap(result => result.ok ? ['---', '', result.text, '']
            : [`## ${heading(result.label)} · 读取失败`, '', `来源：${pageUrl(result.title)}`, '', `错误：${result.error}`, ''])].join('\n');
    return { content, complete, cancelled, failed, success, total: links.length,
        filename: `${filename(group.title)}${complete ? '' : '-部分导出'}.md` };
}

/** HTTPS 优先使用 Clipboard API；局域网 HTTP 使用可见对话框内的传统复制。 */
export async function copyText(text, { window, document, container }) {
    let previousError;
    if (window.navigator?.clipboard?.writeText) {
        try { await window.navigator.clipboard.writeText(text); return; }
        catch (error) { previousError = error; }
    }
    const active = document.activeElement;
    const input = document.createElement('textarea');
    input.value = text; input.readOnly = true;
    input.setAttribute('aria-label', '待复制文本');
    input.style.cssText = 'position:fixed;left:8px;top:8px;width:2px;height:2px;opacity:0.01;font-size:16px;';
    container.append(input);
    try {
        input.focus(); input.select(); input.setSelectionRange(0, text.length);
        if (document.execCommand?.('copy')) return;
    } catch (error) { previousError = error; }
    finally { input.remove(); active?.focus?.({ preventScroll: true }); }
    throw new Error(previousError?.message || '浏览器未允许自动复制，请在文本框中长按全选复制。');
}
