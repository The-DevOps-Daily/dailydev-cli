import { ApiError } from "./api.ts";

// Fixed on purpose: the key goes to SMTPfast and nowhere else. Tests replace fetch, not the URL.
export const SMTPFAST_BATCH_URL = "https://smtpfa.st/api/v1/emails/batch";
export const SMTPFAST_SIGNUP_URL = "https://smtpfa.st";
export const MISSING_KEY = `Set SMTPFAST_API_KEY to send the digest by email. Get a free key at ${SMTPFAST_SIGNUP_URL}.`;
/** The most emails SMTPfast takes in one batch call. */
export const MAX_BATCH = 100;

export interface EmailMessage {
  from: string;
  to: string[];
  subject: string;
  html: string;
  text: string;
}

export type EmailResult = { to: string; sent: true; id: string } | { to: string; sent: false; id?: string; error: string };

export interface SendOptions {
  apiKey: string;
  message: EmailMessage;
  userAgent?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const UNSURE = "The emails may or may not have gone out. Check your SMTPfast dashboard before you send again.";

/**
 * One email per recipient, so nobody sees the other addresses, in one POST to SMTPfast's batch
 * endpoint. SMTPfast accepts or refuses the batch as a whole. Nothing is retried, so one run never
 * sends twice.
 */
export async function sendEach({ apiKey, message, userAgent = "dailydev-cli", fetch: fetchImpl = fetch, timeoutMs = 30_000 }: SendOptions): Promise<EmailResult[]> {
  // In case a response ever quotes the key back.
  const redact = (s: string) => (apiKey ? s.split(apiKey).join("[key]") : s);
  const { to, ...shared } = message;
  let res: Response;
  let text: string;
  try {
    res = await fetchImpl(SMTPFAST_BATCH_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": userAgent,
      },
      body: JSON.stringify(to.map((address) => ({ from: shared.from, to: [address], subject: shared.subject, html: shared.html, text: shared.text }))),
      // A redirect would carry the key to another URL, so the CLI never follows one.
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await res.text();
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") throw new ApiError(`SMTPfast did not answer within ${timeoutMs / 1000}s. ${UNSURE}`, 0);
    // A fetch error message can quote the request headers, so only an error code is shown.
    const code = (err as { cause?: { code?: unknown } })?.cause?.code;
    throw new ApiError(`Could not reach SMTPfast (${typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? code : "network error"}).`, 0);
  }

  if (res.status >= 300 && res.status < 400) {
    throw new ApiError(`SMTPfast answered with a redirect (${res.status}). The CLI does not follow redirects, so the key is not sent anywhere else.`, res.status);
  }

  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  const field = (name: string) => (typeof json === "object" && json !== null ? (json as Record<string, unknown>)[name] : undefined);

  if (res.ok) {
    // `emails` has an id and a status for each item, in request order. `data` is the Resend shape, ids only.
    const list = field("emails") ?? field("data");
    if (!Array.isArray(list) || list.length !== to.length) throw new ApiError(`SMTPfast answered ${res.status} without a result for each email. ${UNSURE}`, res.status);
    return to.map((address, i): EmailResult => {
      const item = (list[i] ?? {}) as { id?: unknown; status?: unknown };
      const id = typeof item.id === "string" && item.id ? clean(redact(item.id)) : undefined;
      const status = item.status === undefined ? "queued" : String(item.status);
      if (id && (status === "queued" || status === "scheduled")) return { to: address, sent: true, id };
      // SMTPfast records the email but does not send it when its To address is suppressed.
      if (status === "failed") return { to: address, sent: false, id, error: "SMTPfast did not send it, because the address is suppressed after an earlier bounce, complaint or unsubscribe." };
      return { to: address, sent: false, id, error: `SMTPfast answered with status "${clean(redact(status))}" and ${id ? `id ${id}` : "no id"}. It may or may not have gone out.` };
    });
  }

  const raw = field("error");
  const detail = typeof raw === "string" ? clean(redact(raw)) : "";
  const what = res.status >= 500 ? `SMTPfast answered ${res.status}` : `SMTPfast refused the emails (${res.status})`;
  const parts = [detail ? `${what}: ${/[.!?]$/.test(detail) ? detail : `${detail}.`}` : `${what}.`];
  if (res.status === 401) parts.push("Check SMTPFAST_API_KEY.");
  if ((res.status === 403 && /domain/i.test(detail)) || (res.status === 400 && /from address/i.test(detail))) {
    parts.push("The From address must be on a domain you verified in your SMTPfast account.");
  }
  // SMTPfast writes a batch in one transaction, so a refusal queues nothing.
  parts.push(res.status >= 500 ? UNSURE : "No email was sent.");
  throw new ApiError(parts.join(" "), res.status);
}

/** Server text goes to the terminal, so it keeps printable characters only. */
function clean(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, " ").trim().slice(0, 300);
}
