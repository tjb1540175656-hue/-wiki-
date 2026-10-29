import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from 'linkedom';
import { extractCharacter, extractStory, extractCatalog, cleanText } from '../wiki.js';
globalThis.DOMParser = DOMParser;

// 所有夹具均为自创占位文字，不打包游戏剧情或角色档案。
const page = html => ({ title: '测试干员', html: `<html><body><div class="mw-parser-output">${html}</div></body></html>`, raw: '|干员id=char_test', revision: 123 });
const archive = '<div class="mw-heading"><h2>干员档案</h2></div><table><tr><th><div class="poem">基础档案</div></th></tr><tr><th><small>初始开放</small></th></tr><tr><td><p>姓名：测试<br>职业：医师</p></td></tr><tr><th><div class="poem">档案资料一</div></th></tr><tr><th><small>信赖开放</small></th></tr><tr><td>测试秘密<script>evil()</script></td></tr></table><div class="mw-heading"><h2>语音记录</h2></div>';
test('splits archive sections and keeps high-trust material opt-in', () => {
    const item = extractCharacter(page(archive));
    assert.equal(item.sections.length, 2);
    assert.equal(item.sections[0].basic, true);
    assert.equal(item.sections[1].basic, false);
    assert.equal(item.sections[0].id, 'archive:基础档案');
    assert.match(item.sections[0].text, /医师/);
    assert.doesNotMatch(item.sections[1].text, /evil/);
    assert.equal(item.characterId, 'char_test');
});
test('refuses non-character pages instead of inventing archives', () => {
    assert.throws(() => extractCharacter(page('<h2>普通页面</h2>')), /不是含干员档案/);
});
test('extracts modern module narratives as separate opt-in sections', () => {
    const story = '这是自创的模组测试内容。'.repeat(20);
    const item = extractCharacter(page(archive.replace('<div class="mw-heading"><h2>语音记录</h2></div>', '')
        + `<h2>模组</h2><div class="equiptemplate"><div class="equip-name-box"><b>测试模组</b></div><div class="equip-base-content">${story}</div></div><h2>语音记录</h2>`));
    const section = item.sections.find(s => s.id === 'module:测试模组');
    assert.ok(section);
    assert.equal(section.basic, false);
    assert.equal(section.text, story);
});
test('refuses changed archive structures', () => {
    assert.throws(() => extractCharacter(page('<h2>干员档案</h2><p>未识别结构</p>')), /结构发生变化/);
});
test('full-copy source retains voices beyond the old 50000-character limit', () => {
    const text = '自创语音'.repeat(14000) + '不可丢失的结尾';
    const item = extractCharacter(page(archive + `<p>${text}</p><h2>下一节</h2>`));
    const voice = item.sections.find(s => s.id === 'voice');
    assert.ok(voice.text.endsWith('不可丢失的结尾'));
    assert.ok(voice.text.length > 50000);
    assert.ok(!voice.truncated);
});
test('short module narratives are not silently omitted from all-section copy', () => {
    const item = extractCharacter(page(archive.replace('<div class="mw-heading"><h2>语音记录</h2></div>', '')
        + '<h2>模组</h2><div class="equiptemplate"><div class="equip-name-box"><b>短测试模组</b></div><div class="equip-base-content">自创短篇。</div></div><h2>语音记录</h2>'));
    assert.equal(item.sections.find(s => s.id === 'module:短测试模组').text, '自创短篇。');
});
test('extracts plain story script and ignores hidden resource databases', () => {
    const item = extractStory(page('<pre id="datas_txt">[name="测试"]一句自创台词\n[PlayMusic(key="x")]</pre><pre id="datas_char">不应进入正文</pre>'));
    assert.equal(item.entries.length, 1);
    assert.equal(item.entries[0].speaker, '测试');
    assert.equal(item.entries[0].text, '一句自创台词');
});
test('does not mistake catalog pages for a story', () => {
    assert.throws(() => extractStory(page('<a>目录</a>')), /不是具体剧情页/);
});
test('catalog filters external and maintenance links and deduplicates', () => {
    const links = extractCatalog(page('<a href="/w/A/BEG">行动前</a><a href="/w/A/BEG">重复</a><a href="/w/B/干员密录/1">密录</a><a href="https://evil.test/w/C/END">恶意</a><a href="/w/文件:图/BEG">文件</a><a href="/w/普通干员">无关</a>'));
    assert.equal(links.length, 2);
    assert.equal(links[0].title, 'A/BEG');
});
test('clean text retains line breaks but not script/style content', () => {
    const doc = new DOMParser().parseFromString('<html><body><div>一<br>二<style>bad</style><script>bad</script></div></body></html>', 'text/html');
    assert.equal(cleanText(doc.querySelector('div')), '一\n二');
});
