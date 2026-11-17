# KinExport project guidance

- Preserve existing archives and their account/Kin scoping. Changes to the database, imports, exports or backups must include compatibility and recovery checks.
- Capture is passive: inspect information already available in the Kindroid tab, without automating interaction or issuing Kindroid requests. Skip ambiguous identities and timestamps rather than guessing.
- Use synthetic data in tests and reports. Never include tokens, real messages, images, databases or page snapshots in logs or committed fixtures.
- Run `npm run check` from the project root. See [CONTRIBUTING.md](CONTRIBUTING.md) for prerequisites, project layout and development workflow.
- Keep project, server, extension and dashboard version labels synchronized. See [docs/RELEASING.md](docs/RELEASING.md) for release and isolated restore checks.
