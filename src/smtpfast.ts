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

/** `status` is SMTPfast's own, such as "queued"; null when it gave none. Accepted is not delivered yet. */
export type EmailResult = { to: string; accepted: true; status: string | null; id: string } | { to: string; accepted: false; status: string | null; id?: string; error: string };

export interface SendOptions {
  apiKey: string;
  message: EmailMessage;
  userAgent?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const UNSURE = "The emails may or may not have gone out. Check your SMTPfast dashboard before you send again.";

// Errors where the connection failed before the request went out: DNS, connect and TLS.
const NOT_SENT = /^(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|EHOSTDOWN|UND_ERR_CONNECT_TIMEOUT|ERR_TLS_\w+|CERT_\w+|\w+_CERT\w*|UNABLE_TO_\w+)$/;

/** Only an error code is shown, because a fetch error message can quote the request headers. */
function errorCode(err: unknown): string | undefined {
  const code = (err as { cause?: { code?: unknown } })?.cause?.code;
  return typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? code : undefined;
}

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
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") throw new ApiError(`SMTPfast did not answer within ${timeoutMs / 1000}s. ${UNSURE}`, 0);
    const code = errorCode(err);
    if (code && NOT_SENT.test(code)) throw new ApiError(`Could not reach SMTPfast (${code}). No email was sent.`, 0);
    // Any other error, such as a reset, can come after SMTPfast has the request.
    throw new ApiError(`The connection to SMTPfast failed (${code ?? "network error"}). ${UNSURE}`, 0);
  }
  try {
    text = await res.text();
  } catch (err) {
    // SMTPfast has answered, so it may have accepted the batch.
    const reason = err instanceof Error && err.name === "TimeoutError" ? `no full answer within ${timeoutMs / 1000}s` : (errorCode(err) ?? "network error");
    throw new ApiError(`The answer from SMTPfast was cut off (${reason}). ${UNSURE}`, res.status);
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
      const status = typeof item.status === "string" ? clean(redact(item.status)) : null;
      // The Resend shape has no status; an id there means the email was accepted.
      if (id && (status === null || status === "queued" || status === "scheduled")) return { to: address, accepted: true, status, id };
      // SMTPfast records the email but does not send it when its To address is suppressed.
      if (status === "failed") return { to: address, accepted: false, status, id, error: "SMTPfast did not send it, because the address is suppressed after an earlier bounce, complaint or unsubscribe." };
      return { to: address, accepted: false, status, id, error: `SMTPfast answered with status "${status ?? "none"}" and ${id ? `id ${id}` : "no id"}. It may or may not have gone out.` };
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
