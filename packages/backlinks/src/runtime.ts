import { Fetcher, type FetcherOptions } from "./net/fetcher";

/** One-to-one outreach transport: the workspace's own mailbox. */
export interface MailTransport {
  sendMail(message: { from: string; to: string; subject: string; text: string; headers: Record<string, string> }): Promise<{ messageId?: string }>;
}

export interface BacklinkRuntimeOptions {
  fetcher?: FetcherOptions;
  /** Run browser-form submissions here (needs Playwright's Chromium: the worker, not serverless). Default false. */
  browser?: boolean;
  /**
   * The workspace's own mailbox. There are no per-workspace mailboxes yet (M8), so in the app this is unset and
   * outreach ends in a "send it from your mailbox" task. The platform's system SMTP is never used for outreach.
   */
  mail?: MailTransport | null;
  /** Key for destination credentials (defaults to ENCRYPTION_KEY). */
  encryptionKey?: Buffer;
}

export interface Runtime {
  fetcher: Fetcher;
  browser: boolean;
  mail: MailTransport | null;
  encryptionKey?: Buffer;
}

export function createRuntime(o: BacklinkRuntimeOptions = {}): Runtime {
  return { fetcher: new Fetcher(o.fetcher), browser: o.browser ?? false, mail: o.mail ?? null, encryptionKey: o.encryptionKey };
}
