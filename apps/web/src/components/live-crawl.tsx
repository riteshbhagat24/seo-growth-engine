"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

/**
 * Polls a progress endpoint while work runs and refreshes the page when the
 * response changes. Each poll also nudges background processing on
 * serverless hosts. Stops once `status` leaves `activeStatuses`.
 */
export function LiveCrawl({
  url,
  active,
  activeStatuses = ["queued", "running"]
}: {
  url: string;
  active: boolean;
  activeStatuses?: string[];
}) {
  const router = useRouter();
  const last = useRef<string>("");
  const statuses = activeStatuses.join(",");
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    const poll = async () => {
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { status: string };
        const sig = JSON.stringify(data);
        if (sig !== last.current) {
          last.current = sig;
          router.refresh();
        }
        if (!statuses.split(",").includes(data.status)) stopped = true;
      } catch {
        // transient network error: try again next tick
      }
    };
    const id = setInterval(() => !stopped && poll(), 4_000);
    void poll();
    return () => clearInterval(id);
  }, [url, active, router, statuses]);
  return null;
}
