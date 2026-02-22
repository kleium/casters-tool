/* ═══════════════════════════════════════════════════════════
   cache.js — IndexedDB-backed event cache for instant loading
   ═══════════════════════════════════════════════════════════ */

const EventCache = (() => {
    const DB_NAME    = 'casters-tool-cache';
    const DB_VERSION = 1;
    const STORE      = 'events';

    function open() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(STORE)) {
                    db.createObjectStore(STORE, { keyPath: 'event_key' });
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror   = () => reject(req.error);
        });
    }

    async function get(eventKey) {
        try {
            const db = await open();
            return new Promise((resolve, reject) => {
                const tx = db.transaction(STORE, 'readonly');
                const req = tx.objectStore(STORE).get(eventKey);
                req.onsuccess = () => resolve(req.result || null);
                req.onerror   = () => reject(req.error);
            });
        } catch { return null; }
    }

    async function put(eventKey, data) {
        try {
            const db = await open();
            return new Promise((resolve, reject) => {
                const tx = db.transaction(STORE, 'readwrite');
                tx.objectStore(STORE).put({
                    event_key: eventKey,
                    saved_at: Date.now(),
                    data,
                });
                tx.oncomplete = () => resolve(true);
                tx.onerror    = () => reject(tx.error);
            });
        } catch { return false; }
    }

    /** Update a single tab's data in the cached entry */
    async function patchTab(eventKey, tabName, tabData) {
        try {
            const existing = await get(eventKey);
            if (!existing) return false;
            existing.data[tabName] = tabData;
            existing.saved_at = Date.now();
            return await put(eventKey, existing.data);
        } catch { return false; }
    }

    async function remove(eventKey) {
        try {
            const db = await open();
            return new Promise((resolve, reject) => {
                const tx = db.transaction(STORE, 'readwrite');
                tx.objectStore(STORE).delete(eventKey);
                tx.oncomplete = () => resolve(true);
                tx.onerror    = () => reject(tx.error);
            });
        } catch { return false; }
    }

    async function list() {
        try {
            const db = await open();
            return new Promise((resolve, reject) => {
                const tx = db.transaction(STORE, 'readonly');
                const req = tx.objectStore(STORE).getAll();
                req.onsuccess = () => resolve(
                    (req.result || []).map(r => ({
                        event_key: r.event_key,
                        saved_at: r.saved_at,
                        name: r.data?.info?.name || r.event_key,
                        status: r.data?.info?.status || '',
                        year: r.data?.info?.year || '',
                    }))
                );
                req.onerror = () => reject(req.error);
            });
        } catch { return []; }
    }

    async function clear() {
        try {
            const db = await open();
            return new Promise((resolve, reject) => {
                const tx = db.transaction(STORE, 'readwrite');
                tx.objectStore(STORE).clear();
                tx.oncomplete = () => resolve(true);
                tx.onerror    = () => reject(tx.error);
            });
        } catch { return false; }
    }

    return { get, put, patchTab, remove, list, clear };
})();
