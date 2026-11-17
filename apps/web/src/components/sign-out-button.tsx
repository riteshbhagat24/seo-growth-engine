"use client";

import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";

export function SignOutButton({ className, children }: { className?: string; children?: ReactNode }) {
  const router = useRouter();
  return (
    <button
      type="button"
      className={className}
      aria-label="Sign out"
      title="Sign out"
      onClick={async () => {
        await authClient.signOut();
        router.push("/sign-in");
        router.refresh();
      }}
    >
      {children ?? "Sign out"}
    </button>
  );
}
