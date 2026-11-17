# KinExport browser extension

This extension passively reads the current user's existing Kindroid browser cache and visible chat and sends verified account, Kin and chat data to your configured archive server. It does not click, scroll, navigate, or make additional requests to Kindroid. The history reader runs in the page context to inspect already-loaded React Query state.

## Install for development

1. Start the KinExport archive server and obtain its access token.
2. In Chrome or Brave, open `chrome://extensions` (or `brave://extensions`), enable developer mode, choose **Load unpacked**, and select this `extension` directory. No build step is needed. For Firefox 140 or later, run `npm run build:firefox` from the project root, open `about:debugging#/runtime/this-firefox`, select **Load Temporary Add-on**, and choose `dist/firefox/manifest.json`. Temporary add-ons must be loaded again after Firefox restarts; permanent Firefox distribution requires Mozilla signing.
3. Open KinExport's popup from the browser's extensions menu, and pin it if desired.
4. Set the archive server URL and access token, then choose **Save settings**. Grant access to that server when the browser asks. Test the connection and enable archiving when ready. The toggle is off by default.

The extension checks the configured archive server and validates its token with an empty probe. An error badge is shown when the server is unavailable; a notification appears after a short delay, once per outage. Checks retry with backoff. The notification and status warn that messages viewed during an outage may not have been saved. There is no offline message queue. Cache data that is still present after recovery may be observed again, but no coverage is guaranteed.

The token is stored in local browser extension storage. Configure only a server you trust; use HTTPS for non-local endpoints. The extension requests network access for the configured host when you save it.

Firefox may describe the add-on's data categories during installation because it sends captured content, account identifiers, and the archive access token to the server you configure. It does not send Kindroid authentication tokens.

## Capture and limitations

While enabled and a Kindroid tab is open, the extension periodically reads the existing `kindroid-v2` / `react-query` / `cache:authenticated` browser cache, but only if its owner exactly matches the logged-in Firebase UID. The UID identifies the archive account; the extension also records the Firebase display name when present and unambiguous. That name is optional and may differ from a Kindroid persona name. It inventories known Kin IDs, names, and verified profile fields such as backstory, memory, directives, and selected settings, then batches the already-cached messages for the archive. These profile fields can contain private information. Missing fields do not erase archived values; cache query observation times are used to merge partial snapshots and are not Kindroid edit timestamps. URL-bearing background settings, authentication records and unverified fields are not collected. It does not transmit Firebase authentication tokens. It stops capture and shows a warning when account identity is ambiguous or mismatched.

The extension also observes visible chat messages missing from the cache, but only when the current chat URL identifies a Kin in the verified account. These records are marked as rendered DOM captures: emphasis elements are reconstructed with asterisks and paragraph/line breaks are preserved where possible. The result can still differ from Kindroid's underlying source formatting. Cache captures take precedence and replace a prior DOM capture while retaining the earlier rendering as a source-tagged observation. DOM captures never overwrite a cache capture.

When you naturally open a Kin's **Personality** settings page, the extension can also capture the displayed Personality, Key Memories, Response Directive, Example Message and Scene Setting text as separate plaintext observations. It checks the current account and Kin, skips focused or ambiguous controls, and requires a short period of stability. These are observations of what appeared in the editor and may include unsaved drafts; viewing each Kin is required. Cached ciphertext remains separate, and the extension does not retrieve encryption keys or make extra requests to Kindroid. Archiving must be enabled in the extension for collection to occur; the archive access token controls access to the local archive, not Kindroid's encryption.

The source cache contains only some messages and is subject to Kindroid's cache behavior. The extension does not discover or fetch unobserved history; browsing normally may populate more of the cache or expose visible messages. It groups each Kin's observed messages under the synthetic conversation `observed-main` because the verified cache does not expose a reliable conversation boundary. The source message ID, timestamp, sender, persona, reactions and per-message history record ID are kept when available; changes generate a new fingerprint. Conflicting duplicate IDs are skipped rather than guessed. This is an initial mapping based on observed cache structures and may need revision if Kindroid changes them.

The extension probes the archive and then sends missing or changed records. A short-lived in-memory snapshot is used during each scan; it is not an offline queue, and failed sends are retried only by observing whatever remains in Kindroid's cache on a later scan.

## Other observed data

When you open Chat History and browse it, the extension can match displayed entries to already-loaded history IDs and timestamps. It skips entries without a reliable timestamp. Journal entries are read from available account- and Kin-scoped cache data; opening the journal may make additional entries available. In Chrome and Brave, captured portrait and selfie resources must already be rendered and match verified metadata. The extension uses page capture to extract these resources from a temporary page snapshot; it does not download image URLs itself. Gallery captures are marked as previews. Firefox does not provide this page-capture API, so image archiving is unavailable there; messages, profiles and other supported records continue to be observed.

See the [capture design](../docs/ARCHITECTURE.md) for data flow and the [operations guide](../docs/OPERATIONS.md) for recovery and troubleshooting.

## Development

Run `npm run check` in this directory (Node.js required). Reload the extension in the extensions page after changes, then manually reload the Kindroid tab when appropriate. The extension never reloads the tab itself.
