import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, StoreError } from "../src/store.js";
const key = Buffer.alloc(32, 5);
const conflict = (fn) => assert.throws(fn, (e) => e instanceof StoreError && e.status === 409);
const notFound = (fn) => assert.throws(fn, (e) => e instanceof StoreError && e.status === 404);
const page = {
  id: "urn:li:organization:123",
  name: "Demo page",
  pageUrl: "https://www.linkedin.com/company/example/",
  accessToken: "synthetic-secret-token",
  expiresAt: "2099-01-01T00:00:00.000Z",
};

test("key length is enforced and project objects never expose stored tokens", () => {
  assert.throws(() => openStore({ filename: ":memory:", key: Buffer.alloc(31) }), TypeError);
  const s = openStore({ filename: ":memory:", key });
  const p = s.createProject({ name: "A", organizationId: page.id });
  const connected = s.connect(p.id, page);
  assert.equal(connected.connection, "connected");
  assert.equal(JSON.stringify(connected).includes(page.accessToken), false);
  assert.equal(JSON.stringify(s.listProjects()).includes(page.accessToken), false);
  assert.deepEqual(s.getCredentials(p.id), {
    accessToken: page.accessToken,
    expiresAt: page.expiresAt,
  });
  const expired = s.connect(p.id, { ...page, expiresAt: "2000-01-01T00:00:00.000Z" });
  assert.equal(expired.connection, "expired");
  s.close();
});

test("disk tokens are encrypted, isolated and authenticated to project identity", () => {
  const dir = mkdtempSync(join(tmpdir(), "social-post-desk-"));
  const file = join(dir, "db.sqlite");
  try {
    const s = openStore({ filename: file, key });
    const a = s.createProject({ name: "A", organizationId: page.id });
    const b = s.createProject({ name: "B", organizationId: "urn:li:organization:456" });
    s.connect(a.id, page);
    s.connect(b.id, { ...page, id: "urn:li:organization:456", accessToken: "second-secret-token" });
    assert.equal(statSync(dir).mode & 0o077, 0);
    assert.equal(statSync(file).mode & 0o077, 0);
    assert.equal(readFileSync(file).includes(Buffer.from(page.accessToken)), false);
    const other = new DatabaseSync(file);
    other
      .prepare(
        "UPDATE projects SET token_nonce=(SELECT token_nonce FROM projects WHERE id=?),token_ciphertext=(SELECT token_ciphertext FROM projects WHERE id=?),token_tag=(SELECT token_tag FROM projects WHERE id=?) WHERE id=?",
      )
      .run(a.id, a.id, a.id, b.id);
    assert.throws(() => s.getCredentials(b.id), /Unable to decrypt/);
    other.close();
    s.close();
    const wrong = openStore({ filename: file, key: Buffer.alloc(32, 8) });
    assert.throws(() => wrong.getCredentials(a.id), /Unable to decrypt/);
    wrong.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("project identity remains bound after connection, disconnection or publication attempt", () => {
  const s = openStore({ filename: ":memory:", key });
  const p = s.createProject({ name: "A", organizationId: page.id });
  conflict(() => s.connect(p.id, { ...page, id: "different" }));
  s.connect(p.id, page);
  s.disconnect(p.id);
  conflict(() => s.updateProject(p.id, { organizationId: "different" }));
  assert.equal(s.getCredentials(p.id), null);
  const d = s.createDraft(p.id, { body: "First" });
  s.claimPublish(p.id, d.id, d.revision);
  conflict(() => s.disconnect(p.id));
  conflict(() => s.updateProject(p.id, { organizationId: "different" }));
  s.close();
});

test("drafts are project scoped, revision guarded, and duplicate claims cannot run", () => {
  const s = openStore({ filename: ":memory:", key });
  const a = s.createProject({ name: "A", organizationId: page.id });
  const b = s.createProject({ name: "B" });
  const d = s.createDraft(a.id, { body: "First", linkUrl: null, linkTitle: null });
  notFound(() => s.getDraft(b.id, d.id));
  notFound(() => s.updateDraft(b.id, d.id, d.revision, { body: "cross tenant" }));
  const edited = s.updateDraft(a.id, d.id, d.revision, { body: "Updated" });
  conflict(() => s.updateDraft(a.id, d.id, d.revision, { body: "stale" }));
  const claimed = s.claimPublish(a.id, d.id, edited.revision);
  assert.equal(claimed.status, "publishing");
  assert.ok(claimed.publishStartedAt);
  conflict(() => s.claimPublish(a.id, d.id, edited.revision));
  conflict(() => s.updateDraft(a.id, d.id, claimed.revision, { body: "after claim" }));
  conflict(() => s.finishPublish(a.id, d.id, edited.revision, { status: "draft" }));
  const review = s.finishPublish(a.id, d.id, claimed.revision, {
    status: "needs_review",
    error: "Uncertain delivery",
  });
  assert.equal(review.publishStartedAt, claimed.publishStartedAt);
  conflict(() => s.claimPublish(a.id, d.id, review.revision));
  const done = s.completeReconciliation(a.id, d.id, review.revision, {
    postUrl: "https://www.linkedin.com/feed/update/example",
    publishedAt: "2026-11-27T12:00:00Z",
  });
  assert.equal(done.status, "published");
  conflict(() => s.claimPublish(a.id, d.id, done.revision));
  assert.deepEqual(s.listDrafts(b.id), []);
  s.close();
});

test("only stale in-flight claims may be reconciled or disconnected; duplicate URLs conflict", () => {
  const dir = mkdtempSync(join(tmpdir(), "social-post-desk-"));
  const file = join(dir, "db.sqlite");
  try {
    const s = openStore({ filename: file, key });
    const p = s.createProject({ name: "A", organizationId: page.id });
    s.connect(p.id, page);
    const d = s.createDraft(p.id, { body: "A" }),
      claim = s.claimPublish(p.id, d.id, d.revision);
    conflict(() =>
      s.completeReconciliation(p.id, d.id, claim.revision, {
        postUrl: "https://www.linkedin.com/feed/update/1",
        publishedAt: "2026-11-27T12:00:00Z",
      }),
    );
    const other = new DatabaseSync(file);
    other
      .prepare("UPDATE drafts SET publish_started_at=? WHERE id=?")
      .run("2000-01-01T00:00:00.000Z", d.id);
    other.close();
    assert.equal(s.disconnect(p.id).connection, "disconnected");
    const posted = s.completeReconciliation(p.id, d.id, claim.revision, {
      postUrl: "https://www.linkedin.com/feed/update/1",
      publishedAt: "2026-11-27T12:00:00Z",
    });
    assert.equal(posted.status, "published");
    const d2 = s.createDraft(p.id, { body: "B" }),
      claim2 = s.claimPublish(p.id, d2.id, d2.revision);
    conflict(() =>
      s.finishPublish(p.id, d2.id, claim2.revision, {
        status: "published",
        postUrl: posted.postUrl,
        publishedAt: "2026-11-27T12:00:00Z",
      }),
    );
    assert.equal(s.getDraft(p.id, d2.id).status, "publishing");
    s.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refuses insecure existing data directory without changing its permissions", () => {
  const dir = mkdtempSync(join(tmpdir(), "social-post-desk-"));
  chmodSync(dir, 0o755);
  try {
    assert.throws(() => openStore({ filename: join(dir, "db.sqlite"), key }), /private/);
    assert.equal(statSync(dir).mode & 0o777, 0o755);
  } finally {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("separate database connections cannot claim the same draft twice", () => {
  const dir = mkdtempSync(join(tmpdir(), "social-post-desk-")),
    file = join(dir, "db.sqlite");
  try {
    const first = openStore({ filename: file, key }),
      second = openStore({ filename: file, key });
    const p = first.createProject({ name: "A", organizationId: page.id }),
      d = first.createDraft(p.id, { body: "A" });
    const claimed = first.claimPublish(p.id, d.id, d.revision);
    conflict(() => second.claimPublish(p.id, d.id, d.revision));
    assert.equal(second.getDraft(p.id, d.id).revision, claimed.revision);
    first.close();
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("one Page post cannot be attributed to drafts in different projects", () => {
  const s = openStore({ filename: ":memory:", key });
  try {
    const a = s.createProject({ name: "A", organizationId: page.id });
    const b = s.createProject({ name: "B", organizationId: page.id });
    const c = s.createProject({ name: "Other page", organizationId: "456" });
    const url = "https://www.linkedin.com/feed/update/synthetic-1";
    const publishedAt = "2026-11-27T12:00:00Z";
    const createClaim = (p) => {
      const d = s.createDraft(p.id, { body: "Same synthetic text" });
      return s.claimPublish(p.id, d.id, d.revision);
    };
    const da = createClaim(a), db = createClaim(b);
    s.finishPublish(a.id, da.id, da.revision, { status: "published", postUrl: url, publishedAt });
    // Failed completion preserves the in-flight state and prevents retries.
    conflict(() => s.finishPublish(b.id, db.id, db.revision, { status: "published", postUrl: url, publishedAt }));
    assert.equal(s.getDraft(b.id, db.id).status, "publishing");
    const uncertain = s.finishPublish(b.id, db.id, db.revision, { status: "needs_review" });
    conflict(() => s.completeReconciliation(b.id, db.id, uncertain.revision, { postUrl: url, publishedAt }));
    assert.equal(s.getDraft(b.id, db.id).status, "needs_review");
    assert.equal(s.completeReconciliation(b.id, db.id, uncertain.revision, {
      postUrl: "https://www.linkedin.com/feed/update/synthetic-2", publishedAt,
    }).status, "published");
    // The uniqueness rule is scoped to the selected Page.
    const dc = createClaim(c);
    assert.equal(s.finishPublish(c.id, dc.id, dc.revision, { status: "published", postUrl: url, publishedAt }).status, "published");
  } finally { s.close(); }
});

test("historical cross-project duplicate links do not prevent database opening", () => {
  const dir = mkdtempSync(join(tmpdir(), "social-post-desk-"));
  const file = join(dir, "db.sqlite");
  try {
    const s = openStore({ filename: file, key });
    const a = s.createProject({ name: "A", organizationId: page.id });
    const b = s.createProject({ name: "B", organizationId: page.id });
    const da = s.createDraft(a.id, { body: "A" });
    const db = s.createDraft(b.id, { body: "B" });
    s.close();
    // Model an existing database from before the new guard.
    const legacy = new DatabaseSync(file);
    const addLegacy = legacy.prepare("UPDATE drafts SET status='published', post_url=?, published_at=? WHERE id=?");
    for (const d of [da, db]) addLegacy.run("https://www.linkedin.com/feed/update/legacy", "2026-11-27T12:00:00Z", d.id);
    legacy.close();
    const reopened = openStore({ filename: file, key });
    assert.equal(reopened.getDraft(a.id, da.id).status, "published");
    assert.equal(reopened.getDraft(b.id, db.id).status, "published");
    reopened.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
