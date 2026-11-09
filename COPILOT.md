# Live Galaxy project memory

## Project

Live Galaxy is a desktop-only Obsidian plugin that visualizes vault notes as a 3D galaxy. Notes are stars and planetary systems; note links are animated flows. It does not modify notes and stores its settings, presets, usage statistics, and token in the plugin's `data.json`.

The plugin ID and install folder differ: the manifest ID is `live-graph`, and Obsidian installs it at `.obsidian/plugins/live-graph/`.

## Development workflow

- The working plugin copy is in the Obsidian vault at `C:\Users\1430507\OneDrive - Danaher\Documents\Obsidian\WurkObsAi\.obsidian\plugins\live-graph`.
- Edit and test in the vault plugin folder, then run `scripts\sync.ps1` in this repository to copy `main.js`, `manifest.json`, and `styles.css` from the vault into the repo. Use `scripts\sync.ps1 -ToVault` for the reverse direction.
- The engine can be smoke-tested headlessly with `node scripts/smoke.js [notes]`; the README describes setting up `@napi-rs/canvas` in a scratch directory and `CANVAS_DIR`.
- For releases, update the version in `manifest.json`, add it to `versions.json` and `CHANGELOG.md`, then run `scripts\release.ps1`. The archive contains only the three plugin files; do not include `data.json`.
- `data.json`, `dist/`, and `node_modules/` are ignored by Git.

## Integration and compatibility notes

- The optional Stream API and Local REST API hook are off by default; existing installs that already enabled them preserve their setting. The Stream API listens on loopback and is token-protected. The REST hook observes Local REST API activity without changing responses.
- Stream events are intended to animate activity into the black hole. They must not read or modify vault content.
- Preserve existing settings and presets when changing behavior; older presets may contain only camera settings.
- The plugin has been smoke-tested headlessly, but that does not replace checking the UI after reloading the plugin in Obsidian.

## Engineering history

The plugin evolved from an early galaxy visualization into the current feature set: spiral arms and clusters, camera controls, timeline and search, link-type/style controls, planets and moons, several black-hole render styles, quality/performance controls, saved presets, and a popout window. The October 2026 work added the visual and interaction features, including shift-click navigation, timeline playback, and optional usage-stream integrations.

The vault memory log recorded the following follow-ups during October 2026. These are historical notes, not confirmed open issues; check the current code and behavior before acting on them:

- Timeline visibility of planets belonging to hidden notes.
- Persistence of link-type and timeline panel state.
- Planet hover details and richer planetary textures.
- Validation of appearance and panel behavior in Obsidian, beyond headless smoke tests.
