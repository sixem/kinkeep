# KinExport

KinExport is a local-first archive for Kindroid. A browser extension observes data already available in your browser and sends it to a local server. The server stores the archive in SQLite and provides a dashboard, search, a digest, portable ZIP exports and SQLite backups.

**Status: early development.** Capture is best effort and depends on Kindroid's internal browser data and page layout, which can change without notice. An archive is not a complete or verified copy of a Kindroid account. Keep independent backups and check them before relying on them.

The extension does not click, scroll, navigate or make requests to Kindroid. It can observe account and Kin records, messages, journal entries, and selected profile and settings fields. Chrome and Brave can also capture some already-loaded portraits and selfie previews; image capture is not yet available in Firefox. Opening and browsing a page may expose more data to the observer. Favorites, original selfies that have not been loaded, and audio capture are not currently implemented.

## Get started

You need Docker with Compose v2 and Chrome, Brave, or Firefox 140 or newer. On Windows, install and start [Docker Desktop](https://docs.docker.com/desktop/setup/install/windows-install/) with Linux containers. Choose either the native PowerShell setup or the WSL/Linux setup below; both manage the same archive when run from the same checkout against the same Docker daemon.

### Windows: PowerShell

Open PowerShell, change to the folder containing `setup.ps1`, and start the archive:

```powershell
cd 'C:\path\to\kinexport'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1 start
```

Replace the example path with your actual project folder. The command works in Windows PowerShell 5.1 or PowerShell 7; the execution-policy setting applies only to the launched process. Windows uses its built-in cryptographic random number generator, so OpenSSL and Node.js are not required to run the archive container.

To open the interactive setup menu later, run the same command without `start`:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1
```

The menu can start, stop, restart, update or reinstall the container, show status and follow logs. Alternatively, append `status`, `stop`, `restart`, `update`, `reinstall`, `logs` or `help` to the command. Updating and reinstalling preserve the archive volume.

### WSL or Linux: shell

For WSL, enable [Docker Desktop integration for your distribution](https://docs.docker.com/desktop/features/wsl/) and keep Docker Desktop running. Linux needs a running Docker daemon. Install OpenSSL for first-time token generation, then open a shell in the project folder:

```sh
cd /path/to/kinexport
./setup.sh start
```

Run `./setup.sh` without arguments for the interactive menu, or use `./setup.sh status`, `stop`, `restart`, `update`, `reinstall`, `logs` or `help`. Updating and reinstalling preserve the archive volume.

### Connect the browser

The setup script creates `.env` with a random access token on first run, builds the server and starts it at <http://127.0.0.1:8765>. It reuses the existing `.env` on later runs. Open `.env` in a text editor and copy the value after `KINEXPORT_TOKEN=`; for example, run `notepad.exe .env` in PowerShell. Keep this value private and do not type it into a command.

1. Install the extension for your browser:

   - **Chrome or Brave:** Open `chrome://extensions` or `brave://extensions`, enable developer mode and select **Load unpacked**. Choose this project's `extension` directory.
   - **Firefox:** Install Node.js 24 or newer and run `npm run build:firefox` in the project folder. Open `about:debugging#/runtime/this-firefox`, select **Load Temporary Add-on**, and choose `dist/firefox/manifest.json`. A temporary Firefox installation must be loaded again after restarting Firefox.

2. Open the KinExport extension popup. Enter `http://127.0.0.1:8765` and the copied access token, select **Save settings**, and allow access to the server when prompted. Select **Test connection**, then enable **Archiving**.
3. Open the archive from the popup and enter the same token. Browse Kindroid normally to let the extension observe available information. Refresh an already-open Kindroid tab after installing or reloading the extension.

The token authorizes access to the archive; it does not decrypt Kindroid data or encrypt the database. Keep `.env` private. The extension stores the token in its local browser storage; the dashboard keeps it in the current tab's session storage until the tab closes or you lock the archive. After the extension is installed, start the container with the setup script whenever you need the archive.

## Working with your archive

Select an account and Kin in the dashboard to browse the data collected for that pair. Message pages show the newest page on initial selection; use the pagination controls to browse other pages. Search covers archived messages. Profile fields may reflect unsaved editor drafts. Chat History entries without a verified matching timestamp are skipped; image captures may be previews rather than originals. See [how capture works](docs/ARCHITECTURE.md) for details and limitations.

If the server is unavailable, the extension reports the outage and sends a debounced notification. It does not have an offline queue. Data seen during an outage may be missed even after the connection returns; browsing it again may make it available, but is not guaranteed to do so.

The database is stored in a Docker named volume, so replacing the container preserves it. **A volume is not a backup.** The dashboard's **Export ZIP** produces a portable archive with separate media files. **SQLite backups** downloads a full database backup; restoring one replaces the current archive. Both contain private data and are unencrypted. Store copies outside the volume and verify recovery in a separate environment. See [operations and recovery](docs/OPERATIONS.md) for formats, limits, maintenance, token rotation and troubleshooting.

## Development and reference

The project has separate [`extension/`](extension/) and [`server/`](server/) components. To run the full local checks, install Node.js 24 or newer, install server dependencies with `npm ci --prefix server`, then run `npm run check` from the project root. See [CONTRIBUTING.md](CONTRIBUTING.md) for development details, the [release guide](docs/RELEASING.md) for release checks, the [extension README](extension/README.md) for capture behavior, and the [server README](server/README.md) for configuration and API endpoints.

The default Docker setup publishes the server only on host loopback. This is a local application, not a public multi-user service; deploying it beyond the local machine requires a separate security and transport design.
