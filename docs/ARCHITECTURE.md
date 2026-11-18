# Architecture

KinKeep has two components. The extension reads supported Kindroid data and sends it to the configured archive. The server stores records and image bytes in SQLite and serves the dashboard and HTTP API.

## Capture and identity

The content scripts read Kindroid's local cache and rendered page. A page-world bridge can inspect already-loaded Chat History records for visible message IDs. Capture requires a signed-in Firebase UID matching the cache owner. A Kin must belong to that account. The UID and Kin ID determine ownership even if their display names change.

Messages are scoped by account, Kin, and conversation. The collector uses one conversation ID, `observed-main`, per Kin because it cannot verify conversation boundaries. It skips temporary IDs and ambiguous observations.

## Transfers and revisions

The extension registers the account and its Kins, then probes the server with message IDs and fingerprints. It sends message bodies only for missing or changed observations. Each tab remembers acknowledged records in memory and rechecks them when its account or archive settings change. A failed write invalidates those acknowledgements so a later scan can recover.

For a given message ID, the server prefers cached data, then loaded Chat History, then visible chat. Live reaction-only updates replace the current reaction state without creating a revision. An explicit empty set of reactions clears it. Earlier versions keep their recorded text and reactions. Profile updates merge by field. Omitted fields retain their values, and older conflicting observations go into history. Journal entries retain differing observations without assuming an edit order.

Images are keyed by SHA-256. Scoped media records point to the shared image bytes, and the server generates thumbnails locally on demand.

See the [extension guide](../extension/README.md) for capture coverage and the [server reference](../server/README.md) for the API.
