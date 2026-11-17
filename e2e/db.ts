import pg from "pg";

/**
 * Test-only database access as the local Postgres superuser (bypasses RLS) to
 * seed data that would otherwise come from Google. Never used by the app.
 */
const url = process.env.E2E_SUPERUSER_URL ?? "postgres://postgres:postgres@localhost:54329/sge";

export async function withSuperuser<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Seeds 60 days of Search Console and GA4 data for a website. */
export async function seedGoogleData(websiteId: string) {
  await withSuperuser(async (c) => {
    const { rows } = await c.query<{ organization_id: string }>("SELECT organization_id FROM websites WHERE id = $1", [websiteId]);
    const org = rows[0]!.organization_id;
    await c.query(
      `INSERT INTO website_google (website_id, organization_id, gsc_property, gsc_synced_from, gsc_synced_through, ga4_property, ga4_property_name, ga4_synced_from, ga4_synced_through)
       VALUES ($1, $2, 'sc-domain:seeded.example', current_date - 63, current_date - 3, 'properties/1', 'Seeded GA4', current_date - 61, current_date - 1)
       ON CONFLICT (website_id) DO NOTHING`,
      [websiteId, org]
    );
    for (let i = 3; i < 63; i++) {
      const d = iso(new Date(Date.now() - i * 86_400_000));
      const clicks = 40 + (i % 7) * 3;
      await c.query("INSERT INTO gsc_site_daily VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING", [org, websiteId, d, clicks, clicks * 12, 6.5 + (i % 5) / 10]);
      await c.query(
        `INSERT INTO gsc_daily VALUES ($1, $2, $3, 'seed keyword', 'https://seeded.example/a', $4, $5, 3.2), ($1, $2, $3, 'other query', 'https://seeded.example/b', 5, 90, 11.4)
         ON CONFLICT DO NOTHING`,
        [org, websiteId, d, clicks - 5, clicks * 8]
      );
      await c.query("INSERT INTO gsc_dim_daily VALUES ($1, $2, $3, 'device', 'mobile', $4, $5, 6) ON CONFLICT DO NOTHING", [org, websiteId, d, clicks, clicks * 12]);
    }
    for (let i = 1; i < 61; i++) {
      const d = iso(new Date(Date.now() - i * 86_400_000));
      await c.query(
        `INSERT INTO ga4_daily VALUES ($1, $2, $3, 'google', 'organic', '/a', '(not set)', 30, 20, 2), ($1, $2, $3, 'partner.example', 'referral', '/b', '(not set)', 6, 4, 0)
         ON CONFLICT DO NOTHING`,
        [org, websiteId, d]
      );
    }
  });
}
