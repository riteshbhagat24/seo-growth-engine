import { TabNav } from "@/components/tab-nav";

export default async function BacklinksLayout({ children, params }: LayoutProps<"/w/[slug]/websites/[websiteId]/backlinks">) {
  const { slug, websiteId } = await params;
  const base = `/w/${slug}/websites/${websiteId}/backlinks`;
  return (
    <div>
      <div className="mb-5 border-b border-border">
        <TabNav
          label="Backlinks sections"
          items={[
            { href: base, label: "Campaigns", exact: true },
            { href: `${base}/approvals`, label: "Approvals" },
            { href: `${base}/tasks`, label: "Tasks" },
            { href: `${base}/outreach`, label: "Outreach" },
            { href: `${base}/profile`, label: "Business profile" },
            { href: `${base}/settings`, label: "Automation & destinations" }
          ]}
        />
      </div>
      {children}
    </div>
  );
}
