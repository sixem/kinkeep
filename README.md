# KinExport

KinExport is a local-first archive for Kindroid. A Chromium extension observes data already available in your browser and sends it to a local server. The server stores the archive in SQLite and provides a dashboard, search, a digest, portable ZIP exports and SQLite backups.

**Status: early development.** Capture is best effort and depends on Kindroid's internal browser data and page layout, which can change without notice. An archive is not a complete or verified copy of a Kindroid account. Keep independent backups and check them before relying on them.

The extension does not click, scroll, navigate or make requests to Kindroid. It can observe account and Kin records, messages, journal entries, selected profile and settings fields, and some already-loaded portraits and selfie previews. Opening and browsing a page may expose more data to the observer. Favorites, original selfies that have not been loaded, and audio capture are not currently implemented.

## Get started

Requirements: Docker with Compose v2, OpenSSL for first-time token generation, and Chrome or Brave. On Windows with WSL, enable Docker Desktop's integration for your WSL distribution.

1. In this directory, start the server:

   ```sh
   ./setup.sh start
   ```

   The script creates `.env` with a random access token if it does not exist, builds the image and starts the archive at <http://127.0.0.1:8765>. Running `./setup.sh` without arguments opens an interactive menu. Use `./setup.sh help` for all commands.

2. Open `chrome://extensions` or `brave://extensions`, enable developer mode and select **Load unpacked**. Choose this project's `extension` directory, then pin KinExport from the extensions menu.
3. Open the extension popup. Enter `http://127.0.0.1:8765` and the `KINEXPORT_TOKEN` value from `.env`, select **Save settings**, and allow access to the server when prompted. Select **Test connection**, then enable **Archiving**.
4. Open the archive from the popup and enter the same token. Browse Kindroid normally to let the extension observe available information. Reopen or refresh an already-open Kindroid tab after installing or reloading the extension.

The token authorizes access to the archive; it does not decrypt Kindroid data or encrypt the database. Keep it and `.env` private. The extension stores the token in its local browser storage; the dashboard keeps it in the current tab's session storage until the tab closes or you lock the archive.

## Working with your archive

Select an account and Kin in the dashboard to browse the data collected for that pair. Message pages show the newest page on initial selection; use the pagination controls to browse other pages. Search covers archived messages. Profile fields may reflect unsaved editor drafts. Chat History entries without a verified matching timestamp are skipped; image captures may be previews rather than originals. See [how capture works](docs/ARCHITECTURE.md) for details and limitations.

If the server is unavailable, the extension reports the outage and sends a debounced notification. It does not have an offline queue. Data seen during an outage may be missed even after the connection returns; browsing it again may make it available, but is not guaranteed to do so.

The database is stored in a Docker named volume, so replacing the container preserves it. **A volume is not a backup.** The dashboard's **Export ZIP** produces a portable archive with separate media files. **SQLite backups** downloads a full database backup; restoring one replaces the current archive. Both contain private data and are unencrypted. Store copies outside the volume and verify recovery in a separate environment. See [operations and recovery](docs/OPERATIONS.md) for formats, limits, maintenance, token rotation and troubleshooting.

## Development and reference

The project has separate [`extension/`](extension/) and [`server/`](server/) components. To run the full local checks, install Node.js 24 or newer, install server dependencies with `npm ci --prefix server`, then run `npm run check` from the project root. See [CONTRIBUTING.md](CONTRIBUTING.md) for development details, the [release guide](docs/RELEASING.md) for release checks, the [extension README](extension/README.md) for capture behavior, and the [server README](server/README.md) for configuration and API endpoints.

The default Docker setup publishes the server only on host loopback. This is a local application, not a public multi-user service; deploying it beyond the local machine requires a separate security and transport design.
