# KinKeep

KinKeep saves Kindroid conversations, profiles, and journal entries to a local archive as you browse. You can search messages, review earlier versions, and export your archive from the browser dashboard.

Capture covers data already loaded in a signed-in Kindroid tab. The extension does **not** fetch missing history unless you browse through it.

Optional image capture in Chrome and Brave uses a page snapshot that can fire off some small extra requests. Leave **Image archiving** off (the default) for zero extra requests to Kindroid if you're concerned about their ToS.

## Start the archive

Run one of the following commands from the project directory with Docker and Compose v2 running.

**Windows PowerShell**

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1 start
```

**Linux or WSL**

```sh
./setup.sh start
```

The shell script uses OpenSSL to generate the access token. On WSL, enable your distribution in [Docker Desktop's WSL integration settings](https://docs.docker.com/desktop/features/wsl/).

Setup starts the dashboard at [127.0.0.1:8765](http://127.0.0.1:8765) and creates an access token in the project's `.env` file. Copy the value of `KINKEEP_TOKEN` for the next step.

## Connect the extension

- **Chrome or Brave** — Open `chrome://extensions` or `brave://extensions`, enable developer mode, choose **Load unpacked**, and select the `extension/` folder.
- **Firefox 140+** — With Node.js 24+ installed, run `npm run build:firefox` from the project directory. Open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and select `dist/firefox/manifest.json`. Repeat the loading step after restarting Firefox.

1. Open the extension popup. Enter the archive URL and token, choose **Save settings**, and allow access to the archive server.
2. Choose **Test connection**, then enable **Archiving**. Refresh any Kindroid tab that was open during installation.
3. Browse Kindroid. Choose **Open archive** in the popup and enter the same token to view captured records as they are logged.

The database persists in a Docker volume. Use **SQLite backups → Download backup** to keep an independent copy. A portable ZIP can merge records into another KinKeep archive. Both formats contain unencrypted private data, so keep that in mind when storing it.

## Documentation

- [Capture coverage and extension permissions](extension/README.md)
- [Server operation, backups, and troubleshooting](docs/OPERATIONS.md)
- [Capture and storage design](docs/ARCHITECTURE.md) · [HTTP API](server/README.md)
- [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

## License and credits

KinKeep’s original code is published without a project license. KinKeep uses [Inter](server/public/fonts/INTER-LICENSE.txt) for typography and [Lucide icons](server/public/icons/LUCIDE-LICENSE.txt) in the dashboard.
