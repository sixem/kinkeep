# Contributing to KinExport

KinExport is an early-stage local archive. Changes should preserve existing archives and the extension's passive capture model: it may inspect data already available in the browser and communicate with the configured archive server, but must not request data from Kindroid or automate interactions with it.

## Development setup

Use Node.js 24 or newer and ImageMagick 7 with WebP support (`magick`) for the complete test suite. From the project root:

```sh
npm ci --prefix server
npm run check
```

The root check validates the version and extension manifest files, checks JavaScript syntax, and runs both test suites. The extension has no build step. Load `extension/` as an unpacked extension in Chrome or Brave, reload it after changing extension code, and refresh the Kindroid tab to load updated content scripts. Use `./setup.sh` to manage the Docker server. The root README covers setup and backups.

With Docker and Compose v2 available, `./scripts/smoke-docker.sh` builds and tests an isolated container using synthetic data. It checks health, thumbnail generation, ZIP import/export and SQLite backup/restore, then cleans up its own temporary resources.

## Project layout

- `extension/` contains the browser extension, passive observers and extension tests.
- `server/` contains the local API, SQLite archive, dashboard, portable archive implementation and server tests.
- `scripts/` contains checks shared by the project.
- `docker-compose.yml` and `setup.sh` configure and manage the local container.

## Making changes

- Treat chat, profile, image, account and token data as private. Use synthetic fixtures and avoid including real data in logs, screenshots or bug reports.
- Preserve stable account and Kin identity, existing records, and import/backup behavior. Test migrations and restore paths when changing the database or archive formats.
- Keep missing or ambiguous source data distinct from verified observations. Do not infer unsupported timestamps or identity.
- Run `npm run check` before submitting changes. For user-facing changes, also exercise the affected flow in a browser; automated tests do not replace that check.
- Keep the versions in the root, server and extension package files, server lockfile, extension manifest and dashboard welcome page in sync. The project check verifies them. See the [release guide](docs/RELEASING.md) for release preparation and data checks.
