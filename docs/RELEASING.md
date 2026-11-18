# Release preparation

1. Set the same version in the root, server, and extension `package.json` files, both package versions in `server/package-lock.json`, the extension manifest, and the dashboard welcome panel.
2. Run `npm ci --prefix server --ignore-scripts` and `npm run check` from the root. These check version labels, manifest assets, syntax, and tests.
3. Run `./scripts/smoke-docker.sh` to verify the candidate container with synthetic data in a disposable volume. The test covers thumbnails, archive writes, ZIP import/export, and SQLite backup/restore.
4. For a schema or archive format change, test upgrades and recovery from previous supported versions in a separate database. Verify messages, revisions, profiles, journal entries, and images after import and restore.
5. Run `npm run build:chromium` and `npm run build:firefox`. Load `dist/chromium/` in Chrome or Brave and `dist/firefox/manifest.json` in Firefox. Exercise the affected extension and dashboard flows with synthetic data.

Package the contents of each build directory with `manifest.json` at the archive root. The Firefox build is unsigned.
