/** Reads emails from the local Mailpit inbox (http://localhost:8025). */
const MAILPIT = process.env.MAILPIT_URL ?? "http://localhost:8025";

interface Summary {
  ID: string;
  Subject: string;
  Created: string;
}

/** Waits for the newest email to `to` whose subject matches, then returns its first link to the app. */
export async function linkFromEmail(to: string, subject: RegExp, timeoutMs = 20_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
    const { messages } = (await res.json()) as { messages: Summary[] };
    const hit = messages.find((m) => subject.test(m.Subject));
    if (hit) {
      const msg = (await (await fetch(`${MAILPIT}/api/v1/message/${hit.ID}`)).json()) as { Text: string };
      const url = msg.Text.match(/https?:\/\/\S+/)?.[0];
      if (!url) throw new Error(`No link in email "${hit.Subject}"`);
      return url;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`No email to ${to} matching ${subject} within ${timeoutMs}ms`);
}

export const uniqueEmail = (label: string) =>
  `e2e-${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}@example.test`;

/** Random strong password that won't appear in breach corpora. */
export const strongPassword = () => `Sg3-${crypto.randomUUID()}`;
