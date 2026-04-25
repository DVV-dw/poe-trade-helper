/**
 * Poe Trade Helper — Side Panel Script
 */

/* ══════════════════════════════════════════════════
   STATE
══════════════════════════════════════════════════ */
const S = {
  game:     'poe1',
  show:     'equipped',
  build:    null,
  profiles: [],
  fontSize:    22,
  bmItemSize:  12,
  lastUrl:  '',
  poe1: { league: 'Settlers', folders: [], history: [], buildUrl: '', openFolders: new Set() },
  poe2: { league: 'Standard', folders: [], history: [], buildUrl: '', openFolders: new Set() },
  // Tools & Settings
  whisperQueue: [],
  blacklist:    [],
  trusted:      [],
  negFilter:    [],
  webhook:      '',
  customSound:  null,
  chaosDiv:     null,
  multiTabSync: false,
  goldRate:     100,
  attrs:        { str: 0, dex: 0, int: 0 },
};
const gs = () => S[S.game] || S.poe1;

/* ══════════════════════════════════════════════════
   SHORTCUTS
══════════════════════════════════════════════════ */
const $ = id => document.getElementById(id);
const el = (tag, cls, txt) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt !== undefined) e.textContent = txt;
  return e;
};

/* ══════════════════════════════════════════════════
   STORAGE — triple-layer write, triple-layer read.
   Write: 1) localStorage (sync, instant, bulletproof in WAR iframe)
          2) service worker STORAGE_SET (updates SW cache + chrome.storage)
          3) postMessage bridge to content script (backup)
   Read:  1) service worker STORAGE_GET (from in-memory cache)
          2) localStorage fallback
          3) direct chrome.storage.local fallback
══════════════════════════════════════════════════ */
const _ls = {
  save(obj) {
    try {
      for (const [k, v] of Object.entries(obj)) {
        if (v != null) localStorage.setItem('poebt_' + k, JSON.stringify(v));
      }
    }
    catch (_) {}
  },
  load(keys) {
    const data = {};
    try {
      for (const k of keys) {
        const raw = localStorage.getItem('poebt_' + k);
        if (raw !== null) data[k] = JSON.parse(raw);
      }
    } catch (_) {}
    return data;
  },
  del(keys) {
    try { for (const k of keys) localStorage.removeItem('poebt_' + k); }
    catch (_) {}
  },
};

const store = {
  get(keys) {
    const arr = Array.isArray(keys) ? keys : [keys];
    return new Promise(resolve => {
      let done = false;
      // Merge all sources: SW → chrome.storage → localStorage (most data wins)
      const finish = (primary) => {
        if (done) return;
        done = true;
        const ls = _ls.load(arr);
        const out = {};
        for (const k of arr) {
          // Prefer primary, then localStorage (localStorage may have data primary missed)
          if (k in primary && primary[k] != null) out[k] = primary[k];
          else if (k in ls && ls[k] != null) out[k] = ls[k];
        }
        resolve(out);
      };
      // Fallback: read chrome.storage.local directly, merge with localStorage
      const fallback = () => {
        try { chrome.storage.local.get(arr, d => finish(d || {})); }
        catch (_) { finish({}); }
      };
      // Timeout — if SW doesn't respond in 1.5s, use fallback
      const timer = setTimeout(() => { if (!done) fallback(); }, 1500);
      // Primary: ask service worker (in-memory cache, instant)
      try {
        chrome.runtime.sendMessage({ type: 'STORAGE_GET', keys: arr }, resp => {
          clearTimeout(timer);
          if (chrome.runtime.lastError || !resp) { if (!done) fallback(); return; }
          finish(resp.data || {});
        });
      } catch (_) {
        clearTimeout(timer);
        if (!done) fallback();
      }
    });
  },

  set(obj) {
    // 1) localStorage — synchronous, always works in WAR iframe
    _ls.save(obj);
    // 2) Service worker — updates SW cache + chrome.storage.local
    try {
      chrome.runtime.sendMessage({ type: 'STORAGE_SET', data: obj }, () => {
        if (chrome.runtime.lastError) {
          // 3) Content-script bridge fallback
          try { window.parent.postMessage({ type: 'poe-bt-store-set', data: obj }, '*'); } catch (__) {}
        }
      });
    } catch (_) {
      try { window.parent.postMessage({ type: 'poe-bt-store-set', data: obj }, '*'); } catch (__) {}
    }
  },

  remove(keys) {
    const arr = Array.isArray(keys) ? keys : [keys];
    _ls.del(arr);
    try {
      chrome.runtime.sendMessage({ type: 'STORAGE_REMOVE', keys: arr }, () => {
        if (chrome.runtime.lastError)
          try { window.parent.postMessage({ type: 'poe-bt-store-remove', keys: arr }, '*'); } catch (__) {}
      });
    } catch (_) {
      try { window.parent.postMessage({ type: 'poe-bt-store-remove', keys: arr }, '*'); } catch (__) {}
    }
  },
};

/* ══════════════════════════════════════════════════
   PER-GAME STORAGE HELPERS
══════════════════════════════════════════════════ */
const saveLeague   = () => store.set({ [`league_${S.game}`]:       gs().league  });
let _hasLoadedFolders = false;
const saveFolders  = () => {
  if (!_hasLoadedFolders) return;
  const key = `folders_${S.game}`;
  const data = gs().folders;
  store.set({ [key]: data });
};
const saveHistory  = () => store.set({ [`history_${S.game}`]:      gs().history });
const saveBuildUrl = url => {
  gs().buildUrl = url;
  store.set({ [`lastBuildUrl_${S.game}`]: url });
};

/* ══════════════════════════════════════════════════
   BACKUP / RESTORE SAFEGUARD
   Snapshots all storage before init. If init fails → restore.
══════════════════════════════════════════════════ */
async function createBackup() {
  try {
    const all = await new Promise(resolve => {
      try {
        chrome.storage.local.get(null, d => resolve(d || {}));
      } catch (_) { resolve({}); }
    });
    // Store backup under a reserved key (excluded from normal load)
    const backup = JSON.stringify(all);
    try { localStorage.setItem('poebt_backup', backup); } catch (_) {}
    return all;
  } catch (_) { return null; }
}

async function restoreFromBackup() {
  try {
    const raw = localStorage.getItem('poebt_backup');
    if (!raw) return false;
    const data = JSON.parse(raw);
    // Remove our backup key so we don't restore the backup-of-backup
    delete data.poebt_backup;
    if (Object.keys(data).length === 0) return false;
    // Write back to chrome.storage.local
    await new Promise(resolve => {
      try { chrome.storage.local.set(data, resolve); } catch (_) { resolve(); }
    });
    // Also restore localStorage copies
    _ls.save(data);
    return true;
  } catch (_) { return false; }
}

/* ══════════════════════════════════════════════════
   INIT
══════════════════════════════════════════════════ */
async function init() {
  bindEvents();

  // Create backup before loading — safeguard against data wipe
  await createBackup();

  try {
    /* ── Step 1: Detect game — URL param (instant) then parent URL fallback ── */
    const urlParams = new URLSearchParams(window.location.search);
    const gameFromParam = urlParams.get('game');
    if (gameFromParam === 'poe1' || gameFromParam === 'poe2') {
      S.game = gameFromParam;
    }

    const parentUrl = await new Promise(resolve => {
      const onMsg = e => {
        if (e.data?.type === 'poe-bt-url' && e.data.url) {
          window.removeEventListener('message', onMsg);
          resolve(e.data.url);
        }
      };
      window.addEventListener('message', onMsg);
      window.parent.postMessage('poe-bt-request-url', '*');
      setTimeout(() => resolve(''), 1000);
    });
    // Only use parent URL for game detection if URL param wasn't available
    if (!gameFromParam) {
      S.game = /pathofexile\.com\/trade2(\/|$)/.test(parentUrl) ? 'poe2' : 'poe1';
    }
    if (parentUrl) S.lastUrl = parentUrl;

    /* ── Step 2: Load ONLY this game's data + shared settings ── */
    const g = S.game;
    const saved = await store.get([
      'show', 'profiles', 'fontSize', 'bmItemSize',
      `folders_${g}`, `history_${g}`, `league_${g}`, `lastBuildUrl_${g}`,
      // legacy keys for one-time migration (poe1 only)
      ...(g === 'poe1' ? ['folders', 'history', 'league', 'lastBuildUrl'] : []),
      // Tools & Settings (shared)
      'whisperQueue', 'blacklist', 'trusted', 'negFilter',
      'webhook', 'customSound', 'chaosDiv', 'multiTabSync',
      'goldRate', 'attrs',
    ]);

    // Seed localStorage
    _ls.save(saved);

    if (saved.show)     S.show     = saved.show;
    if (saved.profiles) S.profiles = saved.profiles;
    if (saved.fontSize   != null) S.fontSize   = saved.fontSize;
    if (saved.bmItemSize != null) S.bmItemSize = saved.bmItemSize;

    // Load this game's data
    const gs_data = S[g];
    if (saved[`folders_${g}`])      gs_data.folders  = saved[`folders_${g}`];
    if (saved[`history_${g}`])      gs_data.history  = saved[`history_${g}`];
    if (saved[`league_${g}`])       gs_data.league   = saved[`league_${g}`];
    if (saved[`lastBuildUrl_${g}`]) gs_data.buildUrl = saved[`lastBuildUrl_${g}`];

    // one-time migration from legacy single-game keys → poe1 only, then delete legacy keys
    if (!saved[`folders_${g}`] && !saved[`history_${g}`] && g === 'poe1') {
      if (saved.folders)      { gs_data.folders  = saved.folders;      store.set({ [`folders_${g}`]:      saved.folders      }); }
      if (saved.history)      { gs_data.history  = saved.history;      store.set({ [`history_${g}`]:      saved.history      }); }
      if (saved.league)       { gs_data.league   = saved.league;       store.set({ [`league_${g}`]:       saved.league       }); }
      if (saved.lastBuildUrl) { gs_data.buildUrl = saved.lastBuildUrl; store.set({ [`lastBuildUrl_${g}`]: saved.lastBuildUrl }); }
      // Clean up legacy keys so migration never re-triggers
      store.remove(['folders', 'history', 'league', 'lastBuildUrl']);
    }

    // Default folder if empty (in-memory only — don't write to storage to avoid overwriting
    // real data that failed to load due to SW/storage timing issues)
    if (gs_data.folders.length === 0) {
      gs_data.folders.push({ id: `default-${g}`, name: 'Default', items: [] });
      gs_data.openFolders.add(`default-${g}`);
    }

    // Safe to save now — data has been loaded
    _hasLoadedFolders = true;

    // Load tools & settings (shared across games)
    if (saved.whisperQueue)      S.whisperQueue = saved.whisperQueue;
    if (saved.blacklist)         S.blacklist    = saved.blacklist;
    if (saved.trusted)           S.trusted      = saved.trusted;
    if (saved.negFilter)         S.negFilter    = saved.negFilter;
    if (saved.webhook)           S.webhook      = saved.webhook;
    if (saved.customSound)       S.customSound  = saved.customSound;
    if (saved.chaosDiv != null)  S.chaosDiv     = saved.chaosDiv;
    if (saved.multiTabSync)      S.multiTabSync = saved.multiTabSync;
    if (saved.goldRate != null)  S.goldRate     = saved.goldRate;
    if (saved.attrs)             S.attrs        = saved.attrs;

    // Detect league from URL
    const lm = parentUrl.match(/pathofexile\.com\/trade2?\/search\/([^/?#]+)/);
    if (lm) gs_data.league = decodeURIComponent(lm[1]);

    applyFontSize(S.fontSize);
    applyBmItemSize(S.bmItemSize);
    $('fontSizeSlider').value        = S.fontSize;
    $('fontSizeLabel').textContent   = S.fontSize + 'px';
    $('bmItemSizeSlider').value      = S.bmItemSize;
    $('bmItemSizeLabel').textContent = S.bmItemSize + 'px';
    $('buildInput').value = gs().buildUrl;

    // Init tools & settings UI
    if (S.webhook) $('webhookInput').value = S.webhook;
    if (S.chaosDiv != null) { $('ratioInput').value = S.chaosDiv; $('ratioDisplay').textContent = `Current: 1 Divine = ${S.chaosDiv} Chaos`; }
    if (S.goldRate != null) $('goldRate').value = S.goldRate;
    $('negFilterInput').value  = S.negFilter.join('\n');
    $('multiTabSync').checked  = S.multiTabSync;
    if (S.customSound) $('soundStatus').textContent = 'Custom sound loaded';
    $('attrStr').value = S.attrs.str || 0;
    $('attrDex').value = S.attrs.dex || 0;
    $('attrInt').value = S.attrs.int || 0;
    $('goldEstSection').style.display = g === 'poe2' ? '' : 'none';

    // Show active game in header (before settings button)
    const badge = document.createElement('span');
    badge.textContent = g === 'poe2' ? '2' : '1';
    badge.style.cssText = 'font-size:9px;padding:1px 4px;border-radius:3px;flex-shrink:0;' +
      (g === 'poe2' ? 'background:#2a4a2a;color:#80ff80;border:1px solid #408040;'
                     : 'background:#4a3a1a;color:#f0d060;border:1px solid #806020;');
    const settingsBtn = $('settingsBtn');
    if (settingsBtn) settingsBtn.parentNode.insertBefore(badge, settingsBtn);

    // Now safe to listen for URL updates (league changes within same game)
    bindTabListeners();
    renderProfilesList();
    renderBookmarks();
    renderHistory();
    renderWhisperQueue();
    renderBlacklist();
    renderTrusted();

  } catch (err) {
    // Init failed — attempt restore from backup
    const restored = await restoreFromBackup();
    if (restored) {
      console.warn('[PoE BT] Init failed, restored from backup. Reloading...');
      location.reload();
      return;
    }
    console.error('[PoE BT] Init failed, no backup available:', err);
    bindTabListeners();
  }
}

/* ══════════════════════════════════════════════════
   URL / LEAGUE AUTO-DETECT (game is locked at init from URL)
══════════════════════════════════════════════════ */
function applyFromUrl(url) {
  if (url) S.lastUrl = url;

  // Detect league from URL
  const m = url.match(/pathofexile\.com\/trade2?\/search\/([^/?#]+)/);
  if (m) {
    const league = decodeURIComponent(m[1]);
    if (league !== gs().league) {
      gs().league = league;
      saveLeague();
      if (S.build) renderItems(S.build);
      renderProfilesList();
    }
  }
}

let _resolveSearchName = null;

function bindTabListeners() {
  window.addEventListener('message', e => {
    if (e.data?.type === 'poe-bt-url' && e.data.url) applyFromUrl(e.data.url);
    if (e.data?.type === 'poe-bt-search-name' && _resolveSearchName) {
      _resolveSearchName(e.data.name || '');
    }
  });
}

/* ══════════════════════════════════════════════════
   BIND EVENTS
══════════════════════════════════════════════════ */
function on(id, evt, fn) {
  const e = $(id);
  if (e) e.addEventListener(evt, fn);
}

function bindEvents() {
  document.querySelectorAll('.htab').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  on('collapseBtn',       'click', () => window.parent.postMessage('poe-bt-hide', '*'));
  on('importBtn',         'click', handleImport);
  on('buildInput',        'keydown', e => { if (e.key === 'Enter') handleImport(); });
  on('saveBuildBtn',      'click', openSaveProfileModal);
  on('clearBuildBtn',     'click', clearBuild);
  on('saveProfileConfirm','click', confirmSaveProfile);
  on('saveProfileCancel', 'click', () => $('saveProfileModal').classList.add('hidden'));
  on('bmAddFolderBtn',    'click', () => { $('folderNameInput').value = ''; $('folderModal').classList.remove('hidden'); });
  on('bmCaptureBtn',      'click', captureCurrentSearch);
  on('folderConfirm',     'click', confirmAddFolder);
  on('folderCancel',      'click', () => $('folderModal').classList.add('hidden'));
  on('bmConfirm',         'click', confirmAddBookmark);
  on('bmCancel',          'click', () => $('bmModal').classList.add('hidden'));
  on('exportCodeBtn',     'click', exportBookmarksCode);
  on('importCodeBtn',     'click', openImportCodeModal);
  on('importCodeConfirm', 'click', confirmImportCode);
  on('importCodeCancel',  'click', () => $('importCodeModal').classList.add('hidden'));
  on('clearHistoryBtn',   'click', clearHistory);

  on('fontSizeSlider', 'input', () => {
    const v = parseInt($('fontSizeSlider').value, 10);
    $('fontSizeLabel').textContent = v + 'px';
    S.fontSize = v;
    applyFontSize(v);
    store.set({ fontSize: v });
  });

  on('bmItemSizeSlider', 'input', () => {
    const v = parseInt($('bmItemSizeSlider').value, 10);
    $('bmItemSizeLabel').textContent = v + 'px';
    S.bmItemSize = v;
    applyBmItemSize(v);
    store.set({ bmItemSize: v });
  });

  on('renameConfirm', 'click', confirmRename);
  on('renameCancel',  'click', () => { $('renameModal').classList.add('hidden'); renameCb = null; });
  on('renameInput',   'keydown', e => { if (e.key === 'Enter') confirmRename(); });

  on('reloadPanelBtn', 'click', () => location.reload());
  document.addEventListener('click', hideCtxMenu);

  // Tools
  on('clearWhispersBtn', 'click', clearWhispers);
  on('ratioSetBtn',      'click', setRatio);
  on('ratioAutoBtn',     'click', autoRatio);
  on('profitBuy',        'input', calcProfit);
  on('profitSell',       'input', calcProfit);
  on('profitQty',        'input', calcProfit);
  on('regexGenBtn',      'click', genRegex);
  on('regexItemInput',   'keydown', e => { if (e.key === 'Enter') genRegex(); });
  on('goldAmount',       'input', () => calcGold('fromGold'));
  on('goldChaos',        'input', () => calcGold('fromChaos'));
  on('goldRate',         'input', () => { S.goldRate = parseFloat($('goldRate').value) || 100; store.set({ goldRate: S.goldRate }); });
  on('attrCheckBtn',     'click', checkAttributes);
  on('jsonExportBtn',    'click', triggerJsonExport);

  // Settings — Webhook, Sound, Filters, Lists
  on('webhookSaveBtn',   'click', saveWebhook);
  on('webhookTestBtn',   'click', testWebhook);
  on('soundUploadBtn',   'click', () => $('soundFileInput').click());
  on('soundFileInput',   'change', handleSoundUpload);
  on('soundPreviewBtn',  'click', previewSound);
  on('soundClearBtn',    'click', clearSound);
  on('negFilterSaveBtn', 'click', saveNegFilter);
  on('blacklistAddBtn',  'click', addBlacklist);
  on('blacklistInput',   'keydown', e => { if (e.key === 'Enter') addBlacklist(); });
  on('trustedAddBtn',    'click', addTrusted);
  on('trustedInput',     'keydown', e => { if (e.key === 'Enter') addTrusted(); });
  on('multiTabSync',     'change', () => { S.multiTabSync = $('multiTabSync').checked; store.set({ multiTabSync: S.multiTabSync }); });
}

/* ══════════════════════════════════════════════════
   TAB SWITCHING
══════════════════════════════════════════════════ */
function switchTab(tab) {
  if (!tab) return;
  document.querySelectorAll('.htab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('hidden', c.id !== `tab-${tab}`));
}

/* ══════════════════════════════════════════════════
   IMPORT BUILD
══════════════════════════════════════════════════ */
async function handleImport() {
  const raw = $('buildInput').value.trim();
  if (!raw) return;
  showStatus('Fetching build...');
  hideError();
  clearBuildPanel();
  saveBuildUrl(raw);
  try {
    let code = raw;
    if (raw.includes('pobb.in') || raw.startsWith('http')) {
      showStatus('Fetching from pobb.in...');
      const res = await chrome.runtime.sendMessage({ type: 'FETCH_POBB', url: raw });
      if (res?.success && res.data?.buildCode) {
        code = res.data.buildCode;
      } else if (res?.error) {
        throw new Error(res.error);
      }
    }
    showStatus('Decoding build data...');
    const build = await PoBParser.extractUniquesFromCode(code);
    S.build = build;
    // Game is locked to URL — don't switch based on build data
    hideStatus();
    renderBuildPanel(build);
    renderProfilesList();
  } catch (err) {
    hideStatus();
    showError(err.message || 'Failed to parse build');
  }
}

/* ══════════════════════════════════════════════════
   BUILD PANEL
══════════════════════════════════════════════════ */
function renderBuildPanel(build) {
  $('buildPanel').classList.remove('hidden');
  const tags = $('buildTags');
  tags.innerHTML = '';
  tags.append(
    el('span', 'build-tag', build.game === 'poe2' ? 'PoE 2' : 'PoE 1'),
    el('span', 'build-tag', `${build.all.length} unique${build.all.length !== 1 ? 's' : ''}`),
  );
  if (gs().league) tags.append(el('span', 'build-tag', gs().league));
  renderItems(build);
}

function renderItems(build) {
  const wrap = $('itemsWrap');
  wrap.innerHTML = '';
  const { equipped, unequipped } = build;
  const showAll = S.show === 'all';
  if (equipped.length > 0) {
    if (showAll) wrap.appendChild(el('div', 'section-header', 'Equipped'));
    equipped.forEach(item => wrap.appendChild(makeItemRow(item)));
  }
  if (showAll && unequipped.length > 0) {
    wrap.appendChild(el('div', 'section-header', 'In Inventory'));
    unequipped.forEach(item => wrap.appendChild(makeItemRow(item)));
  }
  if (equipped.length === 0 && (!showAll || unequipped.length === 0)) {
    wrap.appendChild(el('div', 'no-saves', 'No unique items found in this build'));
  }
}

function makeItemRow(item) {
  const row    = el('div', 'item-row');
  const accent = el('div', 'item-accent');
  const body   = el('div', 'item-body');
  const name   = el('div', 'item-name', item.name);
  name.title   = item.name;
  const sub    = el('div', 'item-sub');
  if (item.baseType) sub.appendChild(el('span', 'item-base', item.baseType));
  if (item.slot)     sub.appendChild(el('span', 'item-slot-tag', item.slot.toUpperCase()));
  body.append(name, sub);
  const btns   = el('div', 'item-btns');
  const btn1   = el('button', 'item-btn');
  btn1.innerHTML = '🔍';
  btn1.title   = `Search on PoE ${S.game === 'poe2' ? '2' : '1'} trade`;
  btn1.addEventListener('click', () => openTradeSearch(item.name));
  const btnBm  = el('button', 'item-btn');
  btnBm.innerHTML = '📌';
  btnBm.title  = 'Bookmark this search';
  btnBm.addEventListener('click', () => openAddBookmarkForItem(item.name));
  btns.append(btn1, btnBm);
  row.append(accent, body, btns);
  return row;
}

function clearBuildPanel() {
  $('buildPanel').classList.add('hidden');
  $('itemsWrap').innerHTML = '';
  $('buildTags').innerHTML = '';
}

function clearBuild() {
  S.build = null;
  clearBuildPanel();
  hideError();
  $('buildInput').value = '';
  saveBuildUrl('');
}

/* ══════════════════════════════════════════════════
   TRADE SEARCH
══════════════════════════════════════════════════ */
function buildTradeUrl() {
  const base = S.game === 'poe2'
    ? 'https://www.pathofexile.com/trade2/search/'
    : 'https://www.pathofexile.com/trade/search/';
  return `${base}${encodeURIComponent(gs().league)}`;
}

function buildSearchPayload(itemName) {
  return {
    query: {
      status: { option: 'online' },
      name:   itemName,
      stats:  [{ type: 'and', filters: [], disabled: false }],
      filters: { type_filters: { filters: { rarity: { option: 'unique' } } } },
    },
    sort: { price: 'asc' },
  };
}

async function openTradeSearch(itemName) {
  const payload  = buildSearchPayload(itemName);
  const tradeUrl = buildTradeUrl();
  addToHistory(itemName, tradeUrl);
  try {
    chrome.runtime.sendMessage({
      type:    'EXECUTE_TRADE_SEARCH',
      payload: { itemName, game: S.game, league: gs().league, payload, timestamp: Date.now() },
      tradeUrl,
    });
  } catch (_) {}
}

/* ══════════════════════════════════════════════════
   SAVED PROFILES
══════════════════════════════════════════════════ */
function openSaveProfileModal() {
  if (!S.build) return;
  $('profileNameInput').value = '';
  $('profileUrlInput').value  = gs().buildUrl;
  $('saveProfileModal').classList.remove('hidden');
  $('profileNameInput').focus();
}

function confirmSaveProfile() {
  const name = $('profileNameInput').value.trim();
  if (!name) return;
  S.profiles.unshift({
    id:          Date.now().toString(),
    name,
    url:         $('profileUrlInput').value,
    game:        S.game,
    league:      gs().league,
    uniqueCount: S.build ? S.build.all.length : 0,
    uniques:     S.build ? S.build.all.map(u => u.name) : [],
    ts:          Date.now(),
  });
  store.set({ profiles: S.profiles });
  $('saveProfileModal').classList.add('hidden');
  renderProfilesList();
}

function renderProfilesList() {
  const list = $('profilesList');
  list.innerHTML = '';
  const none = $('noProfiles');
  const filtered   = S.profiles.filter(p => p.game === S.game);
  const otherCount = S.profiles.length - filtered.length;
  const title = $('profilesTitle');
  if (title) title.textContent = `${S.game === 'poe2' ? 'PoE 2' : 'PoE 1'} Profiles`;
  if (filtered.length === 0) {
    none.classList.remove('hidden');
    none.textContent = otherCount > 0
      ? `No ${S.game === 'poe2' ? 'PoE 2' : 'PoE 1'} profiles yet — ${otherCount} saved for ${S.game === 'poe2' ? 'PoE 1' : 'PoE 2'}`
      : 'No saved profiles yet';
    return;
  }
  none.classList.add('hidden');
  filtered.forEach(p => {
    const card    = el('div', 'profile-card');
    card.addEventListener('click', () => loadProfile(p));
    const body    = el('div', 'profile-body');
    const pname   = el('div', 'profile-name', p.name);
    const meta    = el('div', 'profile-meta',
      `${p.game === 'poe2' ? 'PoE2' : 'PoE1'} · ${p.league} · ${p.uniqueCount} uniques · ${timeAgo(p.ts)}`);
    body.append(pname, meta);
    const actions = el('div', 'profile-actions');
    const moreBtn = el('button', 'profile-btn more-btn', '···');
    moreBtn.title = 'Options';
    moreBtn.addEventListener('click', e => {
      e.stopPropagation();
      showCtxMenu(moreBtn, [
        { label: 'Edit Name', action: () => openRenameModal('Edit Profile Name', p.name, n => {
            p.name = n; store.set({ profiles: S.profiles }); renderProfilesList();
          })
        },
        { label: 'Load',   action: () => loadProfile(p) },
        { label: 'Delete', danger: true, action: () => deleteProfile(p.id) },
      ]);
    });
    actions.append(moreBtn);
    card.append(el('span', 'profile-icon', '🔮'), body, actions);
    list.appendChild(card);
  });
}

function loadProfile(p) {
  // Game is locked to URL — profile loads into current game context
  gs().league = p.league;
  saveLeague();
  $('buildInput').value = p.url;
  handleImport();
  switchTab('builds');
}

function deleteProfile(id) {
  S.profiles = S.profiles.filter(p => p.id !== id);
  store.set({ profiles: S.profiles });
  renderProfilesList();
}

/* ══════════════════════════════════════════════════
   BOOKMARKS
══════════════════════════════════════════════════ */
function confirmAddFolder() {
  const name = $('folderNameInput').value.trim();
  if (!name) return;
  gs().folders.push({ id: Date.now().toString(), name, items: [] });
  saveFolders();
  $('folderModal').classList.add('hidden');
  $('folderNameInput').value = '';
  renderBookmarks();
}

function captureCurrentSearch() {
  // Request fresh URL from parent (S.lastUrl may be stale)
  const getUrl = new Promise(resolve => {
    const onMsg = e => {
      if (e.data?.type === 'poe-bt-url' && e.data.url) {
        window.removeEventListener('message', onMsg);
        resolve(e.data.url);
      }
    };
    window.addEventListener('message', onMsg);
    window.parent.postMessage('poe-bt-request-url', '*');
    setTimeout(() => resolve(S.lastUrl || ''), 500);
  });

  getUrl.then(url => {
    if (url) S.lastUrl = url;
    if (!url || !/pathofexile\.com\/trade/.test(url)) {
      showToast('Navigate to a trade search page first');
      return;
    }
    const cleanUrl = url.split('#')[0];

    $('bmNameInput').value = '';
    $('bmUrlInput').value  = cleanUrl;
    populateFolderSelect();
    $('bmModal').classList.remove('hidden');

    // Try to fill name from trade page (async, best-effort)
    _resolveSearchName = n => {
      _resolveSearchName = null;
      if (n && !$('bmNameInput').value) $('bmNameInput').value = n;
    };
    try { window.parent.postMessage('poe-bt-request-search-name', '*'); } catch(_){}
    setTimeout(() => { _resolveSearchName = null; }, 2000);
  });
}

async function openAddBookmarkForItem(itemName) {
  $('bmNameInput').value = itemName;
  $('bmUrlInput').value  = 'Generating search URL...';
  populateFolderSelect();
  $('bmModal').classList.remove('hidden');

  // Ask service worker to execute search API and return the search ID URL
  try {
    const res = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        type: 'CREATE_SEARCH_URL',
        payload: buildSearchPayload(itemName),
        game: S.game,
        league: gs().league,
      }, r => {
        if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
        else resolve(r);
      });
    });
    if (res?.success && res.url) {
      $('bmUrlInput').value = res.url;
      return;
    }
  } catch (_) {}

  // Fallback: use base trade URL
  $('bmUrlInput').value = buildTradeUrl();
}

function populateFolderSelect() {
  const sel = $('bmFolderSelect');
  sel.innerHTML = '';
  if (gs().folders.length === 0) {
    sel.appendChild(new Option('(No folders — create one first)', ''));
    return;
  }
  gs().folders.forEach(f => sel.appendChild(new Option(f.name, f.id)));
}

function confirmAddBookmark() {
  const name     = $('bmNameInput').value.trim();
  const url      = $('bmUrlInput').value.trim();
  const folderId = $('bmFolderSelect').value;
  if (!name || !url) return;
  if (!folderId) { showToast('Create a folder first'); return; }
  const folder = gs().folders.find(f => f.id === folderId);
  if (!folder) { showToast('Folder not found — try again'); return; }
  folder.items.push({ id: Date.now().toString(), name, url, ts: Date.now() });
  saveFolders();
  $('bmModal').classList.add('hidden');
  renderBookmarks();
  showToast(`Saved "${name}" to ${folder.name}`);
}

let bmDrag = null;

function renderBookmarks() {
  const wrap = $('bookmarkFolders');
  wrap.innerHTML = '';
  const none = $('noBookmarks');
  if (gs().folders.length === 0) { none.classList.remove('hidden'); return; }
  none.classList.add('hidden');

  gs().folders.forEach(folder => {
    const f      = el('div', 'bm-folder');
    const header = el('div', 'bm-folder-header');
    const arrow  = el('span', 'bm-folder-arrow', '▶');
    const fname  = el('span', 'bm-folder-name', folder.name);
    const fcount = el('span', 'bm-folder-count', `(${folder.items.length})`);
    const moreBtn = el('button', 'bm-folder-btn more-btn', '···');
    moreBtn.title = 'Folder options';
    moreBtn.addEventListener('click', e => {
      e.stopPropagation();
      showCtxMenu(moreBtn, [
        { label: 'Rename', action: () => openRenameModal('Rename Folder', folder.name, n => {
            folder.name = n; saveFolders(); renderBookmarks();
          })
        },
        { label: 'Delete', danger: true, action: () => {
            if (confirm(`Delete folder "${folder.name}" and all its bookmarks?`)) {
              gs().folders = gs().folders.filter(x => x.id !== folder.id);
              saveFolders(); renderBookmarks();
            }
          }
        },
      ]);
    });
    header.append(arrow, fname, fcount, moreBtn);

    const items = el('div', 'bm-items');
    folder.items.forEach((item, idx) => {
      const row = el('div', 'bm-item');
      row.draggable = true;
      row.dataset.idx = idx;
      row.addEventListener('click', () => openBookmark(item));
      row.addEventListener('dragstart', e => {
        bmDrag = { folderId: folder.id, fromIdx: idx };
        e.dataTransfer.effectAllowed = 'move';
        setTimeout(() => row.classList.add('dragging'), 0);
      });
      row.addEventListener('dragend',   () => row.classList.remove('dragging'));
      row.addEventListener('dragover',  e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; row.classList.add('drag-over'); });
      row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
      row.addEventListener('drop', e => {
        e.preventDefault(); e.stopPropagation();
        row.classList.remove('drag-over');
        if (!bmDrag || bmDrag.folderId !== folder.id || bmDrag.fromIdx === idx) return;
        const f2 = gs().folders.find(x => x.id === folder.id);
        const [moved] = f2.items.splice(bmDrag.fromIdx, 1);
        f2.items.splice(idx, 0, moved);
        bmDrag = null;
        saveFolders();
        renderBookmarks();
      });

      const dot  = el('span', 'bm-item-dot');
      const name = el('span', 'bm-item-name', item.name);
      name.title = item.url;
      const moreBtn = el('button', 'bm-item-btn more-btn', '···');
      moreBtn.title = 'Options';
      moreBtn.addEventListener('click', e => {
        e.stopPropagation();
        showCtxMenu(moreBtn, [
          { label: 'Edit Name', action: () => openRenameModal('Edit Bookmark Name', item.name, n => {
              item.name = n; saveFolders(); renderBookmarks();
            })
          },
          { label: 'Live Link', action: () => {
              const liveUrl = item.url.replace(/\/live\/?$/, '').replace(/\/$/, '') + '/live';
              openTab(liveUrl);
            }
          },
          { label: 'Copy URL', action: () => copyToClipboard(item.url) },
          { label: 'Delete',   danger: true, action: () => {
              folder.items = folder.items.filter(x => x.id !== item.id);
              saveFolders(); renderBookmarks();
            }
          },
        ]);
      });
      row.append(dot, name, moreBtn);
      items.appendChild(row);
    });

    if (gs().openFolders.has(folder.id)) {
      items.classList.add('open');
      arrow.classList.add('open');
    }
    header.addEventListener('click', () => {
      const open = items.classList.toggle('open');
      arrow.classList.toggle('open', open);
      if (open) gs().openFolders.add(folder.id);
      else      gs().openFolders.delete(folder.id);
    });
    f.append(header, items);
    wrap.appendChild(f);
  });
}

/* ══════════════════════════════════════════════════
   CONTEXT MENU
══════════════════════════════════════════════════ */
function showCtxMenu(anchor, items) {
  const menu = $('ctxMenu');
  menu.innerHTML = '';
  items.forEach(({ label, action, danger }) => {
    const btn = el('button', 'ctx-item' + (danger ? ' danger' : ''), label);
    btn.addEventListener('click', e => { e.stopPropagation(); hideCtxMenu(); action(); });
    menu.appendChild(btn);
  });
  const rect = anchor.getBoundingClientRect();
  const menuW = 160;
  let left = rect.right - menuW;
  if (left < 4) left = 4;
  menu.style.left = left + 'px';
  menu.style.top  = (rect.bottom + 2) + 'px';
  menu.classList.remove('hidden');
}
function hideCtxMenu() { $('ctxMenu').classList.add('hidden'); }

/* ══════════════════════════════════════════════════
   RENAME MODAL
══════════════════════════════════════════════════ */
let renameCb = null;

function openRenameModal(title, currentName, cb) {
  $('renameModalTitle').textContent = title;
  $('renameInput').value = currentName;
  renameCb = cb;
  $('renameModal').classList.remove('hidden');
  setTimeout(() => { $('renameInput').focus(); $('renameInput').select(); }, 50);
}

function confirmRename() {
  const name = $('renameInput').value.trim();
  if (!name) return;
  $('renameModal').classList.add('hidden');
  if (renameCb) renameCb(name);
  renameCb = null;
}

function openTab(url) {
  window.parent.postMessage({ type: 'poe-bt-open-tab', url }, '*');
}

function openBookmark(item) {
  addToHistory(item.name, item.url);
  openTab(item.url);
}

/* ── Compact code codec ─────────────────────────────
   Format: 3:{btoa(JSON)}
   JSON:   { icn, tit, ver:"1", trs:[{tit, loc, fld}] }
   loc:    "{1|2}:search:{searchId}"
──────────────────────────────────────────────────── */
function urlToLoc(url) {
  const m = url.match(/pathofexile\.com\/(trade2?)\/search\/[^/]+\/([A-Za-z0-9_-]+)/);
  if (!m) return null;
  return `${m[1] === 'trade2' ? '2' : '1'}:search:${m[2]}`;
}

function locToUrl(loc) {
  const parts = loc.split(':');
  if (parts.length < 3 || parts[1] !== 'search') return null;
  const [game, , searchId] = parts;
  const path = game === '2' ? 'trade2' : 'trade';
  return `https://www.pathofexile.com/${path}/search/${encodeURIComponent(gs().league)}/${searchId}`;
}

function encodeBookmarks() {
  const trs = [];
  gs().folders.forEach(folder => {
    folder.items.forEach(item => {
      const loc = urlToLoc(item.url) || item.url;
      trs.push({ tit: item.name, loc, fld: folder.name });
    });
  });
  const data = { icn: '', tit: `${S.game === 'poe2' ? 'PoE 2' : 'PoE 1'} Bookmarks`, ver: '1', trs };
  return `3:${btoa(unescape(encodeURIComponent(JSON.stringify(data))))}`;
}

function decodeBookmarks(code) {
  const colonIdx = code.indexOf(':');
  if (colonIdx < 0) throw new Error('Invalid code');
  const b64 = code.slice(colonIdx + 1);
  let data;
  try { data = JSON.parse(decodeURIComponent(escape(atob(b64)))); } catch { throw new Error('Cannot decode — check code is complete'); }
  if (!Array.isArray(data?.trs)) throw new Error('No trade entries found in code');
  return data;
}

function exportBookmarksCode() {
  const code = encodeBookmarks();
  copyToClipboard(code);
  const btn = $('exportCodeBtn');
  btn.textContent = '✓ Copied!';
  setTimeout(() => { btn.textContent = '⬆ Copy Code'; }, 1800);
}

function openImportCodeModal() {
  $('importCodeInput').value = '';
  $('importCodeInput').readOnly = false;
  $('importCodeModalTitle').textContent = 'Import Bookmarks';
  $('importCodeConfirm').classList.remove('hidden');
  $('importCodeError').classList.add('hidden');
  $('importCodeModal').classList.remove('hidden');
  setTimeout(() => $('importCodeInput').focus(), 50);
}

function confirmImportCode() {
  const code = $('importCodeInput').value.trim();
  if (!code) return;
  try {
    const data = decodeBookmarks(code);

    // Group entries by folder name
    const folderMap = new Map();
    data.trs.forEach(tr => {
      const folderName = tr.fld || data.tit || 'Imported';
      if (!folderMap.has(folderName)) folderMap.set(folderName, []);
      const url = (tr.loc && !tr.loc.startsWith('http'))
        ? (locToUrl(tr.loc) || tr.loc)
        : (tr.loc || tr.url || '');
      folderMap.get(folderName).push({ id: `${Date.now()}-${Math.random()}`, name: tr.tit, url, ts: Date.now() });
    });

    // Merge into existing folders or create new ones
    folderMap.forEach((items, name) => {
      let folder = gs().folders.find(f => f.name === name);
      if (!folder) {
        folder = { id: `${Date.now()}-${Math.random()}`, name, items: [] };
        gs().folders.push(folder);
      }
      folder.items.push(...items);
    });

    saveFolders();
    renderBookmarks();
    $('importCodeModal').classList.add('hidden');
  } catch (e) {
    $('importCodeErrTxt').textContent = e.message;
    $('importCodeError').classList.remove('hidden');
  }
}

/* ══════════════════════════════════════════════════
   HISTORY
══════════════════════════════════════════════════ */
function addToHistory(name, url) {
  gs().history = gs().history.filter(h => h.url !== url);
  gs().history.unshift({ id: Date.now().toString(), name, url, ts: Date.now() });
  if (gs().history.length > 100) gs().history = gs().history.slice(0, 100);
  saveHistory();
  renderHistory();
}

function renderHistory() {
  const list = $('historyList');
  list.innerHTML = '';
  const none = $('noHistory');
  if (gs().history.length === 0) { none.classList.remove('hidden'); return; }
  none.classList.add('hidden');
  gs().history.forEach(h => {
    const row  = el('div', 'history-item');
    row.addEventListener('click', () => { addToHistory(h.name, h.url); openTab(h.url); });
    const name = el('span', 'history-name', h.name);
    name.title = h.url;
    const time = el('span', 'history-time', timeAgo(h.ts));
    const del  = el('button', 'history-btn', '✕');
    del.title  = 'Remove';
    del.addEventListener('click', e => {
      e.stopPropagation();
      gs().history = gs().history.filter(x => x.id !== h.id);
      saveHistory(); renderHistory();
    });
    const bmBtn = el('button', 'history-btn', '📌');
    bmBtn.title = 'Bookmark this';
    bmBtn.addEventListener('click', e => {
      e.stopPropagation();
      $('bmNameInput').value = h.name;
      $('bmUrlInput').value  = h.url;
      populateFolderSelect();
      $('bmModal').classList.remove('hidden');
      switchTab('bookmarks');
    });
    row.append(name, time, bmBtn, del);
    list.appendChild(row);
  });
}

function clearHistory() {
  if (!confirm('Clear all search history?')) return;
  gs().history = [];
  saveHistory();
  renderHistory();
}

/* ══════════════════════════════════════════════════
   SETTINGS HELPERS
══════════════════════════════════════════════════ */
function applyFontSize(px)   { document.documentElement.style.fontSize = px + 'px'; }
function applyBmItemSize(px) { document.documentElement.style.setProperty('--bm-item-name-size', px + 'px'); }

/* ══════════════════════════════════════════════════
   WHISPER QUEUE
══════════════════════════════════════════════════ */
function renderWhisperQueue() {
  const list = $('whisperList');
  list.innerHTML = '';
  const none = $('noWhispers');
  if (S.whisperQueue.length === 0) { none.classList.remove('hidden'); return; }
  none.classList.add('hidden');
  S.whisperQueue.forEach((w, idx) => {
    const row  = el('div', 'whisper-item');
    const name = el('span', 'whisper-name', w.seller);
    name.title = `Whispered ${new Date(w.ts).toLocaleTimeString()}`;
    const time = el('span', 'whisper-time', timeAgo(w.ts));
    const btn  = el('button', 'whisper-btn' + (w.noResponse ? ' flagged' : ''), w.noResponse ? 'No Resp' : 'No Resp?');
    btn.addEventListener('click', e => {
      e.stopPropagation();
      w.noResponse = !w.noResponse;
      store.set({ whisperQueue: S.whisperQueue });
      renderWhisperQueue();
    });
    const del = el('button', 'history-btn', '✕');
    del.addEventListener('click', e => {
      e.stopPropagation();
      S.whisperQueue.splice(idx, 1);
      store.set({ whisperQueue: S.whisperQueue });
      renderWhisperQueue();
    });
    row.append(name, time, btn, del);
    list.appendChild(row);
  });
}

function clearWhispers() {
  S.whisperQueue = [];
  store.set({ whisperQueue: [] });
  renderWhisperQueue();
}

// Listen for whisper queue updates from content script
chrome.storage.onChanged.addListener(changes => {
  if (changes.whisperQueue) {
    S.whisperQueue = changes.whisperQueue.newValue || [];
    renderWhisperQueue();
  }
});

/* ══════════════════════════════════════════════════
   CHAOS / DIVINE RATIO
══════════════════════════════════════════════════ */
function setRatio() {
  const val = parseFloat($('ratioInput').value);
  if (!val || val <= 0) return;
  S.chaosDiv = val;
  store.set({ chaosDiv: val });
  $('ratioDisplay').textContent = `Current: 1 Divine = ${val} Chaos`;
  broadcastToTrade({ type: 'poe-bt-ratio-update', ratio: val });
}

async function autoRatio() {
  $('ratioDisplay').textContent = 'Fetching from poe.ninja...';
  try {
    const res = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'FETCH_NINJA_RATIO', game: S.game, league: gs().league }, r => {
        if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
        else resolve(r);
      });
    });
    if (res?.success && res.ratio) {
      S.chaosDiv = res.ratio;
      $('ratioInput').value = res.ratio;
      store.set({ chaosDiv: res.ratio });
      $('ratioDisplay').textContent = `Current: 1 Divine = ${res.ratio} Chaos (poe.ninja)`;
    } else {
      $('ratioDisplay').textContent = 'Failed — set manually';
    }
  } catch (_) {
    $('ratioDisplay').textContent = 'Failed — set manually';
  }
}

/* ══════════════════════════════════════════════════
   PROFIT CALCULATOR
══════════════════════════════════════════════════ */
function calcProfit() {
  const buy  = parseFloat($('profitBuy').value) || 0;
  const sell = parseFloat($('profitSell').value) || 0;
  const qty  = parseInt($('profitQty').value) || 1;
  if (!buy || !sell) { $('profitResult').textContent = 'Enter buy/sell prices'; $('profitResult').style.color = ''; return; }
  const profit = (sell - buy) * qty;
  const margin = ((sell - buy) / buy * 100).toFixed(1);
  $('profitResult').textContent = `Profit: ${profit.toFixed(1)}c (${margin}% margin) x${qty}`;
  $('profitResult').style.color = profit > 0 ? '#70dd70' : '#dd7070';
}

/* ══════════════════════════════════════════════════
   REGEX GENERATOR
══════════════════════════════════════════════════ */
function genRegex() {
  const name = $('regexItemInput').value.trim();
  if (!name) return;
  const out = $('regexOutput');
  out.classList.remove('hidden');
  const words = name.split(/\s+/).filter(w => w.length > 2);
  const patterns = [];
  patterns.push(`"${name.toLowerCase()}"`);
  if (words.length > 0) patterns.push(`"${words[0].substring(0, 4).toLowerCase()}"`);
  if (words.length >= 2) {
    const trigrams = words.map(w => w.substring(0, 3).toLowerCase());
    patterns.push(`"(${trigrams.join('|')})"`);
  }
  out.textContent = patterns.join('   ');
  out.title = 'Click to copy';
  out.onclick = () => {
    copyToClipboard(patterns[0]);
    out.style.borderColor = '#70dd70';
    setTimeout(() => out.style.borderColor = '', 600);
  };
}

/* ══════════════════════════════════════════════════
   GOLD ESTIMATOR (PoE2)
══════════════════════════════════════════════════ */
function calcGold(dir) {
  const rate = S.goldRate || 100;
  if (dir === 'fromGold') {
    const gold = parseFloat($('goldAmount').value) || 0;
    $('goldChaos').value = gold ? (gold / rate).toFixed(1) : '';
  } else {
    const chaos = parseFloat($('goldChaos').value) || 0;
    $('goldAmount').value = chaos ? (chaos * rate).toFixed(0) : '';
  }
}

/* ══════════════════════════════════════════════════
   ATTRIBUTE CHECKER
══════════════════════════════════════════════════ */
function checkAttributes() {
  const str = parseInt($('attrStr').value) || 0;
  const dex = parseInt($('attrDex').value) || 0;
  const int = parseInt($('attrInt').value) || 0;
  S.attrs = { str, dex, int };
  store.set({ attrs: S.attrs });
  if (!S.build) { $('attrResult').textContent = 'Import a build first'; return; }
  const issues = [];
  for (const item of S.build.all) {
    const req = item.requirements || {};
    if (req.str && str < req.str) issues.push(`${item.name}: needs ${req.str} Str (have ${str})`);
    if (req.dex && dex < req.dex) issues.push(`${item.name}: needs ${req.dex} Dex (have ${dex})`);
    if (req.int && int < req.int) issues.push(`${item.name}: needs ${req.int} Int (have ${int})`);
  }
  const r = $('attrResult');
  if (issues.length === 0) {
    r.innerHTML = '<span style="color:#70dd70">All items fit your attributes</span>';
  } else {
    r.innerHTML = issues.map(i => `<div style="color:#dd7070;font-size:0.72em">${i}</div>`).join('');
  }
}

/* ══════════════════════════════════════════════════
   JSON EXPORT
══════════════════════════════════════════════════ */
function triggerJsonExport() {
  window.parent.postMessage('poe-bt-request-json-export', '*');
}

/* ══════════════════════════════════════════════════
   DISCORD WEBHOOK
══════════════════════════════════════════════════ */
function saveWebhook() {
  const url = $('webhookInput').value.trim();
  S.webhook = url;
  store.set({ webhook: url });
  $('webhookStatus').textContent = url ? 'Webhook saved' : 'Webhook cleared';
}

async function testWebhook() {
  if (!S.webhook) { $('webhookStatus').textContent = 'No webhook URL set'; return; }
  $('webhookStatus').textContent = 'Sending test...';
  try {
    const res = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        type: 'SEND_WEBHOOK', url: S.webhook,
        payload: { content: '🔔 **PoE Build Trader** — Webhook test successful!' },
      }, r => {
        if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
        else resolve(r);
      });
    });
    $('webhookStatus').textContent = res?.success ? 'Test sent ✓' : 'Failed — check URL';
  } catch (e) {
    $('webhookStatus').textContent = 'Failed: ' + e.message;
  }
}

/* ══════════════════════════════════════════════════
   ALERT SOUND
══════════════════════════════════════════════════ */
function handleSoundUpload(e) {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > 500_000) { $('soundStatus').textContent = 'File too large (max 500KB)'; return; }
  const reader = new FileReader();
  reader.onload = evt => {
    S.customSound = evt.target.result;
    store.set({ customSound: S.customSound });
    $('soundStatus').textContent = `Loaded: ${file.name}`;
  };
  reader.readAsDataURL(file);
  e.target.value = '';
}

function previewSound() {
  if (!S.customSound) { $('soundStatus').textContent = 'No custom sound loaded'; return; }
  try { new Audio(S.customSound).play(); } catch (_) { $('soundStatus').textContent = 'Playback failed'; }
}

function clearSound() {
  S.customSound = null;
  store.remove('customSound');
  $('soundStatus').textContent = 'Default browser notification';
}

function playAlertSound() {
  if (S.customSound) {
    try { new Audio(S.customSound).play(); return; } catch (_) {}
  }
  // Default beep
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.value = 800; gain.gain.value = 0.3;
    osc.start(); osc.stop(ctx.currentTime + 0.2);
  } catch (_) {}
}

/* ══════════════════════════════════════════════════
   NEGATIVE FILTER
══════════════════════════════════════════════════ */
function saveNegFilter() {
  S.negFilter = $('negFilterInput').value.split('\n').map(s => s.trim()).filter(Boolean);
  store.set({ negFilter: S.negFilter });
  broadcastToTrade({ type: 'poe-bt-negfilter-update', filters: S.negFilter });
}

/* ══════════════════════════════════════════════════
   BLACKLIST / TRUSTED SELLERS
══════════════════════════════════════════════════ */
function addBlacklist() {
  const name = $('blacklistInput').value.trim();
  if (!name || S.blacklist.includes(name)) return;
  S.blacklist.push(name);
  store.set({ blacklist: S.blacklist });
  $('blacklistInput').value = '';
  renderBlacklist();
  broadcastToTrade({ type: 'poe-bt-lists-update', blacklist: S.blacklist, trusted: S.trusted });
}

function renderBlacklist() {
  const wrap = $('blacklistItems');
  wrap.innerHTML = '';
  S.blacklist.forEach((name, i) => {
    const tag = el('span', 'tag-item bl', name + ' ');
    const btn = el('button', '', '✕');
    btn.addEventListener('click', () => {
      S.blacklist.splice(i, 1);
      store.set({ blacklist: S.blacklist });
      renderBlacklist();
      broadcastToTrade({ type: 'poe-bt-lists-update', blacklist: S.blacklist, trusted: S.trusted });
    });
    tag.appendChild(btn);
    wrap.appendChild(tag);
  });
}

function addTrusted() {
  const name = $('trustedInput').value.trim();
  if (!name || S.trusted.includes(name)) return;
  S.trusted.push(name);
  store.set({ trusted: S.trusted });
  $('trustedInput').value = '';
  renderTrusted();
  broadcastToTrade({ type: 'poe-bt-lists-update', blacklist: S.blacklist, trusted: S.trusted });
}

function renderTrusted() {
  const wrap = $('trustedItems');
  wrap.innerHTML = '';
  S.trusted.forEach((name, i) => {
    const tag = el('span', 'tag-item tr', name + ' ');
    const btn = el('button', '', '✕');
    btn.addEventListener('click', () => {
      S.trusted.splice(i, 1);
      store.set({ trusted: S.trusted });
      renderTrusted();
      broadcastToTrade({ type: 'poe-bt-lists-update', blacklist: S.blacklist, trusted: S.trusted });
    });
    tag.appendChild(btn);
    wrap.appendChild(tag);
  });
}

/* ══════════════════════════════════════════════════
   BROADCAST TO TRADE PAGE (via parent)
══════════════════════════════════════════════════ */
function broadcastToTrade(msg) {
  window.parent.postMessage(msg, '*');
}

function copyToClipboard(text) {
  // Clipboard API blocked in WAR iframes — route through parent content script
  window.parent.postMessage({ type: 'poe-bt-copy', text }, '*');
}

/* ══════════════════════════════════════════════════
   UI HELPERS
══════════════════════════════════════════════════ */
function showStatus(txt) { $('statusText').textContent = txt; $('statusRow').classList.remove('hidden'); }
function hideStatus()    { $('statusRow').classList.add('hidden'); }
function showError(txt)  { $('errorText').textContent = txt; $('errorRow').classList.remove('hidden'); }
function hideError()     { $('errorRow').classList.add('hidden'); }

let _toastTimer = null;
function showToast(txt, isError = true) {
  const toast = $('globalToast');
  if (!toast) return;
  toast.textContent = (isError ? '⚠ ' : '✓ ') + txt;
  toast.style.background = isError ? '#5a1010' : '#105a10';
  toast.style.borderColor = isError ? '#aa2020' : '#20aa20';
  toast.style.color = isError ? '#ffaaaa' : '#aaffaa';
  toast.classList.remove('hidden');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => toast.classList.add('hidden'), 3500);
}

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60)    return 'just now';
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/* ══════════════════════════════════════════════════
   BOOT
══════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', init);

