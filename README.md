# Social Post Desk

A private, self-hosted workspace for preparing posts, publishing to LinkedIn Company Pages, and reviewing organic performance. The source is open under the MIT License. The application uses Node.js and SQLite and has no dependencies on a paid reporting or publishing connector.

## What it does

- Keep separate drafts, publishing activity, and connections for multiple projects.
- Write a text or link post, review its exact content and company page, then publish it on demand.
- Keep the LinkedIn permalink and check ambiguous publishing attempts without automatically resending them.
- Look up the latest 20 company posts and their lifetime organic metrics. View company-wide totals for the last 7, 28, or 90 complete UTC days.
- Prepare and copy drafts before connecting LinkedIn. Use the official company page to publish manually when needed.

The dashboard's date filter applies to company totals. The recent-post list and each post's lifetime metrics are separate views. If two projects use the same LinkedIn Page, each project's drafts and activity remain separate. LinkedIn returns the same page-level totals and recent company posts for both connections.

## Run a private instance

Use a maintained release of Node.js 24 or newer on a Unix-like system. No package installation is needed.

```sh
umask 077
cp .env.example .env
```

Edit `.env` locally. Set `SOCIAL_DESK_PASSWORD` to a long, unique password and `SOCIAL_DESK_ENCRYPTION_KEY` to a separate 64-character hexadecimal value. To generate the key, run `openssl rand -hex 32` in a private terminal and put the result directly in `.env`. Keep the key and a private database backup together in your secure backup process. Losing the key makes stored LinkedIn credentials unreadable.

```sh
npm start
```

Open [the local app](http://127.0.0.1:3000). Sessions expire after eight hours. A restart signs users out and cancels unfinished OAuth handshakes. Use a private data directory that is writable only by the operating-system account running the app. The default is `data/`.

For remote access, run one process on a loopback address behind a TLS reverse proxy on the same host. Set `APP_ORIGIN` to the exact external HTTPS origin. Preserve the public Host header, and prevent the proxy from logging query parameters on `/oauth/linkedin/callback`. Restrict access to your team, ideally through a private network or a trusted access gateway. This version has a single operator login, so each authenticated operator can see all projects in that instance.

## Connect a LinkedIn Company Page

1. Obtain [LinkedIn Community Management API access](https://learn.microsoft.com/en-us/linkedin/marketing/community-management-app-review) for an app owned by your organization. LinkedIn vets apps for development access and separately reviews standard access for production use.
2. Register the exact OAuth redirect URL `<APP_ORIGIN>/oauth/linkedin/callback` in the developer app. Use a registered HTTPS origin for remote use.
3. Set `LINKEDIN_CLIENT_ID` and `LINKEDIN_CLIENT_SECRET` in the private server environment. The application requests `r_organization_social`, `w_organization_social` and `rw_organization_admin`. Update `LINKEDIN_API_VERSION` as LinkedIn retires older releases.
4. Add a project with its numeric LinkedIn Page ID, then select **Connect LinkedIn**. Complete the official LinkedIn consent flow with a Page administrator. The app checks that administrator access is active for that exact Page and shows the verified company name.
5. Save a draft, review the page and text, and then choose **Publish post**. Check **Activity** for its permalink and **Performance** for organic metrics.

If your app's approval is pending, leave the LinkedIn credentials unset and use the draft workflow. Reconnect when the access token expires. Disconnecting removes the local access token. Use LinkedIn's authorized-app controls to revoke the grant at LinkedIn.

An unconfirmed publish is held for review. **Check status** looks for exactly one matching recent post on the verified Page. If the app cannot match it, check the Page before submitting a replacement.

## Data handling

- No third-party analytics, browser tracking, or hosted dependencies.
- The browser never receives the OAuth app secret or the LinkedIn access token.
- SQLite keeps project information, drafts and publishing activity private to the instance. Access tokens are encrypted with AES-256-GCM. Keep the database private because draft and activity text is readable on disk.
- LinkedIn receives the contents of a post only when you confirm publication. Public posts appear on LinkedIn. The repository contains application code and synthetic tests.

See [SECURITY.md](SECURITY.md) before deploying remotely.

## Tests

Run `npm test`. Tests use synthetic credentials, disposable databases and a mocked LinkedIn API. No test connects to a real Page or publishes a live post.

Provider references: [LinkedIn OAuth](https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow), [Posts API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api), and [Organization Share Statistics](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/share-statistics).
