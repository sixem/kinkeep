# Release preparation

## Versions and checks

Keep versions synchronized in `package.json`, `server/package.json`, both package versions in `server/package-lock.json`, `extension/package.json`, `extension/manifest.json`, and the welcome label in `server/public/index.html`. Archive format and database schema changes require separate compatibility and migration review.

With Node.js 24+ and ImageMagick 7 with WebP support:

```sh
npm ci --prefix server --ignore-scripts
npm run check
```

The checks validate versions, manifest assets, JavaScript syntax and tests. Also exercise affected extension and dashboard flows with synthetic data in Chrome or Brave; automated tests cannot guarantee compatibility with Kindroid's page and cache.

## Data and container verification

Before testing an upgrade, save a SQLite backup and portable ZIP outside the archive volume. Test ZIP import and SQLite restore on a **separately configured server with a disposable database**. Restore replaces the target database, so verify the endpoint, path and volume first. Check that messages, profiles and images survive import and restore. Never test restores or remove volumes against the live archive.

Run `./scripts/smoke-docker.sh` with Docker Compose v2 to test the candidate container in a disposable volume. It checks health, thumbnails, ZIP import/export and SQLite backup/restore; it does not publish a port or use the normal archive. CI runs Node checks without a container daemon. Check dashboard access and affected flows separately. See the [operations guide](OPERATIONS.md) for disk-space and recovery requirements. Test upgrades and compatibility when changing the schema or archive formats.

## Extension distribution

Development uses the unpacked `extension/` in Chromium or the temporary package built with `npm run build:firefox`. Neither is a signed browser-store release. Permanent Firefox installation requires Mozilla signing; public distribution requires separate packaging and review.
