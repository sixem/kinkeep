# Operations and recovery

These commands use the Docker Compose setup in the project root.

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

On Windows, open PowerShell in the project directory and use `setup.ps1`:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1 status
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1 restart
```

`update` rebuilds from the current files; `reinstall` also recreates the container. Neither removes the named archive volume. Avoid Docker volume removal commands unless you intend to delete the archive. Stop following `logs` with Ctrl+C. The dashboard normally opens at <http://127.0.0.1:8765>.

Docker Desktop must be running on Windows; WSL also needs access to Docker. Windows and WSL commands use the same volume only when their Docker contexts point to the same daemon. The server binds to loopback by default; configure the extension with the URL as seen by the browser, normally `http://127.0.0.1:8765`.

## Token and local data

The first start creates `.env` with a `KINEXPORT_TOKEN`; later starts reuse it. The extension stores the token in local browser storage, and the dashboard stores it for the current tab session. The token controls access but does not encrypt the database or backups. Treat tokens, extension settings, archives and backups as private; filesystem permissions vary by platform.

To rotate the token, replace `KINEXPORT_TOKEN` in `.env` with a new random secret of at least 32 characters. Restart the server, save the new token in the extension and unlock the dashboard with it. The old token stops working after restart; archived data is unchanged. Keep tokens out of URLs, screenshots, logs and issue reports.

## Export and backup

- **Export ZIP** downloads a portable ZIP64 archive containing a manifest, metadata-only SQLite database and separate media files. Import merges it into the current archive. The metadata database alone does not contain the images.
- **SQLite backups** downloads a consistent database containing the full archive. Restoring it **replaces** the current archive after confirmation. Before restoring, the server writes a recovery copy to `/data/backups/` in the same volume; that copy is not an independent backup.

Both formats are unencrypted. Keep separate copies and test recovery in an isolated archive. ZIP import supports KinExport portable archives, not JSON or arbitrary ZIPs; SQLite restore accepts the current supported schema.

Filenames include the downloading browser's local date, 24-hour time and UTC offset, for example `kinexport-backup-2026-11-17T09-15-30+01-00.sqlite3`. `Z` indicates UTC.

To copy pre-restore recovery files out of the running Docker volume:

```sh
mkdir -p ./kinexport-recovery
docker compose --project-name kinexport-local --env-file .env cp archive:/data/backups/. ./kinexport-recovery
```

Allow several times the archive size in free disk space for transfer staging. Uploads are limited to 64 GiB, expanded ZIP contents to 128 GiB, individual images to 8 MiB, and ZIP entries to 500,000; export and backup also have size limits. Only one transfer runs at a time. Do not interrupt a transfer or remove its staging files.

## Troubleshooting

- **Dashboard unavailable:** Check Docker, then run the setup script's `status` and `logs` commands. Confirm port 8765 is available on loopback.
- **Extension unavailable or token rejected:** Check the saved URL and token, grant server access, and select **Test connection**. After token rotation, update both the extension and dashboard. The health endpoint alone does not validate the token.
- **No new records:** Enable archiving, open a signed-in Kindroid tab and select the correct account and Kin in the dashboard. Refresh Kindroid after loading or reloading the extension. Browsing chats or settings can expose more data to the observer.
- **Account not verified / some data could not be captured:** Wait for Kindroid to load and check the account. The extension skips ambiguous records; changes to Kindroid may require an update.
- **Images missing:** Check the image-archiving toggle. Firefox does not support image capture. Chrome and Brave capture matching, already-loaded images, which may be previews; browser limits or page changes can prevent capture.
- **Import or restore fails:** Check the file format, disk space, transfer limits and server logs. Keep the existing archive and original backup until recovery is verified.

Review logs before sharing. Never include tokens, private messages, profile text, images or database files in public reports.
