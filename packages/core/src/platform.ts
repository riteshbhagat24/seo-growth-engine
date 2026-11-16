import { eq, schema, withContext, type Db } from "@sge/db";

export interface ProductSettings {
  name: string;
  logoUrl: string | null;
  primary: string;
  accent: string;
}

const DEFAULTS: ProductSettings = { name: "Futuready Media", logoUrl: null, primary: "#1f4e79", accent: "#e8833a" };

/** Global product branding (platform_settings 'product'), with safe defaults. */
export async function getProductSettings(db: Db): Promise<ProductSettings> {
  const [row] = await withContext(db, {}, (tx) =>
    tx.select().from(schema.platformSettings).where(eq(schema.platformSettings.key, "product"))
  );
  const v = (row?.value ?? {}) as Partial<ProductSettings>;
  return {
    name: typeof v.name === "string" && v.name ? v.name : DEFAULTS.name,
    logoUrl: typeof v.logoUrl === "string" ? v.logoUrl : null,
    primary: typeof v.primary === "string" && /^#[0-9a-f]{6}$/i.test(v.primary) ? v.primary : DEFAULTS.primary,
    accent: typeof v.accent === "string" && /^#[0-9a-f]{6}$/i.test(v.accent) ? v.accent : DEFAULTS.accent
  };
}
