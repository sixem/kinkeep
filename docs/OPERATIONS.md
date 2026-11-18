# Operations and recovery

Run the setup script from the project directory. On Windows use `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1`. On Linux or WSL use `./setup.sh`. Append a command or run the script by itself for the menu.

| Command | Action |
| --- | --- |
| `start` / `update` | Build the archive image from the current files and start the service |
| `status` / `logs` | Show container status or follow server logs |
| `stop` / `restart` | Stop or restart the service |
| `reinstall` | Rebuild and recreate the container using its existing data volume |

Docker stores the archive in the `kinkeep-local_archive-data` volume, which persists across updates and reinstalls. Windows and WSL use the same archive when they connect to the same Docker daemon.

## Access token

Setup creates `KINKEEP_TOKEN` in `.env` on first start. To rotate it, replace the value with a random secret of at least 32 characters and run the setup script's `restart` command. Save the new token in the extension and unlock the dashboard with it. The extension stores the token locally. The dashboard keeps it in the tab session until you lock the archive or close the tab.

## Export and restore

| Dashboard action | Result |
| --- | --- |
| **Export ZIP** / **Import ZIP** | A portable ZIP contains a manifest, SQLite metadata, and separate image files. Import merges it into the current archive. |
| **SQLite backups → Download backup** | Download a consistent copy of the full database, including images. Keep it outside the Docker volume. |
| **SQLite backups → Restore backup** | Restore **replaces** the current archive after confirmation. The server first saves the previous database under `/data/backups/` in the same volume. |

If records change while the recovery copy is being made, restore stops. Pause capture and retry. After restoring, switch archiving off and on to make open tabs recheck records still available to them.

To copy recovery files from the container to a local directory, run the following from the project root.

```sh
mkdir -p ./kinkeep-recovery
docker compose --project-name kinkeep-local --env-file .env cp archive:/data/backups/. ./kinkeep-recovery
```

Transfers use temporary disk space and run one at a time. Allow several times the archive size in free space. Uploads are limited to 64 GiB, expanded ZIP contents to 128 GiB, individual images to 8 MiB, and ZIP files to 500,000 entries. Test recovery in a disposable archive.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Dashboard unavailable | Run `status` and `logs`. Check Docker and loopback port 8765. |
| Connection test fails | Check the archive URL, token, and browser permission for the archive host. |
| Missing records | Enable archiving, verify the signed-in account, and select the corresponding Kin in the dashboard. Refresh the Kindroid tab after reloading the extension. |
| Missing images | Check browser support, the image toggle, and which images have loaded. See [capture coverage](../extension/README.md#capture-coverage). |
| Import or restore fails | Verify the file format and free space, and wait for any active transfer to finish. ZIP import accepts KinKeep portable archives. SQLite restore requires a supported database schema. |
