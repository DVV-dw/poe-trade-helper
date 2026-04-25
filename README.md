
# PoE Trade Helper

Chrome extension. Side panel for Path of Exile 1 & 2 trade site.

## Features

- **Bookmarks** — save trade searches in folders, export/import as code.
- **Builds** — import from [pobb.in](https://pobb.in), parse PoB data.
- **History** — track whisper activity.
- **Tools** — Discord webhooks, price helpers.
- **PoE 1 + PoE 2** — both trade sites supported.

## Install

1. Clone or download this repo.
2. Open `chrome://extensions`.
3. Enable **Developer mode** (top-right).
4. Click **Load unpacked**.
5. Select the `poe-trade-helper-v3.0.0` folder.

## Usage

1. Open [pathofexile.com/trade](https://www.pathofexile.com/trade) or `/trade2`.
2. Side panel injects automatically.
3. Pin via the puzzle-piece icon for quick access.

## Permissions

| Permission | Reason |
|---|---|
| `storage` | save bookmarks, builds, settings |
| `tabs` | open trade searches in new tabs |
| `scripting` | inject side panel into trade pages |

Host access: `pathofexile.com`, `pobb.in`, `poe.ninja`, `discord.com`.

## Structure

```
background/service_worker.js   # API calls, webhooks, storage cache
content/trade_inject.js        # injects sidepanel iframe
sidepanel/                     # UI (HTML/CSS/JS) + PoB parser
icons/                         # extension icons
manifest.json                  # MV3 manifest
```

## Version

3.0.0 — Manifest V3.
