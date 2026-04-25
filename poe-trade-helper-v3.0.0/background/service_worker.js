// Background service worker

/* ════════════════════════════════════════════════════
   IN-MEMORY STORAGE CACHE
   Loaded at startup so STORAGE_GET can respond synchronously.
   Async sendResponse (return true) is broken in WAR iframes;
   synchronous response (return false) is always reliable.
════════════════════════════════════════════════════ */
const _cache = {};
let   _cacheReady = false;

chrome.storage.local.get(null).then(data => {
  Object.assign(_cache, data);
  _cacheReady = true;

}).catch(() => { _cacheReady = true; });

/* ════════════════════════════════════════════════════
   MESSAGES FROM INJECTED PANEL
════════════════════════════════════════════════════ */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'OPEN_TAB') {
    chrome.tabs.create({ url: message.url });
    sendResponse({ success: true });
    return false;
  }

  if (message.type === 'FETCH_POBB') {
    fetchPobbBuild(message.url)
      .then(result => sendResponse({ success: true, data: result }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'EXECUTE_TRADE_SEARCH') {
    const { game, league, payload } = message.payload;
    const apiBase = game === 'poe2'
      ? 'https://www.pathofexile.com/api/trade2/search/'
      : 'https://www.pathofexile.com/api/trade/search/';
    const tradePath = game === 'poe2' ? 'trade2' : 'trade';
    const encodedLeague = encodeURIComponent(league);

    // Call trade API from SW to get search ID, then open in NEW tab
    // (navigating current tab kills the iframe/sidepanel → data wipe bug)
    fetch(`${apiBase}${encodedLeague}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(r => r.json())
      .then(data => {
        const url = data.id
          ? `https://www.pathofexile.com/${tradePath}/search/${encodedLeague}/${data.id}`
          : message.tradeUrl;
        chrome.tabs.create({ url });
      })
      .catch(() => {
        chrome.tabs.create({ url: message.tradeUrl });
      });
    sendResponse({ success: true });
    return false;
  }

  if (message.type === 'SEND_WEBHOOK') {
    fetch(message.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message.payload),
    })
      .then(res => sendResponse({ success: res.ok }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'CREATE_SEARCH_URL') {
    const league = encodeURIComponent(message.league || 'Standard');
    const apiBase = message.game === 'poe2'
      ? 'https://www.pathofexile.com/api/trade2/search/'
      : 'https://www.pathofexile.com/api/trade/search/';
    const tradePath = message.game === 'poe2' ? 'trade2' : 'trade';
    fetch(`${apiBase}${league}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message.payload),
    })
      .then(r => r.json())
      .then(data => {
        if (data.id) {
          sendResponse({ success: true, url: `https://www.pathofexile.com/${tradePath}/search/${league}/${data.id}` });
        } else {
          sendResponse({ success: false });
        }
      })
      .catch(() => sendResponse({ success: false }));
    return true;
  }

  if (message.type === 'FETCH_NINJA_RATIO') {
    const league = encodeURIComponent(message.league || 'Standard');
    const apiUrl = message.game === 'poe2'
      ? `https://poe.ninja/api/data/currency/rates?league=${league}&type=Currency&language=en`
      : `https://poe.ninja/api/data/currencyoverview?league=${league}&type=Currency&language=en`;
    fetch(apiUrl).then(r => r.json()).then(data => {
      const lines = data.lines || [];
      const divine = lines.find(l => /divine/i.test(l.currencyTypeName || ''));
      const ratio = divine?.chaosEquivalent || divine?.receive?.value || null;
      sendResponse({ success: !!ratio, ratio: ratio ? Math.round(ratio) : null });
    }).catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // ── Storage proxy ─────────────────────────────────────
  if (message.type === 'STORAGE_GET') {
    const respond = () => {
      const data = {};
      for (const k of message.keys) { if (k in _cache) data[k] = _cache[k]; }
      sendResponse({ data });
    };
    if (_cacheReady) {
      respond();
      return false; // synchronous
    }
    // Cache not ready yet — wait for storage then respond
    chrome.storage.local.get(null).then(stored => {
      if (!_cacheReady) { Object.assign(_cache, stored); _cacheReady = true; }
      respond();
    }).catch(() => { sendResponse({ data: {} }); });
    return true; // async response
  }

  if (message.type === 'STORAGE_SET') {
    Object.assign(_cache, message.data); // update cache immediately
    chrome.storage.local.set(message.data)
      .catch(() => {});
    sendResponse({ ok: true });
    return false; // MUST be synchronous — async is broken in WAR iframes
  }

  if (message.type === 'STORAGE_REMOVE') {
    for (const k of message.keys) delete _cache[k];
    chrome.storage.local.remove(message.keys).catch(() => {});
    sendResponse({ ok: true });
    return false;
  }
});

/* ════════════════════════════════════════════════════
   POBB.IN FETCH
════════════════════════════════════════════════════ */
async function fetchPobbBuild(url) {
  let buildId = url.trim();
  const match = buildId.match(/pobb\.in\/([A-Za-z0-9_\-]+)/);
  if (match) buildId = match[1];
  else buildId = buildId.replace(/^https?:\/\/[^/]+\//, '').replace(/^\//, '').split('/')[0];

  const scripted = await tryScriptPobbTab(buildId);
  if (scripted) return { buildCode: scripted, buildId };

  let html = null;
  try {
    const res = await fetch(`https://pobb.in/${buildId}`, {
      headers: { 'Accept': 'text/html,*/*;q=0.8' }
    });
    if (res.ok) html = await res.text();
  } catch (_) {}

  if (html) {
    const code = extractBuildCode(html);
    if (code) return { buildCode: code, buildId };
  }

  throw new Error('Could not extract build code. Open the pobb.in page in a tab first, or paste the raw PoB code directly.');
}

async function tryScriptPobbTab(buildId) {
  try {
    const tabs = await chrome.tabs.query({ url: `https://pobb.in/${buildId}*` });
    if (!tabs.length) return null;
    const results = await chrome.scripting.executeScript({ target: { tabId: tabs[0].id }, func: extractCodeFromPage });
    const code = results?.[0]?.result;
    return (code && isPoBCode(code)) ? code.trim() : null;
  } catch (_) { return null; }
}

function extractCodeFromPage() {
  function isPoBCode(s) {
    if (!s || s.length < 100) return false;
    const c = s.trim().replace(/[\r\n\s]/g, '');
    if (!/^[A-Za-z0-9+/=_\-]+$/.test(c)) return false;
    try {
      let b = c.replace(/-/g, '+').replace(/_/g, '/');
      const p = b.length % 4; if (p===2) b+='=='; else if(p===3) b+='=';
      return atob(b.slice(0,16)).charCodeAt(0) === 0x78;
    } catch(_){return false;}
  }
  function find(o,d){
    if(d>10||!o)return null;
    if(typeof o==='string'&&isPoBCode(o))return o.trim();
    if(typeof o!=='object')return null;
    for(const k of['code','buildCode','pobCode','content','data','build','pageProps']){
      if(o[k]){const r=find(o[k],d+1);if(r)return r;}
    }
    for(const k of Object.keys(o)){const r=find(o[k],d+1);if(r)return r;}
    return null;
  }
  // pobb.in current: textarea with aria-label
  const pobTA = document.querySelector('textarea[aria-label="Path of Building buildcode"]');
  if(pobTA){const v=pobTA.value||pobTA.textContent||'';if(isPoBCode(v))return v.trim();}
  if(window.__NEXT_DATA__){const r=find(window.__NEXT_DATA__,0);if(r)return r;}
  for(const e of document.querySelectorAll('textarea,pre,code,input[type="text"]')){
    const v=e.value||e.textContent||'';if(isPoBCode(v))return v.trim();
  }
  return null;
}

function extractBuildCode(html) {
  // pobb.in current: <textarea aria-label="Path of Building buildcode" readonly="">CODE</textarea>
  const ta = html.match(/aria-label="Path of Building buildcode"[^>]*>([A-Za-z0-9+\/=_\-]{100,})/);
  if (ta && isPoBCode(ta[1])) return ta[1];

  // Legacy __NEXT_DATA__
  const nd = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (nd) { try { const c = findInNextData(JSON.parse(nd[1])); if(c) return c; } catch(_){} }

  // Generic patterns
  const patterns = [
    /data-pob-code=["']([A-Za-z0-9+\/=_\-]{100,})["']/i,
    /"(?:code|buildCode|pobCode|content)"\s*:\s*"([A-Za-z0-9+\/=_\-]{100,})"/,
  ];
  for(const p of patterns){const m=html.match(p);if(m&&isPoBCode(m[1]))return m[1];}
  return null;
}

function findInNextData(obj, depth=0) {
  if(depth>12||!obj)return null;
  if(typeof obj==='string'&&isPoBCode(obj))return obj.trim();
  if(typeof obj!=='object')return null;
  for(const k of['code','buildCode','pobCode','content','data','build','pageProps','props','dehydratedState']){
    if(obj[k]){const r=findInNextData(obj[k],depth+1);if(r)return r;}
  }
  for(const k of Object.keys(obj)){const r=findInNextData(obj[k],depth+1);if(r)return r;}
  return null;
}

function isPoBCode(str) {
  if(!str||str.length<100)return false;
  const c=str.trim().replace(/[\r\n\s]/g,'');
  if(!/^[A-Za-z0-9+/=_\-]+$/.test(c))return false;
  try{
    let b=c.replace(/-/g,'+').replace(/_/g,'/');
    const p=b.length%4;if(p===2)b+='==';else if(p===3)b+='=';
    return atob(b.slice(0,8)).charCodeAt(0)===0x78;
  }catch(_){return false;}
}
