import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from 'linkedom';
import { extractOperators, filterOperators, extractStoryDirectory, applyRetroClassification, backgroundUrl } from '../directory.js';
import { archiveFacts } from '../views.js';
globalThis.DOMParser = DOMParser;

test('reads Wiki operator index without loading individual archives', () => {
    const item = extractOperators({ title: '干员一览', html: '<div id="filter-data"><div data-zh="测试医师" data-char-id="char_test" data-profession="医疗" data-rarity="4" data-sortid="10" data-en="Test" data-logo="测试组织" data-subprofession="医师">自创测试特性</div></div>' });
    assert.equal(item.operators.length, 1);
    assert.equal(item.operators[0].rarity, 5);
    assert.equal(item.operators[0].profession, '医疗');
    assert.equal(item.operators[0].faction, '测试组织');
    assert.deepEqual(item.portraits, {});
});
test('rejects changed operator index structure', () => {
    assert.throws(() => extractOperators({ html: '<p>no data</p>' }), /目录结构发生变化/);
});
const operators = [
    { name: '阿甲', en: 'Alpha', rarity: 6, order: 1, profession: '医疗', faction: '测试地' },
    { name: '波乙', en: 'Beta', rarity: 5, order: 3, profession: '近卫', faction: '其他' },
    { name: '次丙', en: 'Gamma', rarity: 4, order: 2, profession: '医疗', faction: '测试地' },
];
test('filters professions, rarity, English names and factions', () => {
    assert.equal(filterOperators(operators, { profession: '医疗' }).length, 2);
    assert.equal(filterOperators(operators, { rarity: '6' })[0].name, '阿甲');
    assert.equal(filterOperators(operators, { query: 'BETA' })[0].name, '波乙');
    assert.equal(filterOperators(operators, { query: '测试地' }).length, 2);
});
test('sorts by actual sort IDs and rarity rather than fabricated release dates', () => {
    assert.deepEqual(filterOperators(operators, { sort: 'release-desc' }).map(o => o.order), [3, 2, 1]);
    assert.deepEqual(filterOperators(operators, { sort: 'release-asc' }).map(o => o.order), [1, 2, 3]);
    assert.deepEqual(filterOperators(operators, { sort: 'rarity-desc' }).map(o => o.rarity), [6, 5, 4]);
    assert.deepEqual(filterOperators(operators, { sort: 'rarity-asc' }).map(o => o.rarity), [4, 5, 6]);
    assert.equal(operators[0].name, '阿甲');
});
const row = (name, content) => `<tr><th class="navbox-group">${name}</th><td>${content}</td></tr>`;
const table = content => `<table><tbody>${content}</tbody></table>`;
const storyLink = (name, title) => `<a href="/w/${title}">${name}</a>`;
const root = (title, group, chapter, link) => table(`<tr><th class="navbox-title">${title}</th></tr>${row(group, table(row(chapter, link)))}`);
test('preserves main chapters and separates activity, intermezzi and special groups', () => {
    const html = root('主线剧情一览', '测试主线章', '主线', storyLink('自创剧情一', 'A/BEG'))
        + root('活动剧情一览', '支线', '测试活动', storyLink('自创剧情二', 'B/END'))
        + root('活动剧情一览', '插曲', '测试插曲', storyLink('自创剧情三', 'C/NBT'))
        + root('活动剧情一览', '特殊', '其他内容', storyLink('自创剧情四', 'D/ENTRY'));
    const result = extractStoryDirectory({ title: '剧情一览', html });
    assert.equal(result.groups.length, 4);
    assert.deepEqual(result.groups.map(g => g.category), ['main', 'events', 'intermezzi', 'other']);
    assert.equal(result.groups[0].title, '测试主线章');
    assert.equal(result.groups[0].links.length, 1);
    assert.equal(result.groups[1].title, '测试活动');
});
test('ignores non-story links and refuses an unrecognized story index', () => {
    assert.throws(() => extractStoryDirectory({ html: root('活动', '支线', '无效', '<a href="https://evil.test/A/BEG">外部</a>') }), /未能识别/);
});
test('generic activity leaf headers retain the actual event name', () => {
    const result = extractStoryDirectory({ title: '剧情一览', html: root('活动剧情一览', '测试活动', '支线', storyLink('入口', 'A/BEG')) });
    assert.equal(result.groups[0].title, '测试活动');
});
test('classifies intermezzi from game metadata, not a fabricated name list', () => {
    const directory = { groups: [{ title: '测试活动', category: 'events' }, { title: '其他活动', category: 'events' }] };
    const result = applyRetroClassification(directory, { retroActList: { test: { name: '测试活动', type: 'BRANCHLINE' } } });
    assert.equal(result.groups[0].category, 'intermezzi');
    assert.equal(result.groups[1].category, 'events');
    assert.equal(directory.groups[0].category, 'events');
});
test('archive facts come only from explicit labels', () => {
    assert.deepEqual(archiveFacts('【种族】测试族\n【身高】170cm'), [{ label: '种族', value: '测试族' }, { label: '身高', value: '170cm' }]);
    assert.deepEqual(archiveFacts('没有显式字段'), []);
});
test('background paths cannot escape their allowed asset family', () => {
    assert.equal(backgroundUrl('../evil'), '');
    assert.equal(backgroundUrl('https://evil.test'), '');
    assert.equal(backgroundUrl('bg_cher_5'), 'https://torappu.prts.wiki/assets/avg/background/bg_cher_5.png');
});
