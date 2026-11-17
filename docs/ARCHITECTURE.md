# Capture and archive design

KinExport observes an open Kindroid tab and sends records to the archive server. The server stores records and images in SQLite and serves the dashboard, exports and backups.

The extension does not click, scroll, navigate or directly request Kindroid data. It reads browser state and page content as you browse, so archives may be incomplete. Image snapshots have a browser-dependent caveat described below.

## Identity and records

The extension associates records with the logged-in Firebase UID and a Kin verified in that account's cache. A Firebase display name can be saved as a label; the UID remains the account identifier. Capture stops when the account is ambiguous or mismatched.

Messages belong to an account, Kin and conversation. The collector uses `observed-main` because the source does not provide a reliable conversation boundary. It batches fingerprint probes and sends missing or changed messages; conflicting observations are kept as revisions. Cached messages take precedence over rendered observations with the same source ID.

Chat History entries are matched to already-loaded IDs and timestamps; entries without a reliable timestamp are skipped. Profile fields, settings and journal entries are recorded when seen. Readable personality editor text is stored separately from cached encrypted values and may include unsaved drafts. Missing fields never delete existing values, and differing journal observations are retained without assuming edit order.

## Images and availability

In Chrome and Brave, image archiving captures matching, rendered portraits and selfie previews using a page snapshot. It is enabled by default and can be switched off in the extension popup. The extension retains only matched images and verified metadata; previews may not be full-size originals. In some Chromium configurations, creating a snapshot can cause the browser to request a stylesheet again. Firefox does not support this page-capture API.

There is no offline queue. If the server is unreachable or rejects the token, the extension warns you; data may be captured on a later scan if still available.

## Trust boundaries

The default server is intended for one user on a trusted machine and binds to loopback. The token grants access but does not encrypt the database, backups, exports or extension storage. Review authentication, transport and access control before exposing the server to a network.

Capture depends on undocumented Kindroid browser storage and page structure, which may change. See the [extension README](../extension/README.md) and [server README](../server/README.md) for supported data and API details.
