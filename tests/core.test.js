import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTitle, pageUrl, safeImageUrl, parseArgs, parseStory, storyPath, normalizeChatState, buildReference } from '../core.js';

test('normalizes page names, mobile links and encoded URLs', () => {
    assert.equal(normalizeTitle(' 絮雨 '), '絮雨');
    assert.equal(normalizeTitle('https://prts.wiki/w/0-7_%E6%84%9F%E6%9F%93/BEG#章节'), '0-7 感染/BEG');
    assert.equal(normalizeTitle('https://m.prts.wiki/index.php?title=%E7%B5%AE%E9%9B%A8'), '絮雨');
    assert.match(pageUrl('测试/1'), /^https:\/\/prts.wiki\/w\//);
});
for (const input of ['http://prts.wiki/w/A', 'https://evil.test/w/A', 'https://prts.wiki.evil.test/w/A', 'https://prts.wiki:8080/w/A', '', '<script>', 'a\nb']) {
    test(`rejects unsafe input: ${input}`, () => assert.throws(() => normalizeTitle(input)));
}
test('restricts image sources', () => {
    assert.equal(safeImageUrl('javascript:alert(1)'), '');
    assert.equal(safeImageUrl('https://evil.test/image.png'), '');
    assert.equal(safeImageUrl('https://media.prts.wiki/a.png'), 'https://media.prts.wiki/a.png');
});
test('parses quoted punctuation and escaped quotes', () => {
    assert.deepEqual(parseArgs('options="A,B;C", values="1;2", value=0.5, note="a\\"b"'), { options: 'A,B;C', values: '1;2', value: '0.5', note: 'a"b' });
});
test('extracts dialogue and scenes without execution of markup', () => {
    const result = parseStory('[Background(image="room")]\r\n[name="A]B"]<img onerror="bad">\n旁白\n[PlayMusic(key="x")]');
    assert.equal(result.length, 3);
    assert.equal(result[1].speaker, 'A]B');
    assert.equal(result[1].text, '<img onerror="bad">');
    assert.equal(result[2].kind, 'text');
});
const branchScript = '[name="A"]开始\n[Decision(options="左;右", values="1;2")]\n[Predicate(references="1")]\n[name="A"]左支\n[Predicate(references="2")]\n[name="B"]右支\n[Predicate(references="")]\n结束';
test('stops at an unconfirmed decision', () => {
    const result = storyPath(parseStory(branchScript));
    assert.equal(result.length, 2);
    assert.equal(result.at(-1).kind, 'choice');
});
test('keeps mutually exclusive branches separate', () => {
    const result = storyPath(parseStory(branchScript), { 1: '2' });
    assert.equal(result.some(e => e.text === '左支'), false);
    assert.equal(result.some(e => e.text === '右支'), true);
    assert.equal(result.at(-1).text, '结束');
});
test('invalid saved choices never unlock later text', () => {
    assert.equal(storyPath(parseStory(branchScript), { 1: '9' }).at(-1).kind, 'choice');
});
test('unknown jumps and malformed commands stop interpretation', () => {
    assert.equal(storyPath(parseStory('开始\n[Goto(label="x")]\n秘密')).at(-1).kind, 'unsupported');
    assert.equal(storyPath(parseStory('[something unclosed\n秘密')).length, 1);
});
test('a predicate without a decision does not invent a branch', () => {
    const path = storyPath(parseStory('[Predicate(references="1")]\n秘密'));
    assert.equal(path.length, 1);
    assert.equal(path[0].kind, 'unsupported');
});
test('unsupported expression predicates do not become unconditional', () => {
    assert.equal(storyPath(parseStory('[Predicate(expression="x")]\n秘密')).length, 1);
});
test('nested decisions are explicitly unsupported', () => {
    const entries = parseStory('[Decision(options="A;B",values="1;2")]\n[Predicate(references="1")]\n[Decision(options="X;Y",values="3;4")]\n不应到达');
    assert.equal(storyPath(entries, { 0: '2' }).at(-1).kind, 'unsupported');
    assert.equal(storyPath(entries, { 0: '1' }).at(-1).kind, 'unsupported');
});
test('unread sentinel survives metadata normalization', () => {
    assert.equal(normalizeChatState({ story: { id: 'story:X', cursor: -1 } }).story.cursor, -1);
    assert.deepEqual(normalizeChatState(null), { characters: [], story: null });
});
test('filters malformed chat state', () => {
    assert.equal(normalizeChatState({ characters: [{ id: 'x', sectionIds: ['good', 1] }, null], story: { id: 's', selections: { a: '1', 1: '2', 2: {} } } }).characters.length, 1);
    assert.deepEqual(normalizeChatState({ story: { id: 's', selections: { a: '1', 1: '2', 2: {} } } }).story.selections, { 1: '2' });
});
const person = { id: 'character:X', kind: 'character', title: '测试人物', source: 'https://prts.wiki/w/X', sections: [{ id: 'base', title: '基础', text: '公开资料' }, { id: 'secret', title: '秘密', text: '不可默认泄露' }] };
test('injects only explicitly selected character sections', () => {
    const result = buildReference({ characters: [{ id: person.id, sectionIds: ['base'] }] }, new Map([[person.id, person]]));
    assert.match(result.text, /公开资料/);
    assert.doesNotMatch(result.text, /不可默认泄露/);
});
test('no active records means no residual injection', () => {
    assert.equal(buildReference({ characters: [] }, new Map([[person.id, person]])).text, '');
});
test('never injects future dialogue or unread story text', () => {
    const story = { id: 'story:Y', kind: 'story', title: '测试剧情', source: 'https://prts.wiki/w/Y', entries: parseStory('[name="A"]过去\n[name="B"]未来') };
    const records = new Map([[story.id, story]]);
    const next = { characters: [], story: { id: story.id, cursor: 0, selections: {} } };
    assert.match(buildReference(next, records).text, /过去/);
    assert.doesNotMatch(buildReference(next, records).text, /未来/);
    next.story.cursor = -1;
    assert.equal(buildReference(next, records).text, '');
});
test('caps prompt length and announces truncation', () => {
    const huge = { ...person, sections: [{ id: 'base', title: '基础', text: '汉字'.repeat(10000) }] };
    const result = buildReference({ characters: [{ id: huge.id, sectionIds: ['base'] }] }, new Map([[huge.id, huge]]), 1000);
    assert.equal(result.truncated, true);
    assert.ok(result.chars <= 1000);
    assert.match(result.text, /已截断/);
});
