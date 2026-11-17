# Security

KinExport is intended for a single user on a trusted machine and binds to loopback by default. The access token does not encrypt the database, exports, backups or extension storage. Treat these as private.

Report vulnerabilities privately to the maintainer. If no private contact method is available, ask for one without posting vulnerability details or private data. Do not include tokens, real messages, images or databases in reports.

See [operations and recovery](docs/OPERATIONS.md) for token rotation and recovery, and [architecture](docs/ARCHITECTURE.md) for capture and trust boundaries.
