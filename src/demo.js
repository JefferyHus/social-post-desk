import { randomBytes } from "node:crypto";
import { loadConfig } from "./config.js";
import { LinkedInError } from "./linkedin.js";
import { createApp } from "./server.js";
import { openStore } from "./store.js";

const password = "social-desk-demo";
const config = {
  ...loadConfig({
    SOCIAL_DESK_PASSWORD: password,
    SOCIAL_DESK_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    APP_ORIGIN: "http://127.0.0.1:3010",
  }),
  demo: true,
};
const store = openStore({ filename: ":memory:", key: config.key });
const projects = [
  ["Example Studio", "10001"],
  ["Example Workshop", "10002"],
];

for (const [name, organizationId] of projects) {
  const project = store.createProject({ name, organizationId });
  store.connect(project.id, {
    id: organizationId,
    name,
    pageUrl: "https://example.com/company/",
    accessToken: "synthetic-demo-token",
    expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
  });
}

const exampleStudio = store.listProjects()[0];
store.createDraft(exampleStudio.id, {
  body: "We made a checklist to help teams prepare their first community workshop. What would you add to it?",
  linkUrl: "https://example.com/workshop-checklist/",
  linkTitle: "Community workshop checklist",
});

const totals = { impressions: 2170, clicks: 114, reactions: 29, comments: 5, shares: 8 };
const posts = new Map([
  [
    "10001",
    [
      {
        urn: "urn:li:share:1",
        url: "https://example.com/posts/1/",
        body: "A few things we learned while planning our first community workshop.",
        linkUrl: null,
        publishedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
        metrics: { impressions: 608, clicks: 36, reactions: 12, comments: 2, shares: 3 },
      },
    ],
  ],
]);
let publicationCount = 1;

function demoUnavailable() {
  throw new LinkedInError("Demo connections are simulated", { status: 403 });
}

const provider = {
  authorizeUrl: demoUnavailable,
  exchangeCode: demoUnavailable,
  verifyOrganization: demoUnavailable,
  async listPosts(_token, organizationId) {
    return posts.get(organizationId) ?? [];
  },
  async publish(_token, organizationId, draft) {
    const id = ++publicationCount;
    const post = {
      urn: `urn:li:share:${id}`,
      url: `https://example.com/posts/${id}/`,
      body: draft.body,
      linkUrl: draft.linkUrl,
      publishedAt: new Date().toISOString(),
      metrics: { impressions: 0, clicks: 0, reactions: 0, comments: 0, shares: 0 },
    };
    posts.set(organizationId, [post, ...(posts.get(organizationId) ?? [])]);
    return post;
  },
  async report(token, organizationId, days) {
    const date = new Date();
    const end = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    const scale = days / 28;
    return {
      from: new Date(end - days * 86_400_000).toISOString(),
      to: new Date(end).toISOString(),
      totals: Object.fromEntries(
        Object.entries(totals).map(([key, value]) => [
          key, Math.round(value * scale / (organizationId === "10001" ? 1 : 3)),
        ]),
      ),
      posts: await provider.listPosts(token, organizationId),
      warnings: [],
    };
  },
};

const demoPropertyId = "4242001";
const demoGoogleTokens = {
  accessToken: "fictional-ga4-access",
  refreshToken: "fictional-ga4-refresh",
};
const demoGoogleExpiry = () => new Date(Date.now() + 60 * 60_000).toISOString();
store.setGa4Connection(exampleStudio.id, {
  propertyId: demoPropertyId,
  refreshToken: demoGoogleTokens.refreshToken,
});

const ga4 = {
  authorizeUrl({ state }) {
    const url = new URL("/oauth/google/callback", config.origin);
    url.search = new URLSearchParams({ state, code: "fictional-ga4-code" });
    return url.href;
  },
  async exchangeCode({ code }) {
    if (code !== "fictional-ga4-code") demoUnavailable();
    return { ...demoGoogleTokens, expiresAt: demoGoogleExpiry() };
  },
  async refresh(refreshToken) {
    if (refreshToken !== demoGoogleTokens.refreshToken) demoUnavailable();
    return { accessToken: demoGoogleTokens.accessToken, expiresAt: demoGoogleExpiry() };
  },
  async report(_accessToken, propertyId, days) {
    if (propertyId !== demoPropertyId) demoUnavailable();
    const date = new Date();
    const end = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    const daily = Array.from({ length: days }, (_, index) => {
      const offset = index - days;
      return {
        date: new Date(end + offset * 86_400_000).toISOString().slice(0, 10),
        sessions: 64 + ((index * 137 + (index % 4) * 19) % 103),
      };
    });
    const sessions = daily.reduce((sum, item) => sum + item.sessions, 0);
    const organic = Math.round(sessions * 0.54);
    const direct = Math.round(sessions * 0.28);
    const keyEvents = Math.round(sessions * 0.033);
    const organicEvents = Math.round(keyEvents * 0.56);
    const directEvents = Math.round(keyEvents * 0.27);
    const screenPageViews = Math.round(sessions * 1.74);
    return {
      days,
      totals: { sessions, keyEvents, screenPageViews, activeUsers: Math.round(sessions * 0.78) },
      daily,
      channels: [
        { channel: "Organic Search", sessions: organic, keyEvents: organicEvents },
        { channel: "Direct", sessions: direct, keyEvents: directEvents },
        { channel: "Organic Social", sessions: sessions - organic - direct, keyEvents: keyEvents - organicEvents - directEvents },
      ],
      pages: [
        { path: "/", screenPageViews: Math.round(screenPageViews * 0.44) },
        { path: "/workshop-checklist", screenPageViews: Math.round(screenPageViews * 0.29) },
        { path: "/resources", screenPageViews: Math.round(screenPageViews * 0.18) },
      ],
      timezone: "UTC",
      warnings: [],
    };
  },
};

const server = createApp({ config, store, linkedin: provider, ga4 });
server.listen(config.port, config.host, () => {
  console.log(`Synthetic demo: ${config.origin.origin} · password: ${password}`);
});
server.on("error", () => {
  console.error("The demo could not listen on 127.0.0.1:3010.");
  store.close();
  process.exitCode = 1;
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close(() => store.close()));
}
