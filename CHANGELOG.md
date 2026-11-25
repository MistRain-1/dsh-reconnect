# Changelog

## 2.1.0 — DeepSeek Harness 0.2.2 support

Fixes the "Did not load at start" failure on DeepSeek Harness 0.2.2-rc.5 (profile `desktop`, Windows).

### Why 2.0.0 did not load

- `package.json` had no `engines.dsh`. DSH judges `engines.dsh` first and only falls back to `@deepseek-ai/dsh-*` peer ranges when it is absent. The fallback hit peers on packages that no longer exist in 0.2.x (`@deepseek-ai/dsh-client-web-react`, `@deepseek-ai/dsh-client-ui-settings-plugins`), so the compatibility gate skipped the plugin.
- `src/index.js` imported `settingsNamespace` from `@deepseek-ai/dsh-settings`. In 0.2.x that package exports only `SettingsForms`, `redactSecrets` and `SettingsConflictError`, so the import failed. It also declared `inject = ["settings"]` and called `ctx.settings.register(...)`, which 0.2.x removed.
- The browser half used `ctx.settingsScope`, the `settings.plugin.item` slot and `@deepseek-ai/dsh-client-web-react`, none of which exist in 0.2.x.

### Changed

- Added `engines.dsh: ">=0.2.2-rc.1 <0.3.0-0"` and `engines.node: ">=22"`.
- Peer dependencies reduced to `@deepseek-ai/schemastery >=3.18.4` (the copy DSH ships). Removed the stale `@deepseek-ai/dsh-*` and `react` peers.
- Settings now follow the 0.2.x contract: the exported `Config` schema drives the settings form, every field is `.volatile()` (with a `meta.volatile` fallback for schemastery < 3.19), and `apply(ctx, config)` reads `{ get() }` references on every failed request, so a save in Settings takes effect without a restart.
- If `@deepseek-ai/schemastery` cannot be resolved, the plugin still loads and runs with defaults (no settings form) instead of failing to load.
- Removed `src/client.js`, the `dsh.client` manifest block and the `./client` export (the custom settings card relied on removed client APIs and could break web boot).

### Added

- Tests: 0.2.x config contract (volatile references, plain values, missing config), schema shape, and a manifest guard that checks the declared `engines.dsh` admits 0.2.2-rc.5 and that sources use no removed API.
- `CHANGELOG.md`, troubleshooting notes in the READMEs.

### Unchanged

- Retry policy, backoff, `Retry-After` handling, `llm/retry` events and cancellation behaviour.

### Not verified

- This release was checked against the DSH 0.2.x contracts described above and the unit tests in this repository. It has not been run inside a live DSH 0.2.2-rc.5 desktop session.

### Migration

- DSH 0.1.x and 0.2.0–0.2.1: keep using 2.0.0.
- Existing overrides in the profile (`maxDelayMs`, `retryQuota`, `retryUnknown`, `unknownMaxRetries`) keep their names and meaning.

## 2.0.0

Initial public release for DSH 0.1.x.
