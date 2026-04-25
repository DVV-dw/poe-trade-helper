/**
 * PoB Build Parser — Fixed decompression
 *
 * PoB build code format:
 *   1. Take the XML string
 *   2. zlib-compress it (deflate WITH zlib wrapper, i.e. DecompressionStream('deflate'))
 *   3. Base64-encode with URL-safe chars: replace + → - and / → _
 *   4. Strip padding =
 *
 * So to decode:  base64url → base64 standard → binary → zlib-decompress → XML
 */
class PoBParser {

  static async decodeToXML(code) {
    // 1. Restore standard base64
    let b64 = code.trim()
      .replace(/-/g, '+')
      .replace(/_/g, '/');
    // Re-add padding
    const pad = b64.length % 4;
    if (pad === 2) b64 += '==';
    else if (pad === 3) b64 += '=';

    // 2. Base64 → Uint8Array
    const binStr = atob(b64);
    const bytes = new Uint8Array(binStr.length);
    for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);

    // 3. Try zlib (deflate with header) first — this is what PoB uses
    try {
      return await PoBParser._decompress(bytes, 'deflate');
    } catch (_) {}

    // 4. Fallback: raw deflate
    try {
      return await PoBParser._decompress(bytes, 'deflate-raw');
    } catch (_) {}

    // 5. Fallback: gzip
    try {
      return await PoBParser._decompress(bytes, 'gzip');
    } catch (e) {
      throw new Error('Decompression failed — is this a valid PoB build code?');
    }
  }

  static _decompress(bytes, format) {
    // Wrap in explicit Promise so stream errors propagate correctly to callers.
    // DecompressionStream errors fire on reader.read() rejections which escape
    // async for-loops and become unhandled rejections instead of caught errors.
    return new Promise((resolve, reject) => {
      const ds     = new DecompressionStream(format);
      const writer = ds.writable.getWriter();
      const reader = ds.readable.getReader();
      const chunks = [];

      function pump() {
        reader.read().then(({ done, value }) => {
          if (done) {
            const total = chunks.reduce((s, c) => s + c.length, 0);
            const out   = new Uint8Array(total);
            let off = 0;
            for (const c of chunks) { out.set(c, off); off += c.length; }
            resolve(new TextDecoder().decode(out));
          } else {
            chunks.push(value);
            pump();
          }
        }).catch(err => { reader.cancel().catch(() => {}); reject(err); });
      }

      writer.write(bytes)
        .then(() => writer.close())
        .catch(err => reject(err));

      pump();
    });
  }

  /* ── XML parsing ─────────────────────────────────────── */

  static getGameVersion(xml) {
    if (/PathOfExile2|game=["']2["']|gameVersion=["']2/i.test(xml)) return 'poe2';
    return 'poe1';
  }

  static parseItemText(text) {
    const lines = text.trim().split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) return null;

    if (!lines[0].startsWith('Rarity:')) return null;
    const rarity = lines[0].replace('Rarity:', '').trim().toUpperCase();
    const name = lines[1];
    if (!name) return null;

    // baseType is 3rd line if it doesn't start with --- or contain :
    const baseType = (lines[2] && !lines[2].startsWith('---') && !lines[2].includes(':'))
      ? lines[2] : null;

    let itemLevel = null;
    const requirements = {};
    let inReq = false;
    for (const l of lines) {
      const mLvl = l.match(/^Item Level:\s*(\d+)/i);
      if (mLvl) { itemLevel = parseInt(mLvl[1]); }
      if (/^Requirements:$/i.test(l)) { inReq = true; continue; }
      if (l.startsWith('---') || l.startsWith('====')) { inReq = false; continue; }
      if (inReq) {
        const mReq = l.match(/^(Level|Str|Dex|Int):\s*(\d+)/i);
        if (mReq) requirements[mReq[1].toLowerCase()] = parseInt(mReq[2]);
      }
    }

    return { rarity, name, baseType, itemLevel, requirements, rawText: text.trim(), isUnique: rarity === 'UNIQUE' };
  }

  static parseEquippedItems(xml) {
    const doc = new DOMParser().parseFromString(xml, 'text/xml');

    // id → parsed item
    const itemMap = {};
    for (const el of doc.querySelectorAll('Item')) {
      const id = el.getAttribute('id');
      if (!id) continue;
      const parsed = PoBParser.parseItemText(el.textContent || '');
      if (parsed) itemMap[id] = parsed;
    }

    const SLOT_LABELS = {
      'Weapon 1': 'Main Hand', 'Weapon 2': 'Off Hand',
      'Helmet': 'Helmet', 'Body Armour': 'Body',
      'Gloves': 'Gloves', 'Boots': 'Boots',
      'Amulet': 'Amulet', 'Ring 1': 'Ring 1', 'Ring 2': 'Ring 2',
      'Belt': 'Belt',
      'Flask 1': 'Flask 1', 'Flask 2': 'Flask 2', 'Flask 3': 'Flask 3',
      'Flask 4': 'Flask 4', 'Flask 5': 'Flask 5',
    };

    const equipped = [];
    for (const slotEl of doc.querySelectorAll('Slot')) {
      const slotName = slotEl.getAttribute('name') || '';
      const itemId = slotEl.getAttribute('itemId');
      if (itemId && itemId !== '0' && itemMap[itemId]) {
        equipped.push({ ...itemMap[itemId], slot: SLOT_LABELS[slotName] || slotName });
      }
    }

    // Also grab jewel slots
    for (const el of doc.querySelectorAll('[itemId]')) {
      if (el.tagName === 'Slot') continue;
      const itemId = el.getAttribute('itemId');
      if (itemId && itemId !== '0' && itemMap[itemId]) {
        const slotName = el.getAttribute('name') || 'Jewel';
        if (!equipped.find(e => e.name === itemMap[itemId].name)) {
          equipped.push({ ...itemMap[itemId], slot: slotName });
        }
      }
    }

    return equipped;
  }

  static parseAllItems(xml) {
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    const items = [];
    for (const el of doc.querySelectorAll('Item')) {
      const parsed = PoBParser.parseItemText(el.textContent || '');
      if (parsed) items.push(parsed);
    }
    return items;
  }

  static async extractUniquesFromCode(buildCode) {
    const xml = await PoBParser.decodeToXML(buildCode);
    const game = PoBParser.getGameVersion(xml);
    const equippedItems = PoBParser.parseEquippedItems(xml);
    const allItems = PoBParser.parseAllItems(xml);

    const equipped = equippedItems.filter(i => i.isUnique);
    const equippedNames = new Set(equippedItems.map(i => i.name));
    const allUniques = allItems.filter(i => i.isUnique);
    const unequipped = allUniques.filter(i => !equippedNames.has(i.name));

    // Deduplicate by name
    const seen = new Set();
    const dedupEquipped = equipped.filter(i => {
      if (seen.has(i.name)) return false;
      seen.add(i.name); return true;
    });
    const seenAll = new Set(dedupEquipped.map(i => i.name));
    const dedupUnequipped = unequipped.filter(i => {
      if (seenAll.has(i.name)) return false;
      seenAll.add(i.name); return true;
    });

    return { equipped: dedupEquipped, unequipped: dedupUnequipped, all: [...dedupEquipped, ...dedupUnequipped], game };
  }
}
