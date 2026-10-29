import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from 'linkedom';
import { characterText, storyText, collectCollection, copyText, filename } from '../export.js';
import { parseStory } from '../core.js';

const script = '[name="测试甲"]开始\n[Decision(options="左;右",values="1;2")]\n[Predicate(references="1")]\n[name="测试甲"]左侧自创台词\n[Predicate(references="2")]\n[name="测试乙"]右侧自创台词\n[Predicate(references="")]\n[Goto(label="x")]\n[name="测试乙"]跳转之后的原文也应保留';
const story = (title = '自创剧情/BEG') => ({ kind: 'story', title, source: 'https://prts.wiki/w/test', script, entries: parseStory(script) });

test('character copy includes every section, not just the visible tab or active selections', () => {
    const text = characterText({ kind: 'character', title: '自创人物', source: 'https://prts.wiki/w/test', sections: [
        { title: '基础', text: '普通资料' }, { title: '秘密', condition: '信赖', text: '未勾选秘密' }, { title: '模组', text: '模组自创叙事' },
    ] });
    for (const part of ['普通资料', '未勾选秘密', '模组自创叙事', '开放条件：信赖']) assert.ok(text.includes(part));
});
test('copy never calls a truncated cache complete', () => {
    assert.throws(() => characterText({ kind: 'character', sections: [{ truncated: true }] }), /截断/);
});
test('story copy includes both branches, all options and text beyond unsupported flow', () => {
    const text = storyText(story());
    for (const part of ['左侧自创台词', '右侧自创台词', '[1] 左', '[2] 右', '跳转之后的原文也应保留', 'Goto(label="x")']) assert.ok(text.includes(part), part);
    assert.match(text, /互斥分支并非同时发生/);
});
test('story copy is not capped by reader pagination or prompt budget', () => {
    const item = story();
    item.entries = Array.from({ length: 140 }, (_, id) => ({ id, line: id + 1, kind: 'text', text: `自创第${id}段` }));
    assert.match(storyText(item), /自创第139段/);
});
test('safe filenames exclude path characters and line breaks', () => {
    assert.equal(filename('a/b:c?*\n'), 'a_b_c__');
    assert.ok(filename('x'.repeat(200)).length <= 120);
});
const group = { title: '自创故事集', links: [{ title: 'A/BEG', label: '甲' }, { title: 'B/END', label: '乙' }] };
test('collection preserves directory order, deduplicates links and uses complete caches', async () => {
    let loads = 0;
    const result = await collectCollection({ ...group, links: [...group.links, group.links[0]] }, {
        getCached: id => story(id.slice(6)), load: async () => { loads++; }, save: async () => {},
    });
    assert.equal(loads, 0);
    assert.equal(result.total, 2);
    assert.equal(result.complete, true);
    assert.ok(result.content.indexOf('# A/BEG') < result.content.indexOf('# B/END'));
    assert.equal(result.filename, '自创故事集.md');
});
test('collection fetches old caches without raw scripts exactly once per unique page', async () => {
    const saved = [], loaded = [];
    const result = await collectCollection(group, { getCached: () => ({ entries: [] }), load: async title => { loaded.push(title); return story(title); }, save: async item => saved.push(item.title) });
    assert.deepEqual(loaded, ['A/BEG', 'B/END']);
    assert.deepEqual(saved, loaded);
    assert.equal(result.success, 2);
});
test('collection failures are listed and never marked complete', async () => {
    const result = await collectCollection(group, { getCached: () => null, load: async title => { if (title === 'A/BEG') throw new Error('测试断网'); return story(title); }, save: async () => {} });
    assert.equal(result.complete, false);
    assert.equal(result.success, 1);
    assert.equal(result.failed.length, 1);
    assert.match(result.filename, /部分导出/);
    assert.match(result.content, /测试断网/);
});
test('cancellation stops after the current page and marks unprocessed entries', async () => {
    const controller = new AbortController(), loaded = [];
    const result = await collectCollection(group, { signal: controller.signal, getCached: () => null,
        load: async title => { loaded.push(title); return story(title); }, save: async () => {},
        onProgress: progress => { if (progress.completed === 1) controller.abort(); },
    });
    assert.deepEqual(loaded, ['A/BEG']);
    assert.equal(result.cancelled, true);
    assert.equal(result.complete, false);
    assert.match(result.content, /乙：未处理/);
});
test('clipboard uses browser API first', async () => {
    let copied = '';
    await copyText('自创复制内容', { window: { navigator: { clipboard: { writeText: async value => { copied = value; } } } } });
    assert.equal(copied, '自创复制内容');
});
test('HTTP clipboard fallback selects a textarea inside the visible dialog and cleans up', async () => {
    const document = new DOMParser().parseFromString('<html><body><div id="dialog"></div></body></html>', 'text/html');
    const originalCreate = document.createElement.bind(document), container = document.getElementById('dialog');
    let selected = false;
    document.createElement = tag => {
        const node = originalCreate(tag);
        node.select = () => { selected = true; };
        node.setSelectionRange = () => {};
        return node;
    };
    document.execCommand = command => command === 'copy' && !!container.querySelector('textarea');
    await copyText('文本', { window: { navigator: {} }, document, container });
    assert.equal(selected, true);
    assert.equal(container.querySelector('textarea'), null);
});
test('clipboard failures propagate for manual-copy UI rather than fake success', async () => {
    const document = new DOMParser().parseFromString('<html><body><div></div></body></html>', 'text/html');
    document.execCommand = () => false;
    await assert.rejects(copyText('文本', { window: { navigator: {} }, document, container: document.querySelector('div') }));
    assert.equal(document.querySelector('textarea'), null);
});
