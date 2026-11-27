const API = "https://api.linkedin.com";
const LINKEDIN = "https://www.linkedin.com";
const API_TIMEOUT_MS = 12_000;
const ORGANIZATION_ID = /^\d{1,20}$/;
const POST_URN = /^urn:li:(?:share|ugcPost):\d{1,24}$/;

export class LinkedInError extends Error {
  constructor(message, { status = null, uncertain = false } = {}) {
    super(message);
    this.name = "LinkedInError";
    this.status = status;
    this.uncertain = uncertain;
  }
}

function organization(id) {
  const value = String(id ?? "").replace(/^urn:li:organization:/, "");
  if (!ORGANIZATION_ID.test(value)) throw new LinkedInError("Invalid organization ID");
  return { id: value, urn: `urn:li:organization:${value}` };
}
function postUrl(urn) {
  if (!POST_URN.test(urn)) throw new LinkedInError("Invalid post identifier");
  return `${LINKEDIN}/feed/update/${urn}/`;
}
function cleanUrl(url) {
  if (url == null || url === "") return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || u.username || u.password) throw new Error();
    return u.href;
  } catch {
    throw new LinkedInError("Invalid link URL");
  }
}
function mapPost(p) {
  if (!p || !POST_URN.test(p.id ?? "")) return null;
  const date = Number(p.publishedAt ?? p.createdAt);
  let linkUrl = null;
  try {
    linkUrl = cleanUrl(p.content?.article?.source);
  } catch {
    /* ignore invalid provider data */
  }
  return {
    urn: p.id,
    url: postUrl(p.id),
    body: typeof p.commentary === "string" ? p.commentary : "",
    linkUrl,
    publishedAt:
      Number.isFinite(date) && date > 0 && date <= 8640000000000000
        ? new Date(date).toISOString()
        : null,
  };
}
function stat(value) {
  if (!value || typeof value !== "object") return null;
  const fields = ["impressionCount", "clickCount", "likeCount", "commentCount", "shareCount"];
  if (!fields.every((k) => typeof value[k] === "number" && Number.isFinite(value[k]))) return null;
  return {
    impressions: value.impressionCount,
    clicks: value.clickCount,
    reactions: value.likeCount,
    comments: value.commentCount,
    shares: value.shareCount,
  };
}
function elementName(org) {
  if (typeof org.localizedName === "string" && org.localizedName.trim())
    return org.localizedName.trim();
  const n = org.name;
  if (typeof n === "string" && n.trim()) return n.trim();
  const locale = n?.preferredLocale;
  const preferred = locale && n?.localized?.[`${locale.language}_${locale.country}`];
  return typeof preferred === "string" && preferred.trim() ? preferred.trim() : null;
}

export function createLinkedIn({
  clientId,
  clientSecret,
  redirectUri,
  version,
  fetchImpl = fetch,
}) {
  if (
    !clientId ||
    !clientSecret ||
    !redirectUri ||
    !/^\d{6}$/.test(version ?? "") ||
    typeof fetchImpl !== "function"
  ) {
    throw new LinkedInError("LinkedIn configuration is incomplete");
  }
  let redirect;
  try {
    redirect = new URL(redirectUri);
  } catch {
    throw new LinkedInError("Invalid OAuth redirect URI");
  }
  if (
    !["http:", "https:"].includes(redirect.protocol) ||
    redirect.username ||
    redirect.password ||
    redirect.hash ||
    (redirect.protocol === "http:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(redirect.hostname))
  ) {
    throw new LinkedInError("Invalid OAuth redirect URI");
  }
  const commonHeaders = {
    "Linkedin-Version": version,
    "X-Restli-Protocol-Version": "2.0.0",
    Accept: "application/json",
  };
  async function request(path, { method = "GET", token, form, body } = {}) {
    if (!path.startsWith("/rest/") && path !== "/oauth/v2/accessToken")
      throw new LinkedInError("Invalid LinkedIn endpoint");
    const headers = { ...commonHeaders };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (form) headers["Content-Type"] = "application/x-www-form-urlencoded";
    if (body) headers["Content-Type"] = "application/json";
    let res;
    try {
      res = await fetchImpl(`${path === "/oauth/v2/accessToken" ? LINKEDIN : API}${path}`, {
        method,
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
        ...(form
          ? { body: new URLSearchParams(form).toString() }
          : body
            ? { body: JSON.stringify(body) }
            : {}),
      });
    } catch {
      throw new LinkedInError("LinkedIn request failed", { uncertain: method === "POST" });
    }
    if (!res.ok)
      throw new LinkedInError("LinkedIn request was rejected", {
        status: res.status,
        uncertain:
          method === "POST" &&
          (res.status >= 500 || res.status === 408 || (res.status >= 300 && res.status < 400)),
      });
    return res;
  }
  async function json(res) {
    try {
      return await res.json();
    } catch {
      throw new LinkedInError("Invalid LinkedIn response", { status: res.status });
    }
  }
  function authorizeUrl(state) {
    if (typeof state !== "string" || !state) throw new LinkedInError("OAuth state is required");
    const u = new URL(`${LINKEDIN}/oauth/v2/authorization`);
    u.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirect.href,
      state,
      scope: "r_organization_social w_organization_social rw_organization_admin",
    }).toString();
    return u.href;
  }
  async function exchangeCode(code) {
    if (typeof code !== "string" || !code)
      throw new LinkedInError("Authorization code is required");
    const res = await request("/oauth/v2/accessToken", {
      method: "POST",
      form: {
        grant_type: "authorization_code",
        code,
        redirect_uri: redirect.href,
        client_id: clientId,
        client_secret: clientSecret,
      },
    });
    const d = await json(res);
    if (
      typeof d.access_token !== "string" ||
      !d.access_token ||
      !Number.isFinite(d.expires_in) ||
      d.expires_in <= 0
    )
      throw new LinkedInError("Invalid token response");
    return {
      accessToken: d.access_token,
      expiresAt: new Date(Date.now() + d.expires_in * 1000).toISOString(),
    };
  }
  async function verifyOrganization(token, organizationId) {
    const org = organization(organizationId);
    let approved = false;
    // Bounded pagination uses locally constructed offsets, never provider URLs.
    for (let start = 0; start < 1000; start += 100) {
      const params = new URLSearchParams({
        q: "roleAssignee",
        role: "ADMINISTRATOR",
        state: "APPROVED",
        count: "100",
        start: String(start),
      });
      const acl = await json(await request(`/rest/organizationAcls?${params}`, { token }));
      if (!Array.isArray(acl.elements))
        throw new LinkedInError("Invalid organization permissions response");
      approved = acl.elements.some(
        (x) =>
          (x.organization === org.urn || x.organizationTarget === org.urn) &&
          x.role === "ADMINISTRATOR" &&
          x.state === "APPROVED",
      );
      if (approved) break;
      const hasNext =
        Array.isArray(acl.paging?.links) && acl.paging.links.some((x) => x.rel === "next");
      if (!hasNext && acl.elements.length < 100) break;
    }
    if (!approved)
      throw new LinkedInError("Organization administrator access required", { status: 403 });
    const d = await json(await request(`/rest/organizations/${org.id}`, { token }));
    if (String(d.id) !== org.id) throw new LinkedInError("Invalid organization response");
    const name = elementName(d);
    if (!name) throw new LinkedInError("Organization name is unavailable");
    return { id: org.id, name, pageUrl: `${LINKEDIN}/company/${org.id}/` };
  }
  async function publish(token, organizationId, post) {
    const org = organization(organizationId);
    if (typeof post?.body !== "string" || !post.body.trim() || post.body.length > 3000)
      throw new LinkedInError("Invalid post text");
    const link = cleanUrl(post.linkUrl);
    if (
      link &&
      (typeof post.linkTitle !== "string" || !post.linkTitle.trim() || post.linkTitle.length > 200)
    )
      throw new LinkedInError("Link title is required");
    const body = {
      author: org.urn,
      commentary: post.body,
      visibility: "PUBLIC",
      distribution: {
        feedDistribution: "MAIN_FEED",
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    };
    if (link) body.content = { article: { source: link, title: post.linkTitle.trim() } };
    const res = await request("/rest/posts", { method: "POST", token, body });
    const urn = res.headers.get("x-restli-id");
    if (res.status !== 201 || !urn || !POST_URN.test(urn))
      throw new LinkedInError("LinkedIn did not return a post identifier", {
        status: res.status,
        uncertain: true,
      });
    return { urn, url: postUrl(urn) };
  }
  async function listPosts(token, organizationId) {
    const org = organization(organizationId);
    const query = new URLSearchParams({
      author: org.urn,
      q: "author",
      count: "20",
      sortBy: "CREATED",
    });
    const d = await json(await request(`/rest/posts?${query}`, { token }));
    if (!Array.isArray(d.elements)) throw new LinkedInError("Invalid posts response");
    return d.elements
      .filter((p) => p.author === org.urn && p.lifecycleState === "PUBLISHED")
      .map(mapPost)
      .filter(Boolean)
      .sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""))
      .slice(0, 20);
  }
  async function report(token, organizationId, days) {
    const org = organization(organizationId);
    if (!Number.isInteger(days) || days < 1 || days > 365)
      throw new LinkedInError("Invalid reporting period");
    const now = new Date();
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const start = new Date(end.getTime() - days * 86400000);
    const from = start.toISOString();
    const to = end.toISOString();
    const warnings = [];
    let posts = [];
    let totals = null;
    try {
      posts = await listPosts(token, org.id);
    } catch {
      warnings.push("Posts could not be retrieved.");
    }
    const params = new URLSearchParams({
      q: "organizationalEntity",
      organizationalEntity: org.urn,
    });
    // LinkedIn's Rest.li 2.0 syntax encodes the record as a single parameter.
    const timeIntervals = `timeIntervals=(timeRange:(start:${start.getTime()},end:${end.getTime()}),timeGranularityType:DAY)`;
    try {
      const d = await json(
        await request(`/rest/organizationalEntityShareStatistics?${params}&${timeIntervals}`, {
          token,
        }),
      );
      if (!Array.isArray(d.elements)) throw new Error();
      const rows = d.elements.map((x) => stat(x.totalShareStatistics));
      if (!rows.every(Boolean)) throw new Error();
      if (rows.length)
        totals = rows.reduce((a, b) =>
          Object.fromEntries(Object.keys(a).map((k) => [k, a[k] + b[k]])),
        );
      else warnings.push("No aggregate statistics were returned.");
    } catch {
      warnings.push("Aggregate statistics could not be retrieved.");
    }
    // One documented FINDER request per post: bounded to 20; no BATCH_GET required.
    const enriched = [];
    async function enrich(p) {
      let metrics = null;
      try {
        const q = new URLSearchParams({ q: "organizationalEntity", organizationalEntity: org.urn });
        // Rest.li structural delimiters remain literal; encode only URN values.
        const postFilter = p.urn.startsWith("urn:li:share:")
          ? `shares=List(${encodeURIComponent(p.urn)})`
          : `ugcPosts[0]=${encodeURIComponent(p.urn)}`;
        const d = await json(
          await request(`/rest/organizationalEntityShareStatistics?${q}&${postFilter}`, { token }),
        );
        if (!Array.isArray(d.elements)) throw new Error();
        const matched = d.elements.find((x) => x.share === p.urn || x.ugcPost === p.urn);
        metrics = matched
          ? stat(matched.totalShareStatistics)
          : { impressions: 0, clicks: 0, reactions: 0, comments: 0, shares: 0 };
        if (!metrics) throw new Error();
      } catch {
        if (!warnings.includes("Lifetime statistics could not be retrieved for a post."))
          warnings.push("Lifetime statistics could not be retrieved for a post.");
      }
      return { ...p, metrics };
    }
    for (let i = 0; i < posts.length; i += 4) {
      enriched.push(...(await Promise.all(posts.slice(i, i + 4).map(enrich))));
    }
    return { from, to, totals, posts: enriched, warnings };
  }
  return { authorizeUrl, exchangeCode, verifyOrganization, publish, listPosts, report };
}
