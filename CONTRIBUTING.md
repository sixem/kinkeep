# Contributing to KinKeep

## Development

Install Node.js 24+ and ImageMagick 7 with WebP support (`magick`). From the project root, install the server dependencies and run the checks.

```sh
npm ci --prefix server --ignore-scripts
npm run check
```

| Directory | Contents |
| --- | --- |
| `extension/` | Browser capture, background worker, popup, and extension tests |
| `server/` | SQLite storage, HTTP API, archive transfers, and server tests |
| `server/public/` | Dashboard |
| `scripts/` | Builds, project checks, and setup tests |

Use the [browser installation instructions](README.md#connect-the-extension) to test UI changes. Rebuild the Firefox package after changing the extension. Reload the extension and refresh the Kindroid tab to pick up updated content scripts.

## Changes and tests

- Keep capture passive. Skip records whose account, Kin, or required timestamp cannot be verified.
- Test storage changes against existing archive formats. Verify both ZIP merge and SQLite restore with disposable databases.
- Use synthetic data in tests, reports, and screenshots. Keep tokens and personal archive contents private.

With Docker available, run `./scripts/smoke-docker.sh` for an isolated container test. On Windows, `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\test\setup-windows.ps1` checks the PowerShell setup flow with a mock Docker command.

See [release preparation](docs/RELEASING.md) for versioning and packaging.
