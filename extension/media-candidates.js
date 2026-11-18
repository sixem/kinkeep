// Identify already-rendered images using only account-owned local cache data.
// This code never fetches, navigates, scrolls, or clicks Kindroid.
(() => {
  const isId = value => typeof value === 'string' && !!value.trim() && value.length <= 2048;
  const isPlain = value => typeof value === 'string' && value.length <= 100000 && !/(?:^|:)U2FsdGVkX1[A-Za-z0-9+/=]+$/.test(value);
  function read(uid, caches, pathname, document) {
    const path = /^\/v2\/chat\/([^/]+)\/?$/.exec(pathname);
    if (!path) return [];
    let kinId; try { kinId = decodeURIComponent(path[1]); } catch { return []; }
    const scope = KinKeepCache.accountScope(uid, caches);
    if (scope.state !== 'ready' || !scope.kinIds.includes(kinId)) return [];
    const images = [...document.images].filter(img => {
      const rect = img.getBoundingClientRect(); const style = document.defaultView?.getComputedStyle(img);
      if (!img.complete || !img.naturalWidth || !img.naturalHeight || !rect.width || !rect.height || style?.display === 'none' || style?.visibility === 'hidden') return false;
      try { const url = new URL(img.currentSrc || img.src); return url.protocol === 'https:' && !url.username && !url.password && (url.hostname === 'kindroid.ai' || url.hostname.endsWith('.kindroid.ai')); } catch { return false; }
    });
    const records = new Map();
    for (const query of scope.queries) {
      const key = query?.queryKey;
      if (!Array.isArray(key) || key[0] !== 'v2' || key[1] !== 'selfies' || key[2] !== uid || key[3] !== kinId || !Array.isArray(query.state?.data)) continue;
      for (const item of query.state.data.slice(0, 1000)) {
        if (!isId(item?.id) || !Number.isFinite(item.timestamp) || item.timestamp < 1e12 || !Number.isFinite(new Date(item.timestamp).getTime()) || !isId(item.thumbnailUrl)) continue;
        const matching = images.filter(img => (img.currentSrc || img.src).endsWith(item.thumbnailUrl));
        if (matching.length !== 1) continue;
        const candidate = { kinId, kind: 'selfie', sourceId: item.id, variant: 'preview', createdAt: new Date(item.timestamp).toISOString(), url: matching[0].currentSrc || matching[0].src };
        if (isPlain(item.prompt) && item.prompt.trim()) candidate.prompt = item.prompt;
        if (isId(item.chat_message_id)) candidate.messageId = item.chat_message_id;
        const previous = records.get(candidate.sourceId);
        const signature = JSON.stringify(candidate);
        if (!previous) records.set(candidate.sourceId, {candidate, signature});
        else if (previous.signature !== signature) previous.conflict = true;
      }
    }
    const result = [...records.values()].filter(x => !x.conflict).map(x => x.candidate);
    const portraits = images.filter(img => [...(img.parentElement?.classList || [])].some(c => /_avatar-media$/.test(c)));
    if (portraits.length === 1) result.push({kinId, kind:'portrait', sourceId:'avatar', variant:'avatar', url:portraits[0].currentSrc || portraits[0].src});
    const counts = new Map(); for (const item of result) counts.set(item.url, (counts.get(item.url) || 0) + 1);
    return result.filter(item => counts.get(item.url) === 1).slice(0, 100);
  }
  globalThis.KinKeepMediaCandidates = Object.freeze({ read });
})();
