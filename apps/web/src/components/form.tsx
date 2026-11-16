"use client";

import { useActionState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { Alert, Button } from "./ui";

export type ActionResult = { error?: string; ok?: string } | null;
export type FormAction = (prev: ActionResult, data: FormData) => Promise<ActionResult>;

export function SubmitButton({
  children,
  pending,
  variant = "primary",
  className
}: {
  children: ReactNode;
  pending?: string;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  className?: string;
}) {
  const { pending: isPending } = useFormStatus();
  return (
    <Button type="submit" variant={variant} disabled={isPending} className={className}>
      {isPending ? (pending ?? "Working…") : children}
    </Button>
  );
}

/** A form bound to a server action, showing its error/success message. */
export function ActionForm({
  action,
  children,
  className,
  confirm
}: {
  action: FormAction;
  children: ReactNode;
  className?: string;
  confirm?: string;
}) {
  const [state, formAction] = useActionState(action, null);
  return (
    <form
      action={formAction}
      className={className}
      onSubmit={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      {children}
      {state?.error && (
        <div className="mt-3">
          <Alert tone="error">{state.error}</Alert>
        </div>
      )}
      {state?.ok && (
        <div className="mt-3">
          <Alert tone="success">{state.ok}</Alert>
        </div>
      )}
    </form>
  );
}
