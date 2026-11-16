import "server-only";
import nodemailer, { type Transporter } from "nodemailer";
import { serverEnv } from "@sge/config";

let transport: Transporter | undefined;

function getTransport(): Transporter {
  if (transport) return transport;
  const env = serverEnv();
  if (!env.SMTP_HOST) throw new Error("SMTP_HOST is not configured");
  transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined
  });
  return transport;
}

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * A plain, single-button transactional email. All inputs are escaped.
 * Returns whether it was actually delivered to an SMTP server; in the demo
 * "log" transport it is not, and the link goes to the server log instead.
 */
export async function sendActionEmail(opts: {
  to: string;
  subject: string;
  intro: string;
  actionLabel: string;
  actionUrl: string;
  outro?: string;
}): Promise<{ delivered: boolean }> {
  const env = serverEnv();
  if (env.MAIL_TRANSPORT === "log") {
    console.warn(
      JSON.stringify({ level: "warn", message: "[mail:log] DEMO MODE: email not sent", to: opts.to, subject: opts.subject, link: opts.actionUrl })
    );
    return { delivered: false };
  }
  const product = env.PRODUCT_NAME;
  const text = [opts.intro, "", `${opts.actionLabel}: ${opts.actionUrl}`, "", opts.outro ?? "", "", `— ${product}`].join("\n");
  const html = `<!doctype html><html><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#17171f;line-height:1.5;max-width:520px;margin:0 auto;padding:24px">
<p style="font-size:13px;color:#555;text-transform:uppercase;letter-spacing:.08em;margin:0 0 16px">${escape(product)}</p>
<p>${escape(opts.intro)}</p>
<p style="margin:28px 0"><a href="${escape(opts.actionUrl)}" style="background:#1f4e79;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;display:inline-block">${escape(opts.actionLabel)}</a></p>
<p style="font-size:13px;color:#555">Or paste this link into your browser:<br><span style="word-break:break-all">${escape(opts.actionUrl)}</span></p>
${opts.outro ? `<p style="font-size:13px;color:#555">${escape(opts.outro)}</p>` : ""}
</body></html>`;
  await getTransport().sendMail({ from: env.MAIL_FROM, to: opts.to, subject: opts.subject, text, html });
  return { delivered: true };
}
