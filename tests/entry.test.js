import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { installEntrypoints } from '../entry.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
const realm = html => parseHTML(`<html><body>${html}</body></html>`);

test('uses the same wand-menu container structure as BaiBai, without a floating button', async () => {
    const { window, document } = realm('<div id="extensionsMenu"></div><div id="extensions_settings2"></div>');
    let opened = 0;
    const entries = installEntrypoints({ window, document, onOpen: () => { opened++; }, status: () => '已就绪' });
    assert.ok(document.querySelector('#extensionsMenu > .extension_container > a.list-group-item'));
    assert.ok(document.querySelector('#terra-archive-settings-entry button'));
    assert.equal(document.querySelector('.ta-launcher'), null);
    document.getElementById('terra-archive-menu-item').click();
    await tick();
    assert.equal(opened, 1);
    assert.equal(document.getElementById('extensionsMenu').style.display, 'none');
    entries.dispose();
});
test('menu may appear late and be replaced, without missing or duplicate entries', async () => {
    const { window, document } = realm('');
    const entries = installEntrypoints({ window, document, onOpen() {} });
    const menu = document.createElement('div'); menu.id = 'extensionsMenu'; document.body.append(menu);
    await tick();
    assert.equal(menu.querySelectorAll('#terra-archive-menu-item').length, 1);
    menu.remove();
    const replacement = document.createElement('div'); replacement.id = 'extensionsMenu'; document.body.append(replacement);
    await tick(); entries.update();
    assert.equal(document.querySelectorAll('#terra-archive-menu-item').length, 1);
    entries.dispose();
});
test('module failures remain visible and actionable in settings', async () => {
    const { window, document } = realm('<div id="extensionsMenu"></div><div id="extensions_settings"></div>');
    let alert = '', state = '正在加载'; window.alert = text => { alert = text; };
    const entries = installEntrypoints({ window, document, status: () => state, onOpen: async () => { throw new Error('缺少测试模块'); } });
    state = '加载失败'; entries.update();
    assert.equal(document.querySelector('[data-terra-status]').textContent, '加载失败');
    document.querySelector('#terra-archive-settings-entry button').click();
    await tick();
    assert.match(alert, /缺少测试模块/);
    entries.dispose();
});
