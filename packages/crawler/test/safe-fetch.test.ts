import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { safeFetch, SafeFetchError, vetUrl, type SafeFetchOptions } from "../src/safe-fetch";

let server: Server;
let port = 0;
const seenHosts: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    seenHosts.push(req.headers.host ?? "");
    const path = req.url ?? "/";
    if (path === "/ok") return res.writeHead(200, { "content-type": "text/html", "x-robots-tag": "noindex" }).end("<html><head><meta name='x' content='y'></head></html>");
    if (path === "/to-ok") return res.writeHead(302, { location: "/ok" }).end();
    if (path === "/to-metadata") return res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }).end();
    if (path === "/to-private-host") return res.writeHead(301, { location: "http://internal.test/" }).end();
    if (path === "/loop") return res.writeHead(302, { location: "/loop" }).end();
    if (path === "/big") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end("x".repeat(64 * 1024));
    }
    if (path === "/echo" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      return req.on("end", () =>
        res.writeHead(201, { "content-type": "application/json", "set-cookie": ["a=1; Path=/", "b=2; Path=/"], "retry-after": "7" })
          .end(JSON.stringify({ method: req.method, body, type: req.headers["content-type"] }))
      );
    }
    if (path === "/post-see-other" && req.method === "POST") return res.writeHead(303, { location: "/ok" }).end();
    if (path === "/png") return res.writeHead(200, { "content-type": "image/png" }).end("PNG");
    if (path === "/slow") return setTimeout(() => res.writeHead(200, { "content-type": "text/html" }).end("late"), 2_000);
    res.writeHead(404, { "content-type": "text/html" }).end("nope");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

/** Resolver for fake hostnames; never touches real DNS. */
const fakeDns: Record<string, string[]> = {
  "site.test": ["127.0.0.1"],
  "internal.test": ["10.0.0.5"],
  "rebind.test": ["93.184.216.34", "127.0.0.1"]
};
const resolver: SafeFetchOptions["resolver"] = async (h) => {
  const a = fakeDns[h];
  if (!a) throw new Error("ENOTFOUND");
  return a.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
};

/** Only the fixture server (127.0.0.1 on its random port) is reachable. */
const fixture: SafeFetchOptions = {
  resolver,
  unsafeTestOverrides: { allowAddress: (a) => a === "127.0.0.1", allowAnyPort: true }
};

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof SafeFetchError ? e.code : `unexpected:${(e as Error).message}`;
  }
}

describe("safeFetch: input validation (no overrides)", () => {
  it.each([
    ["http://localhost/", "dns_failed"], // fake resolver knows no localhost; real DNS would give 127.0.0.1 → blocked
    ["http://127.0.0.1/", "blocked_address"],
    ["http://0x7f000001/", "blocked_address"], // hex IPv4, normalised by URL parser
    ["http://2130706433/", "blocked_address"], // decimal IPv4
    ["http://[::1]/", "blocked_address"],
    ["http://[::ffff:127.0.0.1]/", "blocked_address"],
    ["http://169.254.169.254/latest/meta-data/", "blocked_address"],
    ["http://10.0.0.1/", "blocked_address"],
    ["http://internal.test/", "blocked_address"],
    ["http://rebind.test/", "blocked_address"], // mixed public/private answer
    ["ftp://example.com/", "blocked_scheme"],
    ["file:///etc/passwd", "blocked_scheme"],
    ["https://example.com:22/", "blocked_port"],
    ["https://user:pw@example.com/", "invalid_url"],
    ["not a url", "invalid_url"],
    ["https://does-not-exist.test/", "dns_failed"]
  ])("%s → %s", async (url, expected) => {
    expect(await code(safeFetch(url, { resolver }))).toBe(expected);
  });
});

describe("safeFetch: against a fixture server", () => {
  it("fetches through a pinned connection (hostname never hits real DNS)", async () => {
    const r = await safeFetch(`http://site.test:${port}/ok`, fixture);
    expect(r.status).toBe(200);
    expect(r.body).toContain("<meta");
    expect(seenHosts.at(-1)).toBe(`site.test:${port}`);
  });

  it("follows safe redirects and records them", async () => {
    const r = await safeFetch(`http://site.test:${port}/to-ok`, fixture);
    expect(r.url).toBe(`http://site.test:${port}/ok`);
    expect(r.redirects).toEqual([`http://site.test:${port}/ok`]);
    expect(r.redirectStatuses).toEqual([302]);
    expect(r.headers).toEqual({ "x-robots-tag": "noindex" });
  });

  it("re-validates every redirect hop", async () => {
    expect(await code(safeFetch(`http://site.test:${port}/to-metadata`, fixture))).toBe("blocked_address");
    expect(await code(safeFetch(`http://site.test:${port}/to-private-host`, fixture))).toBe("blocked_address");
  });

  it("stops redirect loops", async () => {
    expect(await code(safeFetch(`http://site.test:${port}/loop`, { ...fixture, maxRedirects: 3 }))).toBe("too_many_redirects");
  });

  it("enforces size, content type and time limits", async () => {
    expect(await code(safeFetch(`http://site.test:${port}/big`, { ...fixture, maxBytes: 10_000 }))).toBe("too_large");
    expect(await code(safeFetch(`http://site.test:${port}/png`, fixture))).toBe("bad_content_type");
    expect(await code(safeFetch(`http://site.test:${port}/slow`, { ...fixture, timeoutMs: 300 }))).toBe("timeout");
  });

  it("returns non-2xx responses rather than throwing", async () => {
    const r = await safeFetch(`http://site.test:${port}/missing`, fixture);
    expect(r.status).toBe(404);
  });
});

describe("safeFetch: submissions (POST) and headers", () => {
  it("posts a body and returns every response header", async () => {
    const r = await safeFetch(`http://site.test:${port}/echo`, {
      ...fixture,
      method: "POST",
      body: JSON.stringify({ a: 1 }),
      headers: { "content-type": "application/json" },
      contentTypes: ["application/json"]
    });
    expect(r.status).toBe(201);
    expect(JSON.parse(r.body)).toEqual({ method: "POST", body: '{"a":1}', type: "application/json" });
    expect(r.responseHeaders?.["set-cookie"]).toEqual(["a=1; Path=/", "b=2; Path=/"]);
    expect(r.responseHeaders?.["retry-after"]).toBe("7");
  });

  it("turns a POST into a GET after 303, still re-validating the hop", async () => {
    const r = await safeFetch(`http://site.test:${port}/post-see-other`, { ...fixture, method: "POST", body: "x=1" });
    expect(r.status).toBe(200);
    expect(r.redirects).toEqual([`http://site.test:${port}/ok`]);
  });

  it("can return redirects instead of following them", async () => {
    const r = await safeFetch(`http://site.test:${port}/to-metadata`, { ...fixture, followRedirects: false });
    expect(r.status).toBe(302);
    expect(r.responseHeaders?.location).toBe("http://169.254.169.254/latest/meta-data/");
  });

  it("vetUrl resolves once and refuses private answers (for the browser egress proxy)", async () => {
    const v = await vetUrl(`http://site.test:${port}/`, fixture);
    expect(v.address).toBe("127.0.0.1");
    expect(await code(vetUrl("http://internal.test/", { resolver }))).toBe("blocked_address");
    expect(await code(vetUrl("http://169.254.169.254/"))).toBe("blocked_address");
    expect(await code(vetUrl("gopher://site.test/"))).toBe("blocked_scheme");
  });
});
