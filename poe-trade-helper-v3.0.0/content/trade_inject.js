/**
 * PoE Build Trader - Trade Site Content Script
 */

const PANEL_WIDTH = 340;

/* ════════════════════════════════════════════════════
   EXTENSION CONTEXT GUARD
   After extension reload, old content script stays alive
   but chrome.runtime/storage calls throw "Extension context invalidated".
   Wrap all chrome API calls with this.
════════════════════════════════════════════════════ */
let _contextValid = true;

function chromeOk() {
  if (!_contextValid) return false;
  try {
    if (!chrome?.runtime?.id) { _contextValid = false; return false; }
    return true;
  } catch (_) {
    _contextValid = false;
    return false;
  }
}

/* ════════════════════════════════════════════════════
   STORAGE — content script is the owner
════════════════════════════════════════════════════ */
let _storeData   = null;
let _storeReady  = false;

if (chromeOk()) {
  chrome.storage.local.get(null).then(data => {
    _storeData  = data || {};
    _storeReady = true;
    sendStoreToIframe();
  }).catch(() => {
    _storeData  = {};
    _storeReady = true;
    sendStoreToIframe();
  });
} else {
  _storeData = {};
  _storeReady = true;
}

function sendStoreToIframe() {
  const iframe = document.getElementById('poe-bt-iframe');
  if (iframe?.contentWindow && _storeReady) {
    iframe.contentWindow.postMessage({ type: 'poe-bt-init-data', data: _storeData }, '*');
  }
}

/* ════════════════════════════════════════════════════
   PANEL INJECTION
════════════════════════════════════════════════════ */
function injectPanel() {
  if (document.getElementById('poe-bt-wrap')) return;

  const wrap = document.createElement('div');
  wrap.id = 'poe-bt-wrap';
  Object.assign(wrap.style, {
    position:     'fixed',
    top:          '0',
    right:        '0',
    height:       '100vh',
    width:        (PANEL_WIDTH + 22) + 'px',
    zIndex:       '2147483647',
    display:      'flex',
    alignItems:   'stretch',
    pointerEvents:'auto',
    transition:   'transform 0.22s cubic-bezier(0.4,0,0.2,1)',
  });

  const tab = document.createElement('button');
  tab.id = 'poe-bt-tab';
  tab.title = 'Toggle PoE Build Trader';
  tab.innerHTML = `
    <svg viewBox="0 0 28 28" width="16" height="16" style="display:block;margin:0 auto 3px">
      <defs>
        <radialGradient id="btg" cx="38%" cy="32%" r="65%">
          <stop offset="0%" stop-color="#f5e090"/>
          <stop offset="55%" stop-color="#d4a830"/>
          <stop offset="100%" stop-color="#5a3a06"/>
        </radialGradient>
      </defs>
      <polygon points="14,2 25,8 25,20 14,26 3,20 3,8" fill="url(#btg)" stroke="#e8c050" stroke-width="0.8"/>
      <circle cx="14" cy="14" r="3.5" fill="#fff8d0" opacity="0.75"/>
    </svg>
    <span id="poe-bt-arrow" style="font-size:10px;line-height:1;color:#c8a030;">▶</span>
  `;
  Object.assign(tab.style, {
    width:          '22px',
    flexShrink:     '0',
    alignSelf:      'center',
    height:         '80px',
    background:     'linear-gradient(180deg,#1c1408 0%,#100c04 100%)',
    border:         '1px solid #4a3418',
    borderRight:    'none',
    borderRadius:   '4px 0 0 4px',
    cursor:         'pointer',
    display:        'flex',
    flexDirection:  'column',
    alignItems:     'center',
    justifyContent: 'center',
    gap:            '4px',
    padding:        '0',
    pointerEvents:  'auto',
    boxShadow:      '-2px 0 8px rgba(0,0,0,0.5)',
  });

  const iframe = document.createElement('iframe');
  iframe.id    = 'poe-bt-iframe';
  const _isPoe2 = /\/trade2(\/|$)/.test(window.location.pathname);
  iframe.src   = chrome.runtime.getURL('sidepanel/sidepanel.html') + '?game=' + (_isPoe2 ? 'poe2' : 'poe1');
  iframe.allow = 'storage-access';
  Object.assign(iframe.style, {
    width:        PANEL_WIDTH + 'px',
    height:       '100%',
    border:       'none',
    flexShrink:   '0',
    display:      'block',
    pointerEvents:'auto',
    boxShadow:    '-4px 0 16px rgba(0,0,0,0.6)',
  });

  wrap.appendChild(tab);
  wrap.appendChild(iframe);
  document.documentElement.appendChild(wrap);

  const style = document.createElement('style');
  style.textContent = 'dialog::backdrop { pointer-events: none !important; }';
  document.documentElement.appendChild(style);

  if (chromeOk()) {
    chrome.storage.local.get('poe_bt_panel_open', ({ poe_bt_panel_open }) => {
      setPanelVisible(poe_bt_panel_open !== false, false);
    });
  } else {
    setPanelVisible(true, false);
  }

  tab.addEventListener('click', togglePanel);

  iframe.addEventListener('load', () => {
    postUrlToPanel();
    sendStoreToIframe();
  });

  window.addEventListener('message', (e) => {
    try {
      if (e.data === 'poe-bt-hide')        { setPanelVisible(false, true); return; }
      if (e.data === 'poe-bt-request-url') { postUrlToPanel(); return; }
      if (e.data === 'poe-bt-request-data') { sendStoreToIframe(); return; }
      if (e.data === 'poe-bt-request-search-name') {
        const iframe = document.getElementById('poe-bt-iframe');
        if (iframe?.contentWindow) {
          iframe.contentWindow.postMessage({ type: 'poe-bt-search-name', name: getSearchName() }, '*');
        }
        return;
      }

      // Clipboard — WAR iframes can't use Clipboard API
      if (e.data?.type === 'poe-bt-copy' && e.data.text) {
        navigator.clipboard.writeText(e.data.text).catch(() => {});
        return;
      }

      if (e.data?.type === 'poe-bt-open-tab' && e.data.url) {
        if (chromeOk()) chrome.runtime.sendMessage({ type: 'OPEN_TAB', url: e.data.url });
        return;
      }

      // Storage writes from iframe
      if (e.data?.type === 'poe-bt-store-set' && e.data.data) {
        Object.assign(_storeData, e.data.data);
        if (chromeOk()) chrome.storage.local.set(e.data.data).catch(() => {});
        return;
      }
      if (e.data?.type === 'poe-bt-store-remove' && e.data.keys) {
        for (const k of e.data.keys) delete _storeData[k];
        if (chromeOk()) chrome.storage.local.remove(e.data.keys).catch(() => {});
        return;
      }
      if (e.data?.type === 'poe-bt-store-set-kv') {
        if (chromeOk()) chrome.storage.local.set(e.data.data).catch(() => {});
        return;
      }

      // JSON export — scrape visible trade results
      if (e.data === 'poe-bt-request-json-export') {
        const results = scrapeTradeResults();
        const blob = new Blob([JSON.stringify(results, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = 'trade-results.json'; a.click();
        URL.revokeObjectURL(url);
        return;
      }
    } catch (_) {
      _contextValid = false;
    }
  });
}

/* ════════════════════════════════════════════════════
   PANEL VISIBILITY
════════════════════════════════════════════════════ */
let _panelVisible = true;

function setPanelVisible(visible, save) {
  _panelVisible = visible;
  const wrap  = document.getElementById('poe-bt-wrap');
  const arrow = document.getElementById('poe-bt-arrow');
  if (!wrap) return;
  if (visible) {
    wrap.style.transform = 'translateX(0)';
    if (arrow) arrow.textContent = '▶';
    applyBodyMargin();
  } else {
    wrap.style.transform = `translateX(${PANEL_WIDTH}px)`;
    if (arrow) arrow.textContent = '◀';
    document.body.style.marginRight = '22px';
  }
  if (save && chromeOk()) {
    chrome.storage.local.set({ poe_bt_panel_open: visible }).catch(() => {});
  }
}

function togglePanel() { setPanelVisible(!_panelVisible, true); }

function applyBodyMargin() {
  if (_panelVisible && document.body) {
    document.body.style.marginRight = PANEL_WIDTH + 'px';
    document.body.style.transition  = 'margin-right 0.22s cubic-bezier(0.4,0,0.2,1)';
  }
}

function postUrlToPanel() {
  try {
    const iframe = document.getElementById('poe-bt-iframe');
    if (iframe?.contentWindow) {
      iframe.contentWindow.postMessage({ type: 'poe-bt-url', url: window.location.href }, '*');
    }
  } catch (_) {}
}

/* ════════════════════════════════════════════════════
   SPA NAVIGATION
════════════════════════════════════════════════════ */
const _origPush    = history.pushState.bind(history);
const _origReplace = history.replaceState.bind(history);

history.pushState = function(...a) {
  _origPush(...a);
  setTimeout(() => { postUrlToPanel(); applyBodyMargin(); }, 0);
};
history.replaceState = function(...a) {
  _origReplace(...a);
  setTimeout(postUrlToPanel, 0);
};
window.addEventListener('popstate', () => { postUrlToPanel(); applyBodyMargin(); });

/* ════════════════════════════════════════════════════
   BFCACHE
════════════════════════════════════════════════════ */
window.addEventListener('pageshow', e => {
  if (!e.persisted) return;
  const iframe = document.getElementById('poe-bt-iframe');
  if (iframe) {
    iframe.src = iframe.src;
    iframe.addEventListener('load', () => { postUrlToPanel(); sendStoreToIframe(); }, { once: true });
  } else {
    injectPanel();
  }
  applyBodyMargin();
});

/* ════════════════════════════════════════════════════
   WHISPER / HIDEOUT TRACKER (2-minute countdown)
════════════════════════════════════════════════════ */
const trackerStyle = document.createElement('style');
trackerStyle.textContent = `
  .poe-bt-tracker {
    display: none;
    font-size: 12px;
    font-weight: bold;
    line-height: 1;
    padding: 2px 5px;
    margin-left: 4px;
    color: #ff6666;
    background: rgba(180,30,30,0.15);
    border: 1px solid rgba(180,30,30,0.4);
    border-radius: 3px;
    vertical-align: middle;
    font-family: monospace;
    white-space: nowrap;
    animation: poe-bt-tracker-in 0.2s ease-out;
  }
  .poe-bt-tracker.active {
    display: inline-block;
  }
  @keyframes poe-bt-tracker-in {
    from { opacity: 0; transform: scale(0.8); }
    to   { opacity: 1; transform: scale(1); }
  }
`;

function initWhisperTracker() {
  document.documentElement.appendChild(trackerStyle);
  const observer = new MutationObserver(mutations => {
    for (const mut of mutations)
      for (const node of mut.addedNodes)
        if (node.nodeType === 1) tryInjectTracker(node);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  scanForListings(document.body);
}

function scanForListings(root) {
  if (!root.querySelectorAll) return;
  const candidates = root.querySelectorAll([
    '[class*="itemResult"]','[class*="item-result"]',
    '[class*="resultItem"]','[class*="listing"]','.item',
  ].join(','));
  candidates.forEach(tryInjectTracker);
}

function getSellerName(el) {
  const a = el.querySelector('a[href*="/account/view-profile/"]');
  return a?.textContent?.trim() || 'Unknown Seller';
}

function tryInjectTracker(el) {
  if (!el.querySelectorAll || el.dataset.btTrack) return;
  const whisperBtn = el.querySelector([
    'button[class*="whisper"]','button[class*="direct"]',
    'button[title*="whisper" i]','button[title*="hideout" i]',
    '[class*="btn-whisper"]','[class*="direct-btn"]','a[href*="whisper"]',
  ].join(','));
  if (!whisperBtn) return;
  el.dataset.btTrack = '1';

  const seller = getSellerName(el);

  // Create tracker indicator (hidden until whisper/hideout clicked)
  const tracker = document.createElement('span');
  tracker.className = 'poe-bt-tracker';
  whisperBtn.insertAdjacentElement('afterend', tracker);

  // Resume cooldown if this seller has an active one from before reload
  if (chromeOk()) {
    chrome.storage.local.get('activeCooldowns', ({ activeCooldowns }) => {
      const cooldowns = activeCooldowns || {};
      const entry = cooldowns[seller];
      if (entry) {
        const remaining = Math.floor((entry.startTs + 120000 - Date.now()) / 1000);
        if (remaining > 0) startTracker(tracker, seller, remaining);
        else { delete cooldowns[seller]; chrome.storage.local.set({ activeCooldowns: cooldowns }); }
      }
    });
  }

  // Start 2-minute countdown when whisper/hideout is clicked
  whisperBtn.addEventListener('click', () => {
    startTracker(tracker, seller, 120);
    // Push seller to whisper queue in storage
    if (chromeOk()) {
      try {
        chrome.storage.local.get('whisperQueue', ({ whisperQueue }) => {
          const queue = whisperQueue || [];
          queue.unshift({ seller, ts: Date.now(), noResponse: false });
          if (queue.length > 50) queue.length = 50;
          chrome.storage.local.set({ whisperQueue: queue });
        });
      } catch (_) {}
    }
  }, { capture: true });
}

function startTracker(tracker, seller, initialRemaining = 120) {
  // Clear any existing timer
  if (tracker._timerId) clearInterval(tracker._timerId);

  // Persist cooldown start so reload can resume
  if (chromeOk()) {
    chrome.storage.local.get('activeCooldowns', ({ activeCooldowns }) => {
      const cooldowns = activeCooldowns || {};
      cooldowns[seller] = { startTs: Date.now() - (120 - initialRemaining) * 1000 };
      chrome.storage.local.set({ activeCooldowns: cooldowns });
    });
  }

  let remaining = initialRemaining;
  tracker.classList.add('active');
  const fmt = r => `✕ ${Math.floor(r/60)}:${String(r%60).padStart(2,'0')}`;
  tracker.textContent = fmt(remaining);

  tracker._timerId = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      clearInterval(tracker._timerId);
      tracker._timerId = null;
      tracker.classList.remove('active');
      tracker.textContent = '';
      // Remove from persisted cooldowns
      if (chromeOk()) {
        chrome.storage.local.get('activeCooldowns', ({ activeCooldowns }) => {
          const cooldowns = activeCooldowns || {};
          delete cooldowns[seller];
          chrome.storage.local.set({ activeCooldowns: cooldowns });
        });
      }
      return;
    }
    tracker.textContent = fmt(remaining);
  }, 1000);
}

/* ════════════════════════════════════════════════════
   MESSAGES FROM PANEL
════════════════════════════════════════════════════ */
if (chromeOk()) {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'GET_SEARCH_NAME') {
      sendResponse({ name: getSearchName() });
      return false;
    }
  });
}

function getSearchName() {
  const selectors = [
    'input[placeholder*="name" i]','input[placeholder*="item" i]',
    'input[name*="name" i]','.filter-name input[type="text"]',
    '[class*="name"] input[type="text"]',
  ];
  for (const sel of selectors) {
    try {
      for (const inp of document.querySelectorAll(sel)) {
        if (inp.value?.trim()) return inp.value.trim();
      }
    } catch (_) {}
  }
  return '';
}

/* ════════════════════════════════════════════════════
   SCRAPE TRADE RESULTS (for JSON export)
════════════════════════════════════════════════════ */
function scrapeTradeResults() {
  const rows = document.querySelectorAll('[class*="result"], [class*="row"], .resultset > div');
  const results = [];
  for (const row of rows) {
    try {
      const nameEl = row.querySelector('[class*="itemName"], [class*="name"], .item a');
      const priceEl = row.querySelector('[class*="price"], [data-field="price"]');
      const sellerEl = row.querySelector('[class*="seller"], [class*="account"]');
      if (!nameEl && !priceEl) continue;
      results.push({
        name: nameEl?.textContent?.trim() || '',
        price: priceEl?.textContent?.trim() || '',
        seller: sellerEl?.textContent?.trim() || '',
      });
    } catch (_) {}
  }
  return { exported: new Date().toISOString(), count: results.length, results };
}

/* ════════════════════════════════════════════════════
   BOOT
════════════════════════════════════════════════════ */
(async function () {
  try {
    if (!chromeOk()) return;
    await waitForPageLoad();
    injectPanel();
    initWhisperTracker();
  } catch (e) {
    if (/Extension context invalidated/.test(e.message)) {
      _contextValid = false;
    }
  }
})();

async function waitForPageLoad() {
  return new Promise(resolve => {
    if (document.readyState === 'complete') setTimeout(resolve, 800);
    else window.addEventListener('load', () => setTimeout(resolve, 800));
  });
}

