# Security

KinExport is designed for a single user on a trusted machine. The default Docker configuration binds the archive to loopback. The access token authorizes API requests; it does not encrypt the database, exports, backups or browser extension storage. The archive can contain private conversations, profile information and images.

Report suspected vulnerabilities privately to the project maintainer if a private contact method is available. If there is no private reporting channel, ask the maintainer for one without posting vulnerability details or private archive data publicly. Do not include access tokens, real messages, images or databases in reports.

For setup, token rotation and recovery, see [operations and recovery](docs/OPERATIONS.md). For the capture and trust boundaries, see [the architecture guide](docs/ARCHITECTURE.md).
