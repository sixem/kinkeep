# KinExport browser extension

The extension archives supported Kindroid data as you browse. It reads the existing browser cache and visible page; it doesn't click, scroll, navigate or directly request Kindroid data. See [capture design](../docs/ARCHITECTURE.md) for details.

## Install

Start the archive server and obtain its access token, then load the extension:

- **Chrome or Brave:** Open `chrome://extensions` or `brave://extensions`, enable developer mode and select **Load unpacked**. Choose the `extension` directory.
- **Firefox 140+:** Run `npm run build:firefox` from the project root. Open `about:debugging#/runtime/this-firefox`, select **Load Temporary Add-on**, and choose `dist/firefox/manifest.json`. Temporary add-ons must be reloaded after Firefox restarts; permanent distribution requires Mozilla signing.

Open the popup, enter the server URL and token, then select **Save settings** and allow access to the server. Test the connection and enable archiving. You can pin the popup from the browser's extensions menu.

The token is stored in local extension storage. Use HTTPS for non-local endpoints and configure only a server you trust. Firefox may disclose the collected data categories during installation; Kindroid authentication tokens are not sent to the archive.

## Capture

- The Firebase UID identifies the account. The extension records a display name when available and captures data only when the cache owner matches the signed-in account.
- Cached messages and visible chat are associated with a verified Kin. History entries without reliable timestamps and ambiguous records are skipped. Observed messages currently share one synthetic conversation per Kin.
- Opening **Personality** can capture readable fields, including unsaved drafts. Cached encrypted fields are preserved separately.
- Journal entries come from the account's cache; opening the journal may expose more entries.
- Chrome and Brave capture some visible portraits and selfie previews. The **Image archiving** switch is on by default and can be turned off without deleting archived images. Firefox doesn't support image capture. Chromium's page snapshot may re-request stylesheets in some browser configurations.

The extension checks the archive server and warns when it's unavailable. There's no offline queue: data may be captured after recovery if it's still visible or cached, but coverage isn't guaranteed.

## Development

Run `npm run check` in this directory. After changes, reload the extension and, when necessary, refresh the Kindroid tab.
