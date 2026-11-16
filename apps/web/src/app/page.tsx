const productName = process.env.PRODUCT_NAME ?? "Futuready Media";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-full w-full max-w-3xl flex-1 flex-col justify-center gap-6 px-4 py-24 sm:px-8">
      <p className="text-sm font-medium uppercase tracking-widest text-zinc-500">{productName}</p>
      <h1 className="text-4xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
        SEO Growth Engine
      </h1>
      <p className="max-w-xl text-lg leading-8 text-zinc-600 dark:text-zinc-400">
        Technical audits, keyword tracking, white-hat backlink acquisition and verified reporting, for
        businesses and agencies.
      </p>
      <p className="text-sm text-zinc-500">Milestone 0: foundations. Sign-up arrives in Milestone 1.</p>
    </main>
  );
}
