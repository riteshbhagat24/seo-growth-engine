import Link from "next/link";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  const product = process.env.PRODUCT_NAME ?? "Futuready Media";
  return (
    <main className="flex min-h-full flex-1 flex-col items-center justify-center px-4 py-16">
      <Link href="/" className="mb-8 text-sm font-semibold uppercase tracking-widest text-muted hover:text-foreground">
        {product}
      </Link>
      <div className="w-full max-w-sm rounded-xl border border-border bg-surface p-6 shadow-sm sm:p-8">{children}</div>
    </main>
  );
}
