/**
 * Registry of implemented adapters. Manifests live in code (like the audit rule catalogue, ADR-002): the UI reads
 * them from here, so what is shown as supported is exactly what is deployed, with how it was tested.
 */
import { listingApiAdapter, wordpressDraftAdapter } from "./api-adapters";
import { browserFormAdapter } from "./browser-form";
import { httpFormAdapter } from "./http-form";
import { manualAdapter, outreachAdapter } from "./manual-outreach";
import type { Adapter } from "./types";

export const ADAPTERS: Record<string, Adapter> = Object.fromEntries(
  [listingApiAdapter, wordpressDraftAdapter, httpFormAdapter, browserFormAdapter, manualAdapter, outreachAdapter].map((a) => [a.manifest.key, a])
);

export function getAdapter(key: string): Adapter {
  const a = ADAPTERS[key];
  if (!a) throw new Error(`Adapter "${key}" is not implemented`);
  return a;
}

/** A destination counts as "supported for automation" only with an implemented + tested automated adapter. */
export function isAutomationSupported(key: string): boolean {
  const a = ADAPTERS[key];
  return (
    !!a &&
    a.manifest.implementationStatus === "implemented" &&
    a.manifest.testStatus !== "untested" &&
    !["manual_editorial"].includes(a.manifest.type)
  );
}

export function adapterManifests() {
  return Object.values(ADAPTERS).map((a) => a.manifest);
}
