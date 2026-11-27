# Security

Run the application as a dedicated user with access limited to its private data directory and environment. The HTTP server binds only to loopback. Use a private network or an HTTPS reverse proxy with a trusted access layer for remote access. All signed-in operators share the same administrative access.

Keep server credentials and the database outside public repositories, logs, screenshots, and backups accessible to other users. Use a private environment file or secret store. Do not log OAuth callback query strings. The encryption key protects stored LinkedIn access tokens and should be backed up separately from the database.

Before sharing a Git repository, check exactly which objects and commit metadata will be published. The public source excludes all runtime data and carries synthetic test fixtures only. If a credential is ever exposed, revoke it at the issuing service and rotate it. Removing it from the latest commit alone does not revoke it.

For a vulnerability in this project, use **Security → Report a vulnerability** on GitHub if private reporting is enabled. If it is unavailable, contact a maintainer privately. Keep proof and affected account information out of public issues.
