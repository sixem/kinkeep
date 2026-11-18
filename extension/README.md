# KinKeep browser extension

Enable **Archiving** in a signed-in Kindroid session to send observations to your archive server. For browser-specific setup, see [Connect the extension](../README.md#connect-the-extension).

## Capture coverage

| Data | What gets saved |
| --- | --- |
| Messages | Cached messages and identifiable visible messages. Chat History entries need a matching loaded ID and timestamp. |
| Profile | Supported settings and personality fields. Readable editor text is stored separately from cached encrypted values and can include unsaved drafts. |
| Journal | Entries present in the account's cache. Opening the journal can expose more entries. |
| Images | In Chrome and Brave, optional snapshots capture matched portraits and selfie previews. Source URLs are omitted. Firefox has no image capture. |

The extension never clicks, scrolls, or navigates Kindroid for you. Leave **Image archiving** off for zero extra Kindroid requests. When enabled, the browser can request a stylesheet while making a snapshot.

## Permissions

Kindroid page access lets the extension read the active account, local cache, and rendered content. It requests access to the archive host when you save the endpoint. The extension keeps its archive token and preferences in local browser storage. Kindroid authentication tokens are never sent to the archive.

Alarms check archive availability, notifications report connection failures, and Chromium's page capture permission supports optional image snapshots. Capture has no offline queue. Once the server is available again, only records still accessible in the tab can be retried.
