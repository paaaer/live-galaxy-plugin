# Live Galaxy

An Obsidian plugin that shows your vault as a 3D galaxy: notes are stars with planets and moons, links are animated flows between them, and a black hole sits at the centre. Desktop only.

## Features

- Notes as stars (class and colour from note size and age), with science-based planetary systems, asteroid belts and moons.
- Visible spiral arms with an arm-winding slider; tilt, rotation, spread and zoom controls.
- Link styles (light pulses, tiny ships, cosmic web, neon glow, flowing dashes) and link types (local, bridge, mutual, index, embed, property).
- Black hole styles: Clean event horizon, physically ray-traced lensed disk, Classic, Quasar, Gargantua; adjustable size and organic jets.
- Timeline playback, search, quality levels (Low to Ultra, or Auto) and saved presets (camera and settings).
- Shift-click a star or planet to fly to it; popout window mode with no Obsidian chrome.
- Optional live usage stream API (REST hook) that animates activity into the black hole.

## Install

Manual: copy `main.js`, `manifest.json` and `styles.css` into `<vault>/.obsidian/plugins/live-graph/` (the folder must be named `live-graph`), restart Obsidian and enable **Live Galaxy** under Community plugins.

With [BRAT](https://github.com/TfTHacker/obsidian42-brat): add `paaaer/live-galaxy-plugin` as a beta plugin.

## Use

- Command **Open Live Galaxy** opens it in a tab; **Open Live Galaxy in its own window** opens a clean popout with a drag bar.
- Drag: orbit. Right/Shift-drag: pan. Wheel: zoom to cursor. Double-click: fly to star. Shift-click: zoom to star or planet.
- Sliders have a tick at their neutral value; releasing near it snaps to it.

## Development

The engine (`Galaxy` class) has no DOM dependency beyond canvas, so it runs headless:

```
npm i @napi-rs/canvas      # in a scratch dir; set CANVAS_DIR to it
node scripts/smoke.js [notes]
```

Edit `main.js` directly. `scripts/sync.ps1` copies the plugin files between a vault install and this repo.

Release: bump `version` in `manifest.json`, add it to `versions.json` and `CHANGELOG.md`, then run `scripts/release.ps1` to build `dist/live-galaxy-<version>.zip`.

`data.json` (settings, presets, usage token) is never committed.

## License

MIT
