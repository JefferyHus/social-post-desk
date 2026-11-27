import { DatabaseSync } from "node:sqlite";
import { randomBytes, randomUUID, createCipheriv, createDecipheriv } from "node:crypto";
import {
  constants,
  closeSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

export class StoreError extends Error {
  constructor(status, message = status === 404 ? "Not found" : "Conflict") {
    super(message);
    this.name = "StoreError";
    this.status = status;
  }
}

function prepareFile(filename) {
  if (filename === ":memory:") return filename;
  const path = resolve(filename);
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dirStat = lstatSync(dir);
  if (
    !dirStat.isDirectory() ||
    dirStat.isSymbolicLink() ||
    (typeof process.getuid === "function" && dirStat.uid !== process.getuid()) ||
    dirStat.mode & 0o077
  ) {
    throw new Error("Database directory must be private and owned by the current user");
  }
  const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())
    )
      throw new Error("Unsafe database file");
    fchmodSync(fd, 0o600);
  } finally {
    closeSync(fd);
  }
  return path;
}

export function openStore({ filename, key }) {
  if (typeof filename !== "string" || !filename || !Buffer.isBuffer(key) || key.length !== 32)
    throw new TypeError("A filename and 32-byte encryption key are required");
  const secret = Buffer.from(key);
  const db = new DatabaseSync(prepareFile(filename));
  db.exec(`PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, organization_id TEXT, organization_name TEXT, page_url TEXT,
      token_nonce BLOB, token_ciphertext BLOB, token_tag BLOB, token_expires_at TEXT,
      organization_locked INTEGER NOT NULL DEFAULT 0 CHECK (organization_locked IN (0,1))
    );
    CREATE TABLE IF NOT EXISTS drafts (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      body TEXT NOT NULL, link_url TEXT, link_title TEXT,
      status TEXT NOT NULL CHECK(status IN ('draft','publishing','needs_review','published')),
      revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      post_url TEXT, published_at TEXT, publish_started_at TEXT, error TEXT
    );
    CREATE TABLE IF NOT EXISTS ga4_connections (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      property_id TEXT NOT NULL, token_nonce BLOB NOT NULL, token_ciphertext BLOB NOT NULL, token_tag BLOB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS gsc_connections (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      site_url TEXT NOT NULL, token_nonce BLOB NOT NULL, token_ciphertext BLOB NOT NULL, token_tag BLOB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS drafts_project_created ON drafts(project_id, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS drafts_project_published_url ON drafts(project_id, post_url) WHERE post_url IS NOT NULL;
  `);
  const stmt = (sql) => db.prepare(sql);
  const now = () => new Date().toISOString();
  const tx = (fn) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (e) {
      db.exec("ROLLBACK");
      if (
        e?.code?.startsWith("SQLITE_CONSTRAINT") ||
        String(e?.message).includes("UNIQUE constraint failed")
      )
        throw new StoreError(409);
      throw e;
    }
  };
  const projectRow = (id) => stmt("SELECT * FROM projects WHERE id = ?").get(id);
  const draftRow = (pid, id) =>
    stmt("SELECT * FROM drafts WHERE project_id = ? AND id = ?").get(pid, id);
  const needProject = (id) => {
    const p = projectRow(id);
    if (!p) throw new StoreError(404);
    return p;
  };
  const needDraft = (pid, id) => {
    needProject(pid);
    const d = draftRow(pid, id);
    if (!d) throw new StoreError(404);
    return d;
  };
  // Call only inside the write transaction: the same Page's post must not be
  // attributed to two draft attempts, even when projects share that Page.
  const ensurePostUnassigned = (projectId, draftId, postUrl) => {
    const duplicate = stmt(`SELECT 1 FROM drafts d
      JOIN projects owner ON owner.id = d.project_id
      JOIN projects current ON current.id = ?
      WHERE owner.organization_id = current.organization_id
        AND d.post_url = ? AND d.id <> ? LIMIT 1`).get(projectId, postUrl, draftId);
    if (duplicate) throw new StoreError(409);
  };
  const project = (p) => ({
    id: p.id,
    name: p.name,
    organizationId: p.organization_id,
    organizationName: p.organization_name,
    pageUrl: p.page_url,
    connection: !p.token_ciphertext
      ? "disconnected"
      : p.token_expires_at && Date.parse(p.token_expires_at) <= Date.now()
        ? "expired"
        : "connected",
  });
  const draft = (d) => ({
    id: d.id,
    body: d.body,
    linkUrl: d.link_url,
    linkTitle: d.link_title,
    status: d.status,
    revision: d.revision,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
    postUrl: d.post_url,
    publishedAt: d.published_at,
    publishStartedAt: d.publish_started_at,
    error: d.error,
  });
  function encrypt(id, token) {
    const nonce = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", secret, nonce);
    cipher.setAAD(Buffer.from(id));
    const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
    return { nonce, ciphertext, tag: cipher.getAuthTag() };
  }
  function decrypt(p) {
    try {
      const decipher = createDecipheriv("aes-256-gcm", secret, p.token_nonce);
      decipher.setAAD(Buffer.from(p.id));
      decipher.setAuthTag(p.token_tag);
      return Buffer.concat([decipher.update(p.token_ciphertext), decipher.final()]).toString(
        "utf8",
      );
    } catch {
      throw new Error("Unable to decrypt stored credentials");
    }
  }
  const result = {
    listProjects() {
      return stmt("SELECT * FROM projects ORDER BY rowid").all().map(project);
    },
    getProject(id) {
      return project(needProject(id));
    },
    createProject({ name, organizationId = null }) {
      const id = randomUUID();
      stmt("INSERT INTO projects(id,name,organization_id) VALUES (?,?,?)").run(
        id,
        name,
        organizationId,
      );
      return project(needProject(id));
    },
    updateProject(id, { name, organizationId }) {
      return tx(() => {
        const p = needProject(id);
        const nextId =
          organizationId === undefined ? p.organization_id : organizationId;
        if (p.organization_locked && nextId !== p.organization_id)
          throw new StoreError(409);
        stmt(
          "UPDATE projects SET name = ?, organization_id = ? WHERE id = ?",
        ).run(name === undefined ? p.name : name, nextId, id);
        return project(needProject(id));
      });
    },
    connect(id, details) {
      return tx(() => {
        const p = needProject(id);
        if (p.organization_id !== null && p.organization_id !== details.id)
          throw new StoreError(409);
        if (typeof details.id !== "string" || !details.id)
          throw new StoreError(409);
        if (
          details.expiresAt != null &&
          !Number.isFinite(Date.parse(details.expiresAt))
        )
          throw new StoreError(409);
        if (typeof details.accessToken !== "string" || !details.accessToken)
          throw new StoreError(409);
        const sealed = encrypt(id, details.accessToken);
        stmt(
          "UPDATE projects SET organization_id=?,organization_name=?,page_url=?,token_nonce=?,token_ciphertext=?,token_tag=?,token_expires_at=?,organization_locked=1 WHERE id=?",
        ).run(
          details.id,
          details.name ?? null,
          details.pageUrl ?? null,
          sealed.nonce,
          sealed.ciphertext,
          sealed.tag,
          details.expiresAt ?? null,
          id,
        );
        return project(needProject(id));
      });
    },
    disconnect(id) {
      return tx(() => {
        needProject(id);
        if (
          stmt(
            "SELECT 1 FROM drafts WHERE project_id=? AND status='publishing' AND publish_started_at > ? LIMIT 1",
          ).get(id, new Date(Date.now() - 60_000).toISOString())
        )
          throw new StoreError(409);
        stmt(
          "UPDATE projects SET token_nonce=NULL, token_ciphertext=NULL, token_tag=NULL, token_expires_at=NULL WHERE id=?",
        ).run(id);
        return project(needProject(id));
      });
    },
    getCredentials(id) {
      const p = needProject(id);
      if (!p.token_ciphertext) return null;
      return { accessToken: decrypt(p), expiresAt: p.token_expires_at };
    },
    getGa4Connection(id) {
      needProject(id);
      const row = stmt(
        "SELECT property_id FROM ga4_connections WHERE project_id=?",
      ).get(id);
      return row ? { propertyId: row.property_id } : null;
    },
    getGa4RefreshToken(id) {
      needProject(id);
      const row = stmt("SELECT * FROM ga4_connections WHERE project_id=?").get(
        id,
      );
      if (!row) return null;
      try {
        const decipher = createDecipheriv(
          "aes-256-gcm",
          secret,
          row.token_nonce,
        );
        decipher.setAAD(
          Buffer.from(JSON.stringify(["ga4", id, row.property_id])),
        );
        decipher.setAuthTag(row.token_tag);
        return Buffer.concat([
          decipher.update(row.token_ciphertext),
          decipher.final(),
        ]).toString("utf8");
      } catch {
        throw new Error("Unable to decrypt stored credentials");
      }
    },
    setGa4Connection(id, { propertyId, refreshToken }) {
      return tx(() => {
        needProject(id);
        if (
          typeof propertyId !== "string" ||
          !/^[1-9]\d{0,19}$/.test(propertyId) ||
          typeof refreshToken !== "string" ||
          !refreshToken
        )
          throw new StoreError(409);
        const nonce = randomBytes(12),
          cipher = createCipheriv("aes-256-gcm", secret, nonce);
        cipher.setAAD(Buffer.from(JSON.stringify(["ga4", id, propertyId])));
        const ciphertext = Buffer.concat([
          cipher.update(refreshToken, "utf8"),
          cipher.final(),
        ]);
        stmt(`INSERT INTO ga4_connections(project_id,property_id,token_nonce,token_ciphertext,token_tag) VALUES (?,?,?,?,?)
          ON CONFLICT(project_id) DO UPDATE SET property_id=excluded.property_id, token_nonce=excluded.token_nonce,
          token_ciphertext=excluded.token_ciphertext,token_tag=excluded.token_tag`).run(
          id,
          propertyId,
          nonce,
          ciphertext,
          cipher.getAuthTag(),
        );
        return { propertyId };
      });
    },
    disconnectGa4(id) {
      needProject(id);
      stmt("DELETE FROM ga4_connections WHERE project_id=?").run(id);
    },
    getGscConnection(id) {
      needProject(id);
      const row = stmt(
        "SELECT site_url FROM gsc_connections WHERE project_id=?",
      ).get(id);
      return row ? { siteUrl: row.site_url } : null;
    },
    getGscRefreshToken(id) {
      needProject(id);
      const row = stmt("SELECT * FROM gsc_connections WHERE project_id=?").get(
        id,
      );
      if (!row) return null;
      try {
        const decipher = createDecipheriv(
          "aes-256-gcm",
          secret,
          row.token_nonce,
        );
        decipher.setAAD(Buffer.from(JSON.stringify(["gsc", id, row.site_url])));
        decipher.setAuthTag(row.token_tag);
        return Buffer.concat([
          decipher.update(row.token_ciphertext),
          decipher.final(),
        ]).toString("utf8");
      } catch {
        throw new Error("Unable to decrypt stored credentials");
      }
    },
    setGscConnection(id, { siteUrl, refreshToken }) {
      return tx(() => {
        needProject(id);
        if (
          typeof siteUrl !== "string" ||
          !siteUrl ||
          siteUrl.length > 2048 ||
          typeof refreshToken !== "string" ||
          !refreshToken
        )
          throw new StoreError(409);
        const nonce = randomBytes(12),
          cipher = createCipheriv("aes-256-gcm", secret, nonce);
        cipher.setAAD(Buffer.from(JSON.stringify(["gsc", id, siteUrl])));
        const ciphertext = Buffer.concat([
          cipher.update(refreshToken, "utf8"),
          cipher.final(),
        ]);
        stmt(`INSERT INTO gsc_connections(project_id,site_url,token_nonce,token_ciphertext,token_tag) VALUES (?,?,?,?,?)
          ON CONFLICT(project_id) DO UPDATE SET site_url=excluded.site_url, token_nonce=excluded.token_nonce,
          token_ciphertext=excluded.token_ciphertext,token_tag=excluded.token_tag`).run(
          id,
          siteUrl,
          nonce,
          ciphertext,
          cipher.getAuthTag(),
        );
        return { siteUrl };
      });
    },
    disconnectGsc(id) {
      needProject(id);
      stmt("DELETE FROM gsc_connections WHERE project_id=?").run(id);
    },
    listDrafts(pid) {
      needProject(pid);
      return stmt(
        "SELECT * FROM drafts WHERE project_id=? ORDER BY created_at DESC, id DESC",
      )
        .all(pid)
        .map(draft);
    },
    getDraft(pid, id) {
      return draft(needDraft(pid, id));
    },
    createDraft(pid, { body, linkUrl = null, linkTitle = null }) {
      return tx(() => {
        needProject(pid);
        const id = randomUUID(),
          t = now();
        stmt(
          "INSERT INTO drafts(id,project_id,body,link_url,link_title,status,revision,created_at,updated_at) VALUES (?,?,?,?,?,'draft',1,?,?)",
        ).run(id, pid, body, linkUrl, linkTitle, t, t);
        return draft(needDraft(pid, id));
      });
    },
    updateDraft(pid, id, revision, { body, linkUrl, linkTitle }) {
      return tx(() => {
        const d = needDraft(pid, id);
        if (d.status !== "draft" || d.revision !== revision)
          throw new StoreError(409);
        stmt(
          "UPDATE drafts SET body=?,link_url=?,link_title=?,revision=revision+1,updated_at=?,error=NULL WHERE project_id=? AND id=?",
        ).run(
          body === undefined ? d.body : body,
          linkUrl === undefined ? d.link_url : linkUrl,
          linkTitle === undefined ? d.link_title : linkTitle,
          now(),
          pid,
          id,
        );
        return draft(needDraft(pid, id));
      });
    },
    claimPublish(pid, id, revision) {
      return tx(() => {
        const d = needDraft(pid, id);
        if (
          d.status !== "draft" ||
          d.revision !== revision ||
          !needProject(pid).organization_id
        )
          throw new StoreError(409);
        stmt("UPDATE projects SET organization_locked=1 WHERE id=?").run(pid);
        const t = now();
        stmt(
          "UPDATE drafts SET status='publishing',revision=revision+1,updated_at=?,publish_started_at=?,error=NULL WHERE project_id=? AND id=?",
        ).run(t, t, pid, id);
        return draft(needDraft(pid, id));
      });
    },
    finishPublish(pid, id, revision, outcome) {
      return tx(() => {
        const d = needDraft(pid, id);
        if (
          d.status !== "publishing" ||
          d.revision !== revision ||
          !["draft", "needs_review", "published"].includes(outcome?.status)
        )
          throw new StoreError(409);
        if (
          outcome.status === "published" &&
          (!outcome.postUrl || !outcome.publishedAt)
        )
          throw new StoreError(409);
        if (outcome.status === "published")
          ensurePostUnassigned(pid, id, outcome.postUrl);
        stmt(
          "UPDATE drafts SET status=?,revision=revision+1,updated_at=?,post_url=?,published_at=?,publish_started_at=?,error=? WHERE project_id=? AND id=?",
        ).run(
          outcome.status,
          now(),
          outcome.status === "published" ? outcome.postUrl : null,
          outcome.status === "published" ? outcome.publishedAt : null,
          outcome.status === "draft" ? null : d.publish_started_at,
          outcome.status === "published" ? null : (outcome.error ?? null),
          pid,
          id,
        );
        return draft(needDraft(pid, id));
      });
    },
    completeReconciliation(pid, id, revision, { postUrl, publishedAt }) {
      return tx(() => {
        const d = needDraft(pid, id);
        const stale =
          d.status === "publishing" &&
          Date.now() - Date.parse(d.publish_started_at) >= 60_000;
        if (
          d.revision !== revision ||
          (d.status !== "needs_review" && !stale) ||
          !postUrl ||
          !publishedAt
        )
          throw new StoreError(409);
        ensurePostUnassigned(pid, id, postUrl);
        stmt(
          "UPDATE drafts SET status='published',revision=revision+1,updated_at=?,post_url=?,published_at=?,error=NULL WHERE project_id=? AND id=?",
        ).run(now(), postUrl, publishedAt, pid, id);
        return draft(needDraft(pid, id));
      });
    },
    close() {
      db.close();
      secret.fill(0);
    },
  };
  return result;
}
