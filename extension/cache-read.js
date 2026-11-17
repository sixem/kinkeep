// Only reads known Kindroid storage; it does not invoke page code or network APIs.
(() => {
  function firebaseUid(storage) {
    const ids = new Set(), names = new Set();
    let matching = 0;
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (typeof key !== 'string' || !key.startsWith('firebase:authUser:')) continue;
      matching++;
      try {
        const item = JSON.parse(storage.getItem(key));
        if (typeof item?.uid !== 'string' || !item.uid) return { state: 'identity-uncertain' };
        ids.add(item.uid);
        if (typeof item.displayName === 'string' && item.displayName.trim() && item.displayName.length <= 256) names.add(item.displayName.trim());
      } catch { return { state: 'identity-uncertain' }; }
    }
    if (!matching) return { state: 'waiting' };
    if (ids.size !== 1) return { state: 'identity-uncertain' };
    return { state: 'ready', uid: [...ids][0], ...(names.size === 1 ? { displayName: [...names][0] } : {}) };
  }
  async function getAuthenticatedCaches(indexedDB) {
    // Listing first avoids creating a database when Kindroid has not made one.
    if (typeof indexedDB.databases !== 'function') throw new Error('Cache discovery is unavailable.');
    const databases = await indexedDB.databases();
    if (!databases.some(item => item.name === 'kindroid-v2')) return [];
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('kindroid-v2');
      // A database disappearing between listing and opening must not be created.
      request.onupgradeneeded = () => request.transaction.abort();
      request.onerror = () => reject(new Error('Cannot open existing Kindroid cache.'));
      request.onsuccess = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('react-query')) { db.close(); resolve([]); return; }
        try {
          const transaction = db.transaction('react-query', 'readonly');
          const read = transaction.objectStore('react-query').get('cache:authenticated');
          let value;
          read.onsuccess = () => { value = read.result; };
          transaction.oncomplete = () => { db.close(); resolve(value ? [value] : []); };
          transaction.onabort = transaction.onerror = () => { db.close(); reject(new Error('Cannot read Kindroid cache.')); };
        } catch { db.close(); reject(new Error('Cannot read Kindroid cache.')); }
      };
    });
  }
  globalThis.KinexportCache = Object.freeze({ firebaseUid, getAuthenticatedCaches });
})();
