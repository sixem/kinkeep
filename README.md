# KinExport

KinExport archives Kindroid conversations and profile data to a local SQLite database as you browse. It includes a dashboard, search, ZIP exports and SQLite backups.

**Early development:** capture is best effort and archives may be incomplete. Keep independent backups of data you want to preserve. See [how capture works](docs/ARCHITECTURE.md) for supported data and limitations.

## Setup

You need Docker with Compose v2 and Chrome, Brave, or Firefox 140 or newer. On Windows, install and start [Docker Desktop](https://docs.docker.com/desktop/setup/install/windows-install/).

### 1. Start the archive

**Windows:** Open PowerShell in the project folder and run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1 start
```

**WSL or Linux:** Install OpenSSL, open a shell in the project folder, and run:

```sh
./setup.sh start
```

For WSL, also enable [Docker Desktop integration](https://docs.docker.com/desktop/features/wsl/). Run either setup script without `start` for a menu to start, stop, update or reinstall the container. Updating and reinstalling preserve the archive volume.

### 2. Connect your browser

The setup script creates `.env` with an access token and starts the server at [127.0.0.1:8765](http://127.0.0.1:8765). Open `.env` and copy the value of `KINEXPORT_TOKEN`. Keep it private.

1. Install the extension:
   - **Chrome or Brave:** Open `chrome://extensions` or `brave://extensions`, enable developer mode, select **Load unpacked**, and choose the `extension` folder.
   - **Firefox:** Install Node.js 24 or newer, run `npm run build:firefox`, then open `about:debugging#/runtime/this-firefox`. Select **Load Temporary Add-on** and choose `dist/firefox/manifest.json`. Load it again after restarting Firefox.
2. Open the extension popup, enter the server address and token, and select **Save settings**. Allow server access if prompted, test the connection, and enable **Archiving**.
3. Open the archive from the popup and enter the same token. Browse Kindroid normally; refresh an already-open Kindroid tab after installing or reloading the extension.

The extension saves the token locally. The dashboard remembers it until you close the tab or lock the archive. Image archiving is available in Chrome and Brave.

## Backups

Use **Export ZIP** in the dashboard for a portable archive, or **SQLite backups** for a full database backup. Both contain private data and are unencrypted. Keep copies outside the Docker volume; reinstalling the container preserves the volume, but the volume is not a backup.

See [operations and recovery](docs/OPERATIONS.md) for backup, restore and troubleshooting instructions.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and tests, or browse the [extension](extension/README.md), [server](server/README.md) and [architecture](docs/ARCHITECTURE.md) documentation.
