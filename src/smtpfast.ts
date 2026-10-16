import { ApiError } from "./api.ts";

// Fixed on purpose: the key goes to SMTPfast and nowhere else. Tests replace fetch, not the URL.
export const SMTPFAST_EMAILS_URL = "https://smtpfa.st/api/v1/emails";
export const SMTPFAST_SIGNUP_URL = "https://smtpfa.st";
export const MISSING_KEY = `Set SMTPFAST_API_KEY to send the digest by email. Get a free key at ${SMTPFAST_SIGNUP_URL}.`;

export interface EmailMessage {
  from: string;
  to: string[];
  subject: string;
  html: string;
  text: string;
}

export interface SendOptions {
  apiKey: string;
  message: EmailMessage;
  userAgent?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const UNSURE = "The email may or may not have gone out. Check your SMTPfast dashboard before you send again.";

/** One POST to SMTPfast. Nothing is retried, so one run never sends twice. */
export async function sendEmail({ apiKey, message, userAgent = "dailydev-cli", fetch: fetchImpl = fetch, timeoutMs = 30_000 }: SendOptions): Promise<{ id: string }> {
  // In case a response ever quotes the key back.
  const redact = (s: string) => (apiKey ? s.split(apiKey).join("[key]") : s);
  let res: Response;
  let text: string;
  try {
    res = await fetchImpl(SMTPFAST_EMAILS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": userAgent,
      },
      body: JSON.stringify(message),
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

  if (res.ok) {
    const id = typeof json === "object" && json !== null ? (json as { id?: unknown }).id : undefined;
    if (typeof id === "string" && id) return { id: clean(redact(id)) };
    throw new ApiError(`SMTPfast answered ${res.status} without an email id. ${UNSURE}`, res.status);
  }

  const raw = typeof json === "object" && json !== null ? (json as { error?: unknown }).error : undefined;
  const detail = typeof raw === "string" ? clean(redact(raw)) : "";
  const what = res.status >= 500 ? `SMTPfast answered ${res.status}` : `SMTPfast refused the email (${res.status})`;
  const parts = [detail ? `${what}: ${detail}` : `${what}.`];
  if (res.status === 401) parts.push("Check SMTPFAST_API_KEY.");
  if ((res.status === 403 && /domain/i.test(detail)) || (res.status === 400 && /from address/i.test(detail))) {
    parts.push("The From address must be on a domain you verified in your SMTPfast account.");
  }
  if (res.status >= 500) parts.push(UNSURE);
  throw new ApiError(parts.join(" "), res.status);
}

/** Server text goes to the terminal, so it keeps printable characters only. */
function clean(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, " ").trim().slice(0, 300);
}
