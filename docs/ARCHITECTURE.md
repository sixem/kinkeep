# Capture and archive design

KinExport has a browser extension and a local HTTP server. The extension observes information already available to the signed-in Kindroid tab and sends batches to the configured archive endpoint. The server stores records and image bytes in SQLite and serves the dashboard, API, exports and backups.

The observer does not click, scroll, navigate or fetch resources from Kindroid. It runs extension scripts in the Kindroid page, reads available browser state and page content, and communicates with the archive server. Ordinary browsing can cause Kindroid itself to load additional data, which may then become observable. KinExport cannot guarantee complete coverage.

## Identity and records

The extension associates observations with the logged-in Firebase UID and verified Kin ID from the account-owned Kindroid cache. It can retain an available Firebase display name as a label, but the UID is the account identifier; the display name is not guaranteed to be a Kindroid persona name. Ambiguous or mismatched identity stops capture instead of assigning data to a guessed account.

Messages are scoped to account, Kin and conversation. The collector uses a synthetic `observed-main` conversation because the observed source data does not provide a reliable conversation boundary. Stable source message IDs, timestamps and other verified metadata are stored when available. The client probes message fingerprints in batches and sends missing or changed observations. Conflicting observations are preserved as revisions under the server's merge rules. A rendered page observation can differ from source formatting; cache data takes precedence when the same source ID is observed in both forms.

The Chat History reader uses already-loaded history state to match visible entries to their IDs and timestamps. An entry without a reliable matching timestamp is skipped. Browsing history does not imply that every older message has been discovered.

Selected profile fields, journal entries and settings are stored when observed. Readable text seen in the personality editor is kept separately from cached encrypted values and can include unsaved drafts. Missing fields do not mean a stored value should be deleted. Journal observations with differing text are retained without assuming their edit order.

## Images and availability

In Chrome and Brave, the extension identifies matching, already-rendered portraits and selfie previews and uses page capture to extract resources already present in the page snapshot. It does not download the source URL itself. The snapshot may temporarily contain other page content; the extension retains only matched images and verified metadata. Gallery images are labeled as previews and may not be full-size originals. Firefox lacks this page-capture API, so its extension does not currently capture images. The server stores image bytes and creates local thumbnails for display.

There is no offline capture queue. When the local server is unreachable or the token is rejected, the extension shows an error and issues a debounced notification. Observations may be captured on a later scan if still available, but messages encountered during an outage can be missed.

## Trust boundaries

The default service is intended for one user on a trusted machine. The token grants archive access; it is not encryption. The database, ZIP exports, SQLite backups and extension storage can contain private data. Docker publishes only to loopback by default. Do not expose the server to a network without a separate review of authentication, transport, access control and operational risks.

The implementation depends on undocumented Kindroid browser storage and DOM structures. Those may change, so version updates or unexpected content should be validated before relying on capture. More detail on the implementation and the server's supported API is in the [extension README](../extension/README.md) and [server README](../server/README.md).
