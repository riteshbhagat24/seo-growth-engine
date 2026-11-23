/**
 * Egress proxy for the browser worker. Chromium is launched with this proxy for ALL traffic
 * (including loopback, via the "<-loopback>" bypass override), so every connection the browser makes —
 * page loads, sub-resources, XHR, form posts — passes the same SSRF policy as the crawler:
 * scheme/port checks, public-address validation, and DNS pinning (the proxy resolves once and connects
 * to the validated IP, defeating DNS rebinding).
 */
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { SafeFetchError, vetUrl } from "@sge/crawler";
import { PolicyBlockedError, type UrlPolicy } from "../net/policy";

/** Policy check + one DNS resolution; the connection is then pinned to the returned address. */
async function vet(policy: UrlPolicy, raw: string): Promise<{ target: URL; address: string; family: number }> {
  const target = policy.assertAllowed(raw);
  const v = await vetUrl(target.toString(), policy.fetchOverrides(target));
  return { target, address: v.address, family: v.family };
}

const reasonOf = (err: unknown) => (err instanceof PolicyBlockedError || err instanceof SafeFetchError ? err.code : (err as Error).message);

export interface EgressProxy {
  url: string;
  blocked: { target: string; reason: string }[];
  allowed: string[];
  close(): Promise<void>;
}

export async function startEgressProxy(policy: UrlPolicy): Promise<EgressProxy> {
  const blocked: EgressProxy["blocked"] = [];
  const allowed: string[] = [];

  const server = http.createServer(async (req, res) => {
    // Plain HTTP proxying (absolute-form request URI)
    try {
      const { target, ...pinned } = await vet(policy, req.url ?? "");
      allowed.push(target.toString());
      const headers = { ...req.headers };
      delete headers["proxy-connection"];
      delete headers["proxy-authorization"];
      const upstream = http.request(
        {
          host: target.hostname,
          port: target.port || 80,
          method: req.method,
          path: `${target.pathname}${target.search}`,
          headers,
          lookup: (_h: string, opts: any, cb: any) => {
            const callback = typeof opts === "function" ? opts : cb;
            if (opts && opts.all) callback(null, [{ address: pinned.address, family: pinned.family }]);
            else callback(null, pinned.address, pinned.family);
          },
          agent: false
        },
        (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
        }
      );
      upstream.on("error", () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      req.pipe(upstream);
    } catch (err) {
      blocked.push({ target: String(req.url), reason: reasonOf(err) });
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("Blocked by SEO Growth Engine egress policy");
    }
  });

  // HTTPS tunnelling
  server.on("connect", async (req, clientSocket: net.Socket, head) => {
    const [host, portStr] = String(req.url).split(/:(?=\d+$)/);
    const target = `https://${host}:${portStr || "443"}/`;
    try {
      const pinned = await vet(policy, target);
      allowed.push(target);
      const upstream = net.connect(Number(portStr || 443), pinned.address, () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head?.length) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.on("error", () => clientSocket.destroy());
      clientSocket.on("error", () => upstream.destroy());
    } catch (err) {
      blocked.push({ target, reason: reasonOf(err) });
      clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    blocked,
    allowed,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };
}
