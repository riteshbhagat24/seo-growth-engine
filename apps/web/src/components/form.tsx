"use client";

import { useActionState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { Alert, Button, cx } from "./ui";

export type ActionResult = { error?: string; ok?: string } | null;
export type FormAction = (prev: ActionResult, data: FormData) => Promise<ActionResult>;

export function SubmitButton({
  children,
  pending,
  variant = "primary",
  className,
  size = "md"
}: {
  children: ReactNode;
  pending?: string;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  className?: string;
  size?: "md" | "sm";
}) {
  const { pending: isPending } = useFormStatus();
  return (
    <Button type="submit" variant={variant} disabled={isPending} className={cx(size === "sm" && "h-7 px-2.5 text-xs", className)}>
      {isPending ? (pending ?? "Working…") : children}
    </Button>
  );
}

/** A form bound to a server action, showing its error/success message. */
export function ActionForm({
  action,
  children,
  className,
  confirm,
  compact = false
}: {
  action: FormAction;
  children: ReactNode;
  className?: string;
  confirm?: string;
  /** Inline, small status text (for buttons inside table rows). */
  compact?: boolean;
}) {
  const [state, formAction] = useActionState(action, null);
  if (compact)
    return (
      <form action={formAction} className={className}>
        {state?.ok ? (
          <span className="text-xs font-medium text-success" role="status">
            ✓ {state.ok}
          </span>
        ) : (
          children
        )}
        {state?.error && (
          <span className="ml-2 text-xs text-danger" role="alert">
            {state.error}
          </span>
        )}
      </form>
    );
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
