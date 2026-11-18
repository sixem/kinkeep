# Security

KinKeep is designed for one user on a trusted machine. The default Docker setup exposes the archive on loopback. Anyone with the token and access to the server can read, export, and replace the archive. The database, exports, and backups are unencrypted.

## Reporting a vulnerability

Contact the maintainer privately. If you need a reporting address, request one without posting vulnerability details publicly. Use synthetic examples and omit tokens, conversations, profile text, images, and databases.

See [token rotation and recovery](docs/OPERATIONS.md).
