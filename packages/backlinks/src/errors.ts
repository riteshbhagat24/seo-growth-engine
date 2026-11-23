import { PolicyBlockedError } from "./net/policy";

/** Temporary failure: the job is retried with the queue's exponential backoff. */
export class RetryableError extends Error {
  constructor(
    message: string,
    readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = "RetryableError";
  }
}

/** Permanent failure: never retried; the job fails at once (mapped to @sge/jobs PermanentJobError). */
export class PermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentError";
  }
}

/** Not a failure: run again later without using up an attempt (rate limits, paused campaign, quota). */
export class DeferError extends Error {
  constructor(
    readonly seconds: number,
    message: string
  ) {
    super(message);
    this.name = "DeferError";
  }
}

/** The handler ran past its time slice. Retryable. */
export class JobTimeoutError extends RetryableError {
  constructor(seconds: number) {
    super(`Job exceeded its ${seconds}s time slice`);
    this.name = "JobTimeoutError";
  }
}

const RETRYABLE_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN", "EPIPE", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_SOCKET"]);

export function isRetryable(err: unknown): boolean {
  if (err instanceof PermanentError) return false;
  if (err instanceof RetryableError) return true;
  if (err instanceof PolicyBlockedError) return err.code === "timeout" || err.code === "dns_failure" || err.code === "network";
  const code = (err as { code?: string })?.code;
  if (code && RETRYABLE_CODES.has(code)) return true;
  // Programming and validation errors are permanent; unknown errors get the benefit of the doubt.
  if (err instanceof TypeError || err instanceof RangeError || err instanceof SyntaxError) return false;
  return true;
}
