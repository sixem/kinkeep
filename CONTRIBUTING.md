# Contributing to KinExport

Preserve existing archives and the passive capture model: observe data already available in the browser without directly fetching Kindroid data or automating interactions.

## Development setup

Use Node.js 24 or newer and ImageMagick 7 with WebP support (`magick`). From the project root:

```sh
npm ci --prefix server --ignore-scripts
npm run check
```

Load `extension/` as an unpacked Chrome or Brave extension. For Firefox, run `npm run build:firefox` and load `dist/firefox/manifest.json` through `about:debugging`. Rebuild and reload the Firefox package after changes; refresh the Kindroid tab to reload content scripts.

The Firefox build uses an explicit runtime asset list in `scripts/build-firefox.mjs`. Add new imports and popup assets there.

With Docker and Compose v2, `./scripts/smoke-docker.sh` runs an isolated test using synthetic data. On Windows, `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test\setup-windows.ps1` tests the PowerShell setup script without contacting Docker.

## Project layout

- `extension/`: browser extension and capture tests.
- `server/`: API, SQLite archive, dashboard and portable archives.
- `scripts/`: project checks and build scripts.
- `docker-compose.yml`, `setup.sh`, `setup.ps1`: container configuration and setup.

## Making changes

- Use synthetic data; keep tokens, conversations, images and databases out of logs, screenshots and bug reports.
- Preserve account and Kin identity, existing records, and import and backup behavior. Test migrations and restores when changing storage or archive formats.
- Skip ambiguous source data rather than guessing timestamps or identity.
- Run `npm run check` and exercise user-facing changes in a browser.
- Keep version labels in sync. See the [release guide](docs/RELEASING.md).
