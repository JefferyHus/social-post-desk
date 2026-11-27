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

const server = createApp({ config, store, linkedin: provider });
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
