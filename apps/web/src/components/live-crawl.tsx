"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

/**
 * Polls crawl progress while it runs and refreshes the page when it changes.
 * Each poll also nudges background processing on serverless hosts.
 */
export function LiveCrawl({ url, active }: { url: string; active: boolean }) {
  const router = useRouter();
  const last = useRef<string>("");
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    const poll = async () => {
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { status: string; pagesFetched: number };
        const sig = `${data.status}:${data.pagesFetched}`;
        if (sig !== last.current) {
          last.current = sig;
          router.refresh();
        }
        if (data.status !== "queued" && data.status !== "running") stopped = true;
      } catch {
        // transient network error: try again next tick
      }
    };
    const id = setInterval(() => !stopped && poll(), 4_000);
    void poll();
    return () => clearInterval(id);
  }, [url, active, router]);
  return null;
}
