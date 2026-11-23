/**
 * APPROVED TEST DESTINATION — "SGE Test Directory".
 *
 * A real HTTP directory site owned by the project, used for end-to-end acceptance tests so the engine is
 * exercised against genuine forms, APIs, moderation and published pages without touching any third-party
 * website. It is NOT a mock inside the engine: the engine talks to it over HTTP like any destination.
 *
 * Surfaces:
 *   GET  /                      home page (links, contact, robots-allowed)
 *   GET  /submit                server-rendered listing form (CSRF cookie + hidden token, terms checkbox, logo upload)
 *   GET  /submit-js             same form rendered by JavaScript (browser automation required)
 *   GET  /submit-captcha        form protected by a reCAPTCHA-style widget (engine must pause for a human)
 *   POST /submit, /submit-captcha
 *   GET  /listing/:id           published listing page with the backlink (only once approved)
 *   POST /api/v1/listings       official API (Bearer token, Idempotency-Key, 409 duplicates, fail-next injection)
 *   GET  /api/v1/listings/:id
 *   POST /wp-json/wp/v2/posts   WordPress-compatible draft endpoint (Basic auth; drafts only)
 *   POST /admin/...             moderator actions (x-admin-token): approve, remove, set rel, fail-next
 *   Security fixtures: /big, /gzip-bomb, /redirect-private, /redirect-loop, /slow, /private/*
 */
import http from "node:http";
import zlib from "node:zlib";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";

export interface Listing {
  id: number;
  business_name: string;
  website_url: string;
  anchor_text: string;
  email: string;
  category: string;
  country: string;
  short_description: string;
  long_description: string;
  logo_bytes: number;
  status: "pending" | "approved" | "removed";
  rel: string;
  via: "form" | "api" | "form-js" | "form-captcha";
  created_at: string;
  idempotency_key: string | null;
}

export interface DestinationOptions {
  port?: number;
  apiToken?: string;
  adminToken?: string;
  wpUser?: string;
  wpPassword?: string;
  autoApprove?: boolean;
}

export interface TestDestination {
  url: string;
  port: number;
  state: { listings: Listing[]; posts: any[]; failNext: { count: number; status: number }; requests: { method: string; path: string; ua: string }[] };
  close(): Promise<void>;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)} | SGE Test Directory</title>
<meta name="description" content="SGE Test Directory is the approved end-to-end test destination for the SEO Growth Engine. It lists technology, healthcare and professional services businesses in India and worldwide.">
<link rel="canonical" href="/"><script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"SGE Test Directory"}</script>
</head><body><header><nav><a href="/">Home</a> <a href="/listings">Listings</a> <a href="/submit">Add your business</a> <a href="/resources">Resources</a> <a href="/about">About</a> <a href="/contact">Contact</a> <a href="/privacy">Privacy</a></nav></header>
<main>${body}</main><footer>SGE Test Directory — approved test destination. Contact: editor@sge-test-directory.invalid</footer></body></html>`;
}

const FORM_FIELDS = (csrf: string, extra = "") => `
  <input type="hidden" name="csrf_token" value="${csrf}">
  <label for="business_name">Business name</label><input id="business_name" name="business_name" required>
  <label for="website_url">Website URL</label><input id="website_url" name="website_url" type="url" required>
  <label for="email">Contact email</label><input id="email" name="email" type="email" required>
  <label for="category">Category</label><select id="category" name="category"><option value="">Choose…</option><option>Technology / SaaS</option><option>Healthcare</option><option>Professional services</option><option>Digital marketing agency</option><option>Manufacturing / Industrial</option><option>Other</option></select>
  <label for="country">Country</label><input id="country" name="country">
  <label for="short_description">Short description</label><input id="short_description" name="short_description" maxlength="160">
  <label for="long_description">About the business</label><textarea id="long_description" name="long_description"></textarea>
  <label for="logo">Logo</label><input id="logo" name="logo" type="file" accept="image/*">
  <label><input type="checkbox" name="newsletter"> Send me the directory newsletter</label>
  <label><input type="checkbox" name="agree_terms" required> I agree to the directory terms</label>
  ${extra}
  <button type="submit">Submit listing</button>`;

function parseCookies(h: string | undefined): Record<string, string> {
  return Object.fromEntries(
    (h ?? "")
      .split(";")
      .map((c) => c.trim().split("="))
      .filter((p) => p[0])
      .map(([k, ...v]) => [k, v.join("=")])
  );
}

function parseMultipart(body: Buffer, contentType: string): { fields: Record<string, string>; files: Record<string, number> } {
  const boundary = contentType
    .match(/boundary=(?:"([^"]+)"|([^;]+))/)
    ?.slice(1)
    .find(Boolean);
  const fields: Record<string, string> = {};
  const files: Record<string, number> = {};
  if (!boundary) return { fields, files };
  const parts = body.toString("latin1").split(`--${boundary}`);
  for (const part of parts) {
    const idx = part.indexOf("\r\n\r\n");
    if (idx < 0) continue;
    const head = part.slice(0, idx);
    const content = part.slice(idx + 4).replace(/\r\n$/, "");
    const name = head.match(/name="([^"]+)"/)?.[1];
    if (!name) continue;
    if (/filename="/.test(head)) files[name] = Buffer.byteLength(content, "latin1");
    else fields[name] = Buffer.from(content, "latin1").toString("utf8");
  }
  return { fields, files };
}

function readBody(req: http.IncomingMessage, limit = 2_000_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on("data", (c: Buffer) => {
      n += c.length;
      if (n > limit) {
        reject(new Error("too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function hostOf(u: string): string {
  try {
    return new URL(u).host.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export async function startTestDestination(opts: DestinationOptions = {}): Promise<TestDestination> {
  const apiToken = opts.apiToken ?? "test-api-token";
  const adminToken = opts.adminToken ?? "test-admin-token";
  const wpUser = opts.wpUser ?? "sge-partner";
  const wpPassword = opts.wpPassword ?? "abcd efgh ijkl mnop";
  const state: TestDestination["state"] = { listings: [], posts: [], failNext: { count: 0, status: 503 }, requests: [] };
  const csrfTokens = new Set<string>();

  function createListing(
    f: Record<string, string>,
    via: Listing["via"],
    files: Record<string, number> = {},
    idem: string | null = null
  ): { listing?: Listing; error?: string; code?: number } {
    const missing = ["business_name", "website_url", "email"].filter((k) => !f[k]?.trim());
    if (missing.length) return { error: `Error: ${missing.join(", ")} is required`, code: 422 };
    const businessName = f.business_name!;
    const websiteUrl = f.website_url!;
    if (!/^https?:\/\//.test(websiteUrl)) return { error: "Error: website_url is invalid", code: 422 };
    if ((f.short_description ?? "").length > 160) return { error: "Error: short_description exceeds 160 characters", code: 422 };
    if (idem) {
      const prior = state.listings.find((l) => l.idempotency_key === idem);
      if (prior) return { listing: prior, code: 200 };
    }
    if (state.listings.some((l) => l.status !== "removed" && hostOf(l.website_url) === hostOf(websiteUrl))) {
      return { error: "Error: this website is already listed (duplicate)", code: 409 };
    }
    const listing: Listing = {
      id: state.listings.length + 1,
      business_name: businessName.trim(),
      website_url: websiteUrl.trim(),
      anchor_text: (f.anchor_text ?? businessName).trim(),
      email: f.email ?? f.contact_email ?? "",
      category: f.category ?? "",
      country: f.country ?? "",
      short_description: f.short_description ?? "",
      long_description: f.long_description ?? "",
      logo_bytes: files.logo ?? 0,
      status: opts.autoApprove ? "approved" : "pending",
      rel: "",
      via,
      created_at: new Date().toISOString(),
      idempotency_key: idem
    };
    state.listings.push(listing);
    return { listing, code: 201 };
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const p = url.pathname;
    state.requests.push({ method: req.method ?? "GET", path: p, ua: String(req.headers["user-agent"] ?? "") });
    const send = (code: number, body: string, headers: Record<string, string> = {}) => {
      res.writeHead(code, { "content-type": "text/html; charset=utf-8", ...headers });
      res.end(body);
    };
    const json = (code: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(code, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    try {
      // ---------------- public pages ----------------
      if (req.method === "GET" && p === "/robots.txt")
        return send(200, "User-agent: *\nDisallow: /admin\nDisallow: /private/\n", { "content-type": "text/plain" });
      if (req.method === "GET" && p === "/") {
        return send(
          200,
          page(
            "Business directory",
            `<h1>SGE Test Directory</h1>
          <p>An approved test destination listing technology, software, SaaS, healthcare, digital marketing agency and professional services businesses in India, the United Kingdom and worldwide.
          Businesses can <a href="/submit">add your business</a> for free; every listing is reviewed by an editor before publication.
          Listings help customers discover trustworthy local and online services. We do not sell links and we do not accept paid placements.</p>
          <p>Browse <a href="/listings">all listings</a>, read our <a href="/resources">resources</a> or <a href="/contact">contact the editor</a>.</p>
          <ul>${Array.from({ length: 12 }, (_, i) => `<li><a href="/category/${i}">Category ${i}</a></li>`).join("")}</ul>`
          )
        );
      }
      if (req.method === "GET" && ["/about", "/privacy", "/resources"].includes(p)) {
        return send(
          200,
          page(
            p.slice(1),
            `<h1>${p.slice(1)}</h1><p>Information about the SGE Test Directory, an editorially reviewed directory of businesses in India and worldwide, maintained for software testing.</p>`
          )
        );
      }
      if (req.method === "GET" && p === "/contact")
        return send(
          200,
          page("Contact", `<h1>Contact</h1><p>Editor: <a href="mailto:editor@sge-test-directory.invalid">editor@sge-test-directory.invalid</a></p>`)
        );
      if (req.method === "GET" && p.startsWith("/category/"))
        return send(200, page("Category", `<h1>Category</h1><p>Listings in this category.</p>`));
      if (req.method === "GET" && p === "/listings") {
        const items = state.listings
          .filter((l) => l.status === "approved")
          .map((l) => `<li><a href="/listing/${l.id}">${esc(l.business_name)}</a></li>`)
          .join("");
        return send(200, page("Listings", `<h1>Listings</h1><ul>${items}</ul>`));
      }
      const lm = p.match(/^\/listing\/(\d+)$/);
      if (req.method === "GET" && lm) {
        const l = state.listings.find((x) => x.id === Number(lm[1]));
        if (!l || l.status === "pending") return send(404, page("Not found", "<h1>Listing not found</h1>"));
        if (l.status === "removed") return send(410, page("Removed", "<h1>This listing has been removed</h1>"));
        const rel = l.rel ? ` rel="${esc(l.rel)}"` : "";
        return send(
          200,
          page(
            l.business_name,
            `<article><h1>${esc(l.business_name)}</h1><p>${esc(l.short_description)}</p><p>${esc(l.long_description)}</p>
          <p>Website: <a href="${esc(l.website_url)}"${rel}>${esc(l.anchor_text)}</a></p><p>Category: ${esc(l.category)} · Country: ${esc(l.country)}</p></article>`
          )
        );
      }

      // ---------------- forms ----------------
      if (req.method === "GET" && (p === "/submit" || p === "/submit-captcha")) {
        const token = crypto.randomBytes(16).toString("hex");
        csrfTokens.add(token);
        const captcha =
          p === "/submit-captcha"
            ? `<div class="g-recaptcha" data-sitekey="test-site-key"></div><script src="/static/recaptcha/api.js" async defer></script>`
            : "";
        return send(
          200,
          page(
            "Add your business",
            `<h1>Add your business</h1><p>Free listing. All submissions are reviewed by an editor.</p>
          <form method="post" action="${p}" enctype="multipart/form-data">${FORM_FIELDS(token, captcha)}</form>`
          ),
          { "set-cookie": `csrf=${token}; Path=/; HttpOnly; SameSite=Lax` }
        );
      }
      if (req.method === "GET" && p === "/static/recaptcha/api.js")
        return send(200, "/* placeholder widget */", { "content-type": "application/javascript" });
      if (req.method === "GET" && p === "/submit-js") {
        const token = crypto.randomBytes(16).toString("hex");
        csrfTokens.add(token);
        const formHtml = FORM_FIELDS(token).replace(/`/g, "\\`");
        return send(
          200,
          page(
            "Add your business",
            `<h1>Add your business</h1><div id="app">Loading…</div>
          <script>setTimeout(function(){ document.getElementById('app').innerHTML = \`<form method="post" action="/submit-js" enctype="multipart/form-data">${formHtml}</form>\`; }, 150);</script>`
          ),
          { "set-cookie": `csrf=${token}; Path=/; HttpOnly; SameSite=Lax` }
        );
      }
      if (req.method === "POST" && ["/submit", "/submit-js", "/submit-captcha"].includes(p)) {
        const raw = await readBody(req);
        const ct = String(req.headers["content-type"] ?? "");
        const { fields, files } = ct.includes("multipart")
          ? parseMultipart(raw, ct)
          : { fields: Object.fromEntries(new URLSearchParams(raw.toString())), files: {} };
        const cookie = parseCookies(req.headers.cookie).csrf;
        if (!fields.csrf_token || fields.csrf_token !== cookie || !csrfTokens.has(fields.csrf_token))
          return send(403, page("Error", "<h1>Error: invalid or missing security token</h1>"));
        csrfTokens.delete(fields.csrf_token);
        if (p === "/submit-captcha" && !fields["g-recaptcha-response"])
          return send(400, page("Error", "<h1>Error: please complete the CAPTCHA</h1>"));
        if (!fields.agree_terms) return send(422, page("Error", "<h1>Error: you must agree to the directory terms</h1>"));
        const r = createListing(fields, p === "/submit" ? "form" : p === "/submit-js" ? "form-js" : "form-captcha", files);
        if (r.error) return send(r.code ?? 422, page("Error", `<h1>${esc(r.error)}</h1>`));
        const l = r.listing!;
        return send(
          200,
          page(
            "Thank you",
            `<h1>Thank you!</h1><p class="confirmation">Your listing #${l.id} has been received and is pending review. Once approved it will appear at <a href="/listing/${l.id}">/listing/${l.id}</a>.</p>`
          )
        );
      }

      // ---------------- official API ----------------
      if (p === "/api/v1/listings" && req.method === "POST") {
        if (req.headers.authorization !== `Bearer ${apiToken}`) return json(401, { error: "invalid token" });
        if (state.failNext.count > 0) {
          state.failNext.count--;
          return json(state.failNext.status, { error: "temporarily unavailable (injected)" }, { "retry-after": "1" });
        }
        const body = JSON.parse((await readBody(req)).toString() || "{}");
        const r = createListing(
          { ...body, email: body.contact_email ?? "", website_url: body.website_url ?? "" },
          "api",
          {},
          String(req.headers["idempotency-key"] ?? "") || null
        );
        if (r.error) return json(r.code ?? 422, { error: r.error });
        const l = r.listing!;
        const origin = `http://${req.headers.host}`;
        return json(r.code ?? 201, { id: l.id, status: l.status, listing_url: `${origin}/listing/${l.id}` });
      }
      const am = p.match(/^\/api\/v1\/listings\/(\d+)$/);
      if (am && req.method === "GET") {
        if (req.headers.authorization !== `Bearer ${apiToken}`) return json(401, { error: "invalid token" });
        const l = state.listings.find((x) => x.id === Number(am[1]));
        if (!l) return json(404, { error: "not found" });
        return json(200, { id: l.id, status: l.status, listing_url: `http://${req.headers.host}/listing/${l.id}` });
      }

      // ---------------- WordPress-compatible drafts ----------------
      if (p === "/wp-json/wp/v2/posts" && req.method === "POST") {
        const expected = `Basic ${Buffer.from(`${wpUser}:${wpPassword}`).toString("base64")}`;
        if (req.headers.authorization !== expected) return json(401, { code: "rest_not_logged_in", message: "Invalid credentials" });
        const body = JSON.parse((await readBody(req)).toString() || "{}");
        if (body.status && body.status !== "draft") return json(403, { code: "rest_cannot_publish", message: "Partners may only create drafts" });
        const post = {
          id: 100 + state.posts.length,
          status: "draft",
          title: body.title,
          content: body.content,
          link: `http://${req.headers.host}/?p=${100 + state.posts.length}`
        };
        state.posts.push(post);
        return json(201, post);
      }

      // ---------------- moderator / test controls ----------------
      if (p.startsWith("/admin/")) {
        if (req.headers["x-admin-token"] !== adminToken) return json(403, { error: "forbidden" });
        const body = req.method === "POST" ? JSON.parse((await readBody(req)).toString() || "{}") : {};
        const m = p.match(/^\/admin\/listings\/(\d+)\/(approve|remove|rel)$/);
        if (m) {
          const l = state.listings.find((x) => x.id === Number(m[1]));
          if (!l) return json(404, { error: "not found" });
          if (m[2] === "approve") ((l.status = "approved"), (l.rel = body.rel ?? l.rel));
          if (m[2] === "remove") l.status = "removed";
          if (m[2] === "rel") l.rel = body.rel ?? "";
          return json(200, l);
        }
        if (p === "/admin/fail-next") {
          state.failNext = { count: Number(body.count ?? 1), status: Number(body.status ?? 503) };
          return json(200, state.failNext);
        }
        if (p === "/admin/state") return json(200, state);
        return json(404, { error: "unknown admin route" });
      }

      // ---------------- crawler security fixtures ----------------
      if (p === "/big") {
        res.writeHead(200, { "content-type": "text/html" });
        const chunk = Buffer.alloc(64 * 1024, "a");
        let sent = 0;
        const write = () => {
          while (sent < 8 * 1024 * 1024) {
            sent += chunk.length;
            if (!res.write(chunk)) return res.once("drain", write);
          }
          res.end();
        };
        res.on("close", () => (sent = Number.MAX_SAFE_INTEGER));
        return write();
      }
      if (p === "/gzip-bomb") {
        const bomb = zlib.gzipSync(Buffer.alloc(50 * 1024 * 1024, 0));
        res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" });
        return res.end(bomb);
      }
      if (p === "/redirect-private") return send(302, "", { location: "http://169.254.169.254/latest/meta-data/" });
      if (p === "/redirect-loop") return send(302, "", { location: `/redirect-loop?n=${Number(url.searchParams.get("n") ?? 0) + 1}` });
      if (p === "/slow") return void setTimeout(() => send(200, page("slow", "slow")), 60_000);
      if (p.startsWith("/private/")) return send(200, page("Private", "<h1>Private area</h1>"));
      if (p === "/binary") return send(200, "PK\u0003\u0004", { "content-type": "application/zip" });
      return send(404, page("Not found", "<h1>Not found</h1>"));
    } catch (err) {
      return send(500, page("Error", `<h1>Server error</h1><pre>${esc((err as Error).message)}</pre>`));
    }
  });
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    state,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      })
  };
}

// CLI: pnpm --filter @sge/backlinks test-destination
if (import.meta.url === `file://${process.argv[1]}`) {
  const d = await startTestDestination({ port: Number(process.env.TEST_DESTINATION_PORT ?? 4010) });
  console.log(`SGE Test Directory listening on ${d.url}`);
}
