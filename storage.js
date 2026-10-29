let database;
export function openCache() {
    if (database) return database;
    database = new Promise((resolve, reject) => {
        const request = indexedDB.open('st-terra-archive-v1', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('records', { keyPath: 'id' });
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(new Error('浏览器资料缓存不可用，请检查隐私模式或存储权限。'));
        request.onblocked = () => reject(new Error('资料库被其他页面占用，请关闭其他酒馆页面后重试。'));
    });
    return database;
}

async function transaction(mode, operation) {
    const db = await openCache();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('records', mode);
        const request = operation(tx.objectStore('records'));
        let result;
        request.onsuccess = () => { result = request.result; };
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error || new Error('资料保存失败，可能是空间不足。'));
        tx.onabort = () => reject(tx.error || new Error('资料保存已取消。'));
    });
}
export const allRecords = () => transaction('readonly', store => store.getAll());
export const putRecord = record => transaction('readwrite', store => store.put(record));
export const deleteRecord = id => transaction('readwrite', store => store.delete(id));
