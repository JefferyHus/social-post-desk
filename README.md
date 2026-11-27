<img src="public/brand-mark.png" alt="" width="88" height="88">

# Social Post Desk

A private, self-hosted marketing workspace for publishing to LinkedIn Company Pages, tracking organic social performance, and reporting on website traffic through Google Analytics 4. The source is open under the MIT License. The application uses Node.js and SQLite and has no dependencies on a paid reporting or publishing connector.

https://github.com/user-attachments/assets/6e20a12b-07af-4601-8162-b01b8dac2bfc

[Contribute](CONTRIBUTING.md)

## What it does

- Keep separate drafts, publishing activity, and data source connections for multiple projects.
- Connect a read-only Google Analytics 4 property per project. See active users, sessions, views, key events, daily traffic, acquisition channels and top pages. Export the selected 7-, 28- or 90-day report to CSV.
- Write a text or link post, review its exact content and company page, then publish it on demand.
- Keep the LinkedIn permalink and check ambiguous publishing attempts without automatically resending them.
- Look up the latest 20 company posts and their lifetime organic metrics. View company-wide totals for the last 7, 28, or 90 complete UTC days.
- Download the selected project’s report as a CSV with page totals and per-post lifetime metrics.
- Prepare and copy drafts before connecting LinkedIn. Use the official company page to publish manually when needed.

The LinkedIn date filter applies to company totals. The recent-post list and each post's lifetime metrics are separate views. If two projects use the same LinkedIn Page, each project's drafts and activity remain separate. LinkedIn returns the same page-level totals and recent company posts for both connections.

## Try the demo

Run `npm run demo` with Node.js 24 or later. Open [the demo](http://127.0.0.1:3010) and sign in with `social-desk-demo`. It runs on loopback with fictional projects, an in-memory database and simulated LinkedIn and Google Analytics providers. Open **Analytics** for the example website report. To try a simulated connection, select **Example Workshop** and enter property ID `4242001`. Demo changes reset on restart.

## Run a private instance

Use a maintained release of Node.js 24 or newer on a Unix-like system. No package installation is needed.

```sh
umask 077
cp .env.example .env
```

Edit `.env` locally. Set `SOCIAL_DESK_PASSWORD` to a long, unique password and `SOCIAL_DESK_ENCRYPTION_KEY` to a separate 64-character hexadecimal value. To generate the key, run `openssl rand -hex 32` in a private terminal and put the result directly in `.env`. Keep the key and a private database backup together in your secure backup process. Losing the key makes stored platform credentials unreadable.

```sh
npm start
```

Open [the local app](http://127.0.0.1:3000). Sessions expire after eight hours. A restart signs users out and cancels unfinished OAuth handshakes. Use a private data directory that is writable only by the operating-system account running the app. The default is `data/`.

For remote access, run one process on a loopback address behind a TLS reverse proxy on the same host. Set `APP_ORIGIN` to the exact external HTTPS origin. Preserve the public Host header, and prevent the proxy from logging query parameters on `/oauth/linkedin/callback` and `/oauth/google/callback`. Restrict access to your team, ideally through a private network or a trusted access gateway. This version has a single operator login, so each authenticated operator can see all projects in that instance.

## Connect a LinkedIn Company Page

1. Obtain [LinkedIn Community Management API access](https://learn.microsoft.com/en-us/linkedin/marketing/community-management-app-review) for an app owned by your organization. LinkedIn vets apps for development access and separately reviews standard access for production use.
2. Register the exact OAuth redirect URL `<APP_ORIGIN>/oauth/linkedin/callback` in the developer app. Use a registered HTTPS origin for remote use.
3. Set `LINKEDIN_CLIENT_ID` and `LINKEDIN_CLIENT_SECRET` in the private server environment. The application requests `r_organization_social`, `w_organization_social` and `rw_organization_admin`. Update `LINKEDIN_API_VERSION` as LinkedIn retires older releases.
4. Add a project with its numeric LinkedIn Page ID, then select **Connect LinkedIn**. Complete the official LinkedIn consent flow with a Page administrator. The app checks that administrator access is active for that exact Page and shows the verified company name.
5. Save a draft, review the page and text, and then choose **Publish post**. Check **Activity** for its permalink and **Performance** for organic metrics.

If your app's approval is pending, leave the LinkedIn credentials unset and use the draft workflow. Reconnect when the access token expires. Disconnecting removes the local access token. Use LinkedIn's authorized-app controls to revoke the grant at LinkedIn.

An unconfirmed publish is held for review. **Check status** looks for exactly one matching recent post on the verified Page. If the app cannot match it, check the Page before submitting a replacement.

## Connect Google Analytics 4

1. Enable the [Google Analytics Data API](https://developers.google.com/analytics/devguides/reporting/data/v1/quickstart) in a Google Cloud project you control.
2. Configure the consent screen and create a [Web application OAuth client](https://developers.google.com/identity/protocols/oauth2/web-server). Register the exact **Authorized redirect URI** `<APP_ORIGIN>/oauth/google/callback`. For the default local instance, use `http://127.0.0.1:3000/oauth/google/callback`.
3. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in the private server environment, then restart the app. If the OAuth app is in testing mode, add your Google account as a test user. Google may require consent verification for a broader rollout.
4. In Social Post Desk, select a project and open **Analytics**. Enter the numeric GA4 property ID shown in Google Analytics Admin under **Property details**, then choose **Connect Google Analytics**. Sign in with a Google account that can view that property. The grant requests only `analytics.readonly`.
5. Select a period and view or export the report. GA4 uses the property's reporting timezone and includes the selected number of days through yesterday. Recent values may still be processing. Counts suppressed or omitted by Google appear as unavailable.

Each project has one Google Analytics connection. Disconnecting removes its saved grant from this instance. To revoke Google's grant as well, use your Google Account's third-party connections settings. That can affect other projects connected to the same OAuth app and Google account.

## Google Search Console

Configure the same Google OAuth client credentials used for GA4 and register `<APP_ORIGIN>/oauth/google/search-console/callback` as a second redirect. Search Console asks for its own `webmasters.readonly` consent. In Website analytics, connect Google and select an authorized Domain or URL-prefix property. Disconnect removes its locally stored refresh token independently of GA4; use Google's account controls to revoke the authorization at Google.

The report shows finalized web search data for the displayed Pacific Time dates. Totals come from Google's aggregate response; daily, query and page tables may be incomplete and query/page rows are limited to 100. Empty or unavailable values are not interpreted as zero. CSV export uses the currently displayed report. The demo uses fictional properties and data.

## Data handling

- The application has no tracking scripts or hosted dependencies.
- OAuth app secrets and platform tokens stay on the server. GA4 reports are visible to signed-in operators and exported on request.
- SQLite keeps project information, drafts and publishing activity private to the instance. LinkedIn access tokens and Google refresh tokens are encrypted with AES-256-GCM. Google access tokens and reports are cached briefly in process memory. Keep the database private because draft and activity text is readable on disk.
- LinkedIn receives the contents of a post only when you confirm publication. Public posts appear on LinkedIn. The repository contains application code and synthetic tests.

See [SECURITY.md](SECURITY.md) before deploying remotely.

## Tests

Run `npm test`. Tests use synthetic credentials, disposable databases and mocked LinkedIn and Google Analytics APIs. No test connects to a real Page or publishes a live post.

Provider references: [LinkedIn OAuth](https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow), [Posts API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api), and [Organization Share Statistics](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/share-statistics).
