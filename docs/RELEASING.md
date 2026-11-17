# Release preparation

KinExport is an early-stage local application. This guide describes checks for a release candidate; it does not establish a publication channel or grant permission to publish one.

## Versions and checks

Keep the application version synchronized in `package.json`, `server/package.json`, `server/package-lock.json` (both the top-level and root-package versions), `extension/package.json`, `extension/manifest.json`, and the welcome label in `server/public/index.html`. The extension manifest must use a version accepted by Chromium. Application version changes do not automatically change the portable archive format or database schema; those require their own compatibility and migration review.

With Node.js 24 or newer and ImageMagick 7 with WebP support installed, run from the project root:

```sh
npm ci --prefix server
npm run check
```

The project check verifies matching versions and manifest asset paths, checks JavaScript syntax and runs the server and extension tests. Review failures and rerun after fixes. Also exercise affected dashboard and extension flows with synthetic data in Chrome or Brave; automated checks do not prove compatibility with Kindroid's changing page and cache structures.

## Data and container verification

Before testing an upgrade, save a separate SQLite backup and portable ZIP outside the archive volume. Verify export, ZIP import and SQLite restore against a **separately configured test server and disposable database** using synthetic data. Confirm the test endpoint, database path and Docker volume before restoring: SQLite restore replaces the target database. Verify that imported messages, profiles and images remain readable and that a full SQLite restore preserves them. Do not test restore or remove volumes against the live archive.

Run `./scripts/smoke-docker.sh` with Docker and Compose v2 to build and exercise the candidate container with synthetic data in a disposable volume. It checks health, thumbnail generation, ZIP import/export and SQLite backup/restore; it does not publish a port or use the normal archive. This smoke test is separate from CI, which runs the Node checks without access to a container daemon. Check dashboard access and any additional affected flows separately. Check sufficient disk space and review the [operations guide](OPERATIONS.md) for size limits and recovery details. Include upgrade and compatibility testing when changing schema, import or export behavior.

## Extension distribution

The current development workflow loads `extension/` directly as an unpacked Chromium extension. It has no build step and is not the same as a signed, reviewed or published browser-store release. A public distribution would require its own packaging, review, permissions and publication process; none is assumed by this guide.
