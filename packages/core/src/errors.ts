export type ErrorCode =
  | "not_found"
  | "forbidden"
  | "invalid_input"
  | "conflict"
  | "email_not_verified"
  | "invitation_invalid"
  | "invitation_expired"
  | "email_mismatch"
  | "last_owner";

const STATUS: Record<ErrorCode, number> = {
  not_found: 404,
  forbidden: 403,
  invalid_input: 400,
  conflict: 409,
  email_not_verified: 403,
  invitation_invalid: 404,
  invitation_expired: 410,
  email_mismatch: 403,
  last_owner: 409
};

/** Expected, user-facing failure. Message is safe to show; anything else is a bug. */
export class AppError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string
  ) {
    super(message);
    this.name = "AppError";
    this.status = STATUS[code];
  }
}

export const isAppError = (e: unknown): e is AppError => e instanceof AppError;

/** Postgres unique_violation, unwrapping Drizzle's error wrapper. */
export function isUniqueViolation(e: unknown, constraint?: string): boolean {
  const err = e as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
  const pg = err?.cause ?? err;
  return pg?.code === "23505" && (constraint === undefined || pg.constraint === constraint);
}
