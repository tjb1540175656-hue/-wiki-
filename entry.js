// 入口不静态依赖主界面：某个模块失败时，手机魔棒菜单仍能提供诊断。
export function installEntrypoints({ window, document, onOpen, status = () => '加载中' }) {
    const id = 'terra-archive-menu-item';
    let disposed = false;
    const activate = event => {
        event.preventDefault();
        const menu = document.getElementById('extensionsMenu');
        if (window.jQuery && menu) window.jQuery(menu).hide();
        else if (menu) menu.style.display = 'none';
        Promise.resolve().then(onOpen).catch(error => window.alert(`泰拉档案馆打开失败：\n${error.message || error}\n\n请确认仓库根目录文件完整，强制刷新后重试。`));
    };
    const sync = () => {
        if (disposed) return;
        const menu = document.getElementById('extensionsMenu');
        if (menu && !menu.querySelector(`#${id}`)) {
            const wrapper = document.createElement('div');
            wrapper.className = 'extension_container interactable';
            const a = document.createElement('a');
            a.id = id; a.className = 'list-group-item'; a.href = '#';
            a.setAttribute('role', 'button'); a.tabIndex = 0;
            const icon = document.createElement('i'); icon.className = 'fa-solid fa-book-open';
            const label = document.createElement('span'); label.textContent = '泰拉档案馆';
            a.append(icon, label);
            a.addEventListener('click', activate);
            a.addEventListener('keydown', event => { if (event.key === ' ') activate(event); });
            wrapper.append(a); menu.append(wrapper);
        }
        // 扩展设置提供第二个固定入口，兼容没有魔棒菜单的自定义酒馆主题。
        const settings = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
        if (settings && !settings.querySelector('#terra-archive-settings-entry')) {
            const box = document.createElement('div'); box.id = 'terra-archive-settings-entry'; box.className = 'extension_container';
            const button = document.createElement('button'); button.type = 'button'; button.className = 'menu_button'; button.textContent = '打开泰拉档案馆';
            button.addEventListener('click', activate);
            const note = document.createElement('small'); note.dataset.terraStatus = 'true';
            box.append(button, note); settings.append(box);
        }
        const label = status();
        const a = document.getElementById(id);
        if (a && a.title !== label) a.title = label;
        const note = document.querySelector('[data-terra-status]');
        if (note && note.textContent !== label) note.textContent = label;
    };
    sync();
    const observer = new window.MutationObserver(sync);
    observer.observe(document.body, { childList: true, subtree: true });
    return { update: sync, dispose() { disposed = true; observer.disconnect(); } };
}

function parentRealm() {
    try { return globalThis.window.parent?.document ? globalThis.window.parent : globalThis.window; }
    catch { return globalThis.window; }
}

async function start() {
    const window = parentRealm(), document = window.document;
    if (window.__terraArchiveEntry) return;
    window.__terraArchiveEntry = true;
    if (!document.body) await new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve, { once: true }));
    let status = '泰拉档案馆 0.3.0 · 主界面加载中', engine;
    const entries = installEntrypoints({ window, document, status: () => status, onOpen: async () => {
        const module = await engine;
        module.openArchive();
    } });
    globalThis.terra_archive_interceptor = window.terra_archive_interceptor ||= () => {};
    engine = import('./index.js?v=0.3.0').then(async module => {
        await module.ready;
        status = '泰拉档案馆 0.3.0 · 已就绪'; entries.update();
        return module;
    });
    engine.catch(error => {
        status = `主界面加载失败：${error.message || error}（点击入口查看）`;
        entries.update(); console.error('[泰拉档案馆] 主界面加载失败', error);
    });
    window.addEventListener('pagehide', event => { if (!event.persisted) entries.dispose(); });
}

if (typeof globalThis.window !== 'undefined' && globalThis.window.document) start().catch(console.error);
