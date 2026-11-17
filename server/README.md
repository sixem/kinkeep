# KinExport archive server

The archive server uses Node.js 24, SQLite and ImageMagick 7 for thumbnails. For the recommended container setup, see the [main README](../README.md).

To run locally for development:

```sh
npm ci --ignore-scripts
export KINEXPORT_TOKEN="replace-with-a-random-secret-of-at-least-32-characters"
npm start
```

The server listens on `127.0.0.1:8765` and stores its database at `./data/kinexport.sqlite` by default. Configure `HOST`, `PORT` and `DATABASE_PATH` as needed. Docker listens on all container interfaces but publishes only to the host's loopback interface.

A `KINEXPORT_TOKEN` of at least 32 characters is required. The dashboard keeps it in tab session storage until the tab closes or the archive is locked. Never put the token in a URL. The default `ALLOWED_HOSTS` permits `localhost`, `127.0.0.1` and `::1`; use a comma-separated list to override it. Keep the service on loopback unless you have a separate security design for external access.

See [operations and recovery](../docs/OPERATIONS.md) for backup, restore and troubleshooting.

## API

API endpoints use JSON except for archive transfers. Send `Authorization: Bearer <token>` with requests; exceptions are `GET /api/health` and browser downloads using a one-use ticket. Health returns `{ "status": "ok" }` without validating the token. To verify authentication, send `{ "messages": [] }` to `POST /api/probe`.

| Method and endpoint | Purpose |
| --- | --- |
| `GET`, `POST /api/accounts` | List accounts or upsert `{ accountId, displayName?, sourceTimestamp? }`. |
| `GET`, `POST /api/kins` | List by `accountId`, or upsert `{ accountId, kinId, name?, sourceTimestamp? }`. The account must exist; omitted names do not erase existing names. |
| `GET`, `POST /api/kins/profile` | Read or merge profile fields for an existing account and Kin. Each field has `value` and optional UTC `observedAt`; responses include observation history and receipt times. |
| `GET`, `POST /api/kins/journal` | Read or merge journal entries for an account and Kin. Entries require `entryId`, UTC `createdAt` and `description`; `keywords` and `origin` are optional. Up to 500 entries per write; reads default to 50 and allow at most 100. |
| `POST /api/probe` | Check up to 500 message fingerprints. Results, in input order, are `missing`, `changed` or `unchanged`. |
| `POST /api/messages` | Ingest up to 500 messages scoped to an account and Kin. Returns inserted, updated and unchanged counts. |
| `GET /api/conversations`, `GET /api/messages` | Read scoped records. Omit both `accountId` and `kinId` to read unassigned legacy data; providing only one is invalid. |
| `GET /api/search?q=...` | Search scoped and legacy messages by case-insensitive substring, up to 100 results. SQLite's built-in case folding is ASCII-only. |
| `GET /api/digest` | Get archive counts and latest archived time. |
| `GET`, `POST /api/kins/media` | List or store images for an account and Kin. |
| `GET /api/media/blob?sha256=...` | Get authenticated image bytes. |
| `GET /api/media/thumbnail?sha256=...` | Get or generate a thumbnail; a full queue returns `503`. |

For profile writes, use `{ accountId, kinId, fields: { ai_backstory: { value, observedAt? } } }`. The supported field names and types are defined by `PROFILE_FIELDS` in [server.js](server.js). Unknown fields and credentials are rejected. Omitted fields never clear stored data; null, empty strings, false and zero are distinct. Older, equal-time or undated conflicting observations are retained in history rather than replacing a dated value. Plaintext fields are separate observations and may contain unsaved editor drafts.

Message probes take `{ accountId, kinId, messages: [{ conversationId, messageId?, fingerprint, captureSource? }] }`. Ingestion also requires `content`; it accepts `sender`, `timestamp` and `data` fields: `persona`, `reactions`, `chatHistoryRecordId`, `senderAiId`, `reactionsRevision` and `captureSource`. Capture source is `dom`, `history` or `cache`. Temporary DOM IDs are skipped during live capture; existing imports remain intact. Fingerprints must cover changes the client wants to save. Message IDs are scoped to account, Kin and conversation; without an ID the fingerprint is the fallback identity. A changed stable-ID message retains its previous content as a revision. Cache observations take precedence over rendered DOM observations; rendering differences can be retained as source-tagged revisions. Set the same `captureSource` in the probe and ingestion data.

Add `limit` (1–100) to `GET /api/messages` for newest-first pages and cursors. Use `direction=oldest` to start at the oldest page, or `direction=newer` with the returned `newerCursor` to page toward newer messages. Cursors are scoped to the account, Kin, conversation and direction. Requests without pagination parameters return all messages.

Images are deduplicated by SHA-256; source URLs are not stored. Gallery captures are marked as previews. Thumbnails are a derived local cache and can be regenerated.

## Transfers

| Method and endpoint | Purpose |
| --- | --- |
| `GET /api/download/portable` | Stream a portable ZIP archive. |
| `POST /api/import/portable` | Merge an `application/zip` archive atomically. |
| `GET /api/download/sqlite` | Stream a full SQLite online backup. |
| `POST /api/restore/sqlite` | Replace the archive from an `application/vnd.sqlite3` backup after validation. A backup of the previous database is kept in the volume's `backups` directory. |
| `POST /api/download-ticket` | Issue a one-use, HTTP-only download cookie valid for two minutes. Send `{ "format": "portable" }` or `{ "format": "sqlite" }`; an optional `timestamp` supplies the filename. |

Portable ZIPs contain `manifest.json`, `README.txt`, `archive.sqlite3` and separate `media/<sha256>.<extension>` images. Imports validate schema, records and digests and reject unexpected or duplicate entries. The current version 1 SQLite schema is frozen by fingerprint. SQLite restore accepts the current schema only.

The optional download timestamp uses `YYYY-MM-DDTHH-mm-ss+HH-mm`, with a negative offset or `Z` also accepted.

A message import replaces current content only when the same source ID has a valid, later `lastSeen`; otherwise conflicting content is kept as a revision. Unassigned legacy records are not automatically assigned to an account or Kin.

Transfers use private staging files next to the database and run one at a time. Limits are 64 GiB per upload, 128 GiB expanded ZIP data, 8 MiB per image and 500,000 ZIP entries. Allow sufficient disk space. Backups are unencrypted; keep separate copies outside the Docker volume.

Run `npm test` to test the server.
