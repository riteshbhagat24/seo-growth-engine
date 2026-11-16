import { LinkButton } from "@/components/ui";
import { getSession } from "@/lib/session";

export default async function Home() {
  const productName = process.env.PRODUCT_NAME ?? "Futuready Media";
  const session = await getSession();
  return (
    <main className="mx-auto flex min-h-full w-full max-w-3xl flex-1 flex-col justify-center gap-6 px-4 py-24 sm:px-8">
      <p className="text-sm font-medium uppercase tracking-widest text-muted">{productName}</p>
      <h1 className="text-4xl font-semibold tracking-tight">SEO Growth Engine</h1>
      <p className="max-w-xl text-lg leading-8 text-muted">
        Technical audits, keyword tracking, white-hat backlink acquisition and verified reporting, for businesses and
        agencies.
      </p>
      <div className="flex gap-3">
        {session ? (
          <LinkButton href="/app">Open the app</LinkButton>
        ) : (
          <>
            <LinkButton href="/sign-up">Create a free account</LinkButton>
            <LinkButton href="/sign-in" variant="secondary">
              Sign in
            </LinkButton>
          </>
        )}
      </div>
    </main>
  );
}
