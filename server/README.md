# KinKeep archive server

The server stores records and images in SQLite and serves the dashboard and HTTP API. For a Docker installation, follow the [project quick start](../README.md#start-the-archive).

## Run without Docker

Install Node.js 24+ and ImageMagick 7 with WebP support. Set the `KINKEEP_TOKEN` environment variable to a random secret of at least 32 characters. Run the following from `server/`.

```sh
npm ci --ignore-scripts
npm start
```

| Environment variable | Default |
| --- | --- |
| `KINKEEP_TOKEN` | Required |
| `HOST`, `PORT` | `127.0.0.1`, `8765` |
| `DATABASE_PATH` | `./data/kinkeep.sqlite` |
| `ALLOWED_HOSTS` | `127.0.0.1,localhost,::1` (comma-separated HTTP hostnames) |

## HTTP API

Send `Authorization: Bearer <token>` with API requests. Use `Content-Type: application/json` for JSON writes. `GET /api/health` returns `{"status":"ok"}` without credentials. `GET /api/session` validates the token and returns `{"authenticated":true}`.

### Accounts and records

For scoped records, include both `accountId` and `kinId` in the query string for reads or in the JSON object for writes.

| Method | Path | Operation |
| --- | --- | --- |
| GET | `/api/accounts` | List accounts. |
| GET | `/api/kins` | List Kins by `accountId`. |
| POST | `/api/inventory` | Save `{account, kins}` in one transaction. The account requires `accountId`. Each of up to 500 Kins requires `accountId` and `kinId`. Returns `accountId` and `kinCount`. |
| GET / POST | `/api/kins/profile` | Read a profile with its history, or merge supplied `fields`. Each field has a `value` and optional UTC `observedAt`. |
| GET / POST | `/api/kins/journal` | Page through journal entries, or write up to 500 `entries`. Each requires `entryId`, UTC `createdAt`, and `description`. |
| GET | `/api/conversations` | List conversations in scope. |
| GET | `/api/messages` | Read messages, optionally filtered by `conversationId`. |
| GET | `/api/search?q=…` | Search all archived messages by substring, up to 100 results. Case folding covers ASCII. |
| GET | `/api/digest` | Read archive counts and the most recent message archive time. |
| GET / POST | `/api/kins/media` | Page through scoped image metadata, or store up to eight images in `items`. |
| GET | `/api/media/blob?sha256=…` | Download image bytes. |
| GET | `/api/media/thumbnail?sha256=…` | Download a generated thumbnail. A full generation queue returns `503`. |

Journal entries accept optional `keywords` and `origin`. Both journal and media reads accept `limit` (1–100, default 50) and `offset`. Profile writes retain omitted fields and distinguish explicit nulls from empty strings, zero, and false. See the field types in [validation.js](validation.js).

Message reads accept `limit` (1–100) for newest-first pagination. Pass the returned `nextCursor` as `cursor` for older records, or use `direction=newer` with `newerCursor`. Use `direction=oldest` to start at the other end.

### Message writes

1. Register the account and Kin, then send up to 500 messages to `POST /api/probe`. Include the scope IDs and a `messages` array. Each item has `conversationId`, `fingerprint`, and optional `messageId` and `captureSource`.
2. Read the corresponding `status` in the response's `results` array. Send `missing` and `changed` items in the same scoped envelope to `POST /api/messages`. Include `content` and any observed `sender`, `timestamp`, or `data`. Put the source in `data.captureSource` for writes.
3. Check the returned `inserted`, `updated`, and `unchanged` counts.

Message identity is scoped to the conversation. The fingerprint supplies the identity when a message has no source ID. Use a fingerprint that covers every observed change you want to archive. Source values are `cache`, `history`, and `dom`. See [capture and revision handling](../docs/ARCHITECTURE.md#transfers-and-revisions).

### Archive transfers

| Method | Path | Operation |
| --- | --- | --- |
| GET | `/api/download/portable` | Download the portable ZIP. |
| POST | `/api/import/portable` | Atomically merge an `application/zip` portable archive. |
| GET | `/api/download/sqlite` | Download a full SQLite backup. |
| POST | `/api/restore/sqlite` | Replace the database from an `application/vnd.sqlite3` backup. |
| POST | `/api/download-ticket` | Send `{"format":"portable"}` or `{"format":"sqlite"}` to obtain a single-use browser download cookie valid for two minutes. |

An optional ticket `timestamp` sets the filename suffix, for example `2026-01-15T09-30-00+01-00` or `2026-01-15T08-30-00Z`. See [operations and recovery](../docs/OPERATIONS.md#export-and-restore) for transfer limits and restore behavior.
