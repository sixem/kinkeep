# Operations and recovery

These instructions apply to the Docker Compose setup in the project root. The archive is under active development; capture and restore should be checked against your own data before you rely on them.

## Start, update and stop

On Linux or WSL, run `./setup.sh` for the menu or use a command directly:

```sh
./setup.sh start
./setup.sh status
./setup.sh logs
./setup.sh update
./setup.sh restart
./setup.sh stop
```

On Windows, open PowerShell in the project directory and run the menu or the same commands through `setup.ps1`:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1 status
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1 restart
```

`update` rebuilds from the current files; `reinstall` rebuilds and recreates the application container. Neither intentionally removes the named archive volume. Avoid Docker volume removal commands unless you intend to delete the archive. `logs` follows output until interrupted with Ctrl+C. The server normally opens at <http://127.0.0.1:8765>.

Docker Desktop must be running for either Windows path; the WSL path additionally needs Docker access from the distribution. The scripts manage the same named volume only when their Docker contexts point to the same Docker daemon. The server's published port is bound to the host loopback interface. In the browser extension use the loopback URL as seen by the browser, normally `http://127.0.0.1:8765`.

## Token and local data

The first start creates `.env` with `KINEXPORT_TOKEN` if no `.env` exists; subsequent starts reuse it. Treat the file, browser extension settings, archive database and backups as sensitive. The extension stores the token in local browser storage and the dashboard stores it in session storage. The token controls API access; it does not encrypt archive contents or backups. Filesystem permissions vary by platform and mount configuration.

To rotate a token, generate a new random secret of at least 32 characters, replace only the `KINEXPORT_TOKEN` value in `.env`, and run `./setup.sh restart` on Linux/WSL or the Windows `restart` command above. Enter and save the new token in the extension popup and unlock the dashboard with it. The old token stops authorizing requests after the server restarts. Rotation does not alter the archived data. Do not put the token in URLs, screenshots, shared logs or issue reports.

## Export and backup

The dashboard offers two formats:

- **Export ZIP** creates a portable ZIP64 archive with a manifest, a metadata-only SQLite database and individual media files. Importing a supported ZIP merges data into the current archive. The metadata database on its own is not a full backup of the images.
- **SQLite backups** downloads a consistent SQLite database containing the full archive, including image bytes. Restoring it **replaces** the current archive after confirmation. Before replacement, the server writes a recovery copy of the current database in the volume's `/data/backups/` directory. The recovery copy is in the same volume and is not an independent backup.

Save backup files separately from the machine and volume as appropriate, restrict access, and test recovery in an isolated archive. Both export formats are unencrypted. ZIP import accepts the supported KinExport portable format, not JSON or arbitrary ZIPs; SQLite restore accepts the current supported schema.

Dashboard downloads include the browser's local date, 24-hour time and UTC offset in their filenames, for example `kinexport-backup-2026-11-17T09-15-30+01-00.sqlite3`. A `Z` suffix indicates UTC.

For a running Docker setup, copy the server's pre-restore recovery copies out of its volume with:

```sh
mkdir -p ./kinexport-recovery
docker compose --project-name kinexport-local --env-file .env cp archive:/data/backups/. ./kinexport-recovery
```

Transfer staging uses disk space alongside the live database. Allow several times the archive size free for export, import or restore; actual space depends on the contents. Uploads are limited to 64 GiB, expanded ZIP contents to 128 GiB, individual images to 8 MiB, and ZIP entries to 500,000. Export and backup also enforce size limits. The server handles one transfer at a time. Do not interrupt the process or remove staging files during an active transfer.

## Troubleshooting

- **Dashboard unavailable:** Check that Docker Desktop or the Docker daemon is running, then use the setup script's `status` and `logs` commands. Confirm that port 8765 is available on loopback.
- **Extension says unavailable or token rejected:** Check the saved server URL and access token in the popup, grant the requested server permission, then select **Test connection**. If you changed the token, update it in both the popup and the dashboard. The health endpoint alone does not validate the token.
- **No new records:** Confirm archiving is enabled, a logged-in Kindroid tab is open, and the correct account and Kin are selected in the dashboard. After loading or reloading the extension, refresh the Kindroid tab. Browsing the relevant chat or settings may make additional already-loaded data observable.
- **Account not verified / some data could not be captured:** The extension skips ambiguous records rather than guessing identity. Wait for Kindroid to finish loading and confirm the account. A changed Kindroid page or cache format may require an extension update.
- **Images missing:** The extension captures matching resources already loaded in the page, not an entire remote gallery. Captures can be previews, and browser capture limits or a changed page can prevent collection.
- **Import or restore fails:** Check the format, available disk space, transfer size limits and server logs. Imports reject damaged or unsupported files. Keep your existing archive and the original backup until recovery has been verified.

Never include access tokens, private messages, profile text, images or database files in public bug reports. Logs can contain sensitive details and should be reviewed before sharing.
