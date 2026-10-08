export const BASE_URL = "https://api.daily.dev/public/v1";
export const TOKEN_URL = "https://daily.dev/settings/api";

export interface Source {
  id: string;
  name: string;
  handle?: string;
}

export interface Post {
  id: string;
  title: string;
  url: string | null;
  summary: string | null;
  type: string;
  publishedAt: string | null;
  createdAt: string;
  commentsPermalink: string;
  source: Source | null;
  author?: { username: string; name?: string } | null;
  tags: string[] | null;
  readTime: number | null;
  numUpvotes: number;
  numComments: number;
  bookmarked?: boolean;
}

export interface Comment {
  id: string;
  content: string;
  createdAt: string;
  permalink: string;
  numUpvotes: number;
  author: { username: string; name?: string } | null;
  children?: Comment[];
}

export interface Pagination {
  hasNextPage: boolean;
  cursor: string | null;
}

export interface Page<T> {
  data: T[];
  pagination?: Pagination;
}

export type Query = Record<string, string | number | boolean | undefined>;

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export interface ClientOptions {
  token: string;
  baseUrl?: string;
  userAgent?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export function createClient({ token, baseUrl = BASE_URL, userAgent = "dailydev-cli", fetch: fetchImpl = fetch, timeoutMs = 15_000 }: ClientOptions) {
  async function request<T>(method: string, path: string, query?: Query, body?: unknown): Promise<T> {
    const url = new URL(baseUrl.replace(/\/$/, "") + path);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== false && value !== "") url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "User-Agent": userAgent,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    let res: Response;
    let text: string;
    try {
      res = await fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        // A redirect would carry the token to another URL, so the CLI never follows one.
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await res.text();
    } catch (err) {
      const reason = err instanceof Error && err.name === "TimeoutError" ? `no answer after ${timeoutMs / 1000}s` : String((err as Error)?.message ?? err);
      throw new ApiError(`Could not reach daily.dev: ${reason}`, 0);
    }

    if (res.status >= 300 && res.status < 400) {
      throw new ApiError(`daily.dev answered with a redirect (${res.status}). The CLI does not follow redirects, so the token is not sent anywhere else.`, res.status);
    }

    let json: unknown = undefined;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        if (res.ok) throw new ApiError(`daily.dev answered ${res.status}, but the response is not JSON.`, res.status);
      }
    } else if (res.ok && res.status !== 204) {
      throw new ApiError(`daily.dev answered ${res.status} with an empty response.`, res.status);
    }

    if (!res.ok) throw toApiError(res, json);
    return json as T;
  }

  return {
    get: <T>(path: string, query?: Query) => request<T>("GET", path, query),
    post: <T>(path: string, body: unknown) => request<T>("POST", path, undefined, body),
    delete: <T>(path: string) => request<T>("DELETE", path),
  };
}

export type Client = ReturnType<typeof createClient>;

function toApiError(res: Response, json: unknown): ApiError {
  const rawMessage = typeof json === "object" && json !== null && "message" in json ? String((json as { message: unknown }).message) : "";
  // Error text from the server goes to the terminal too, so it keeps printable characters only.
  const apiMessage = rawMessage.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim().slice(0, 300);
  switch (res.status) {
    case 401:
      return new ApiError(`daily.dev did not accept the token. Create one at ${TOKEN_URL} and set DAILY_DEV_TOKEN.`, 401);
    case 404:
      return new ApiError("Not found. Post ids are case sensitive; you can paste the daily.dev URL of the post instead.", 404);
    case 429: {
      const reset = res.headers.get("x-ratelimit-reset");
      return new ApiError(`Rate limit reached.${reset ? ` Try again in ${reset}s.` : " Try again in a minute."}`, 429);
    }
    default:
      return new ApiError(apiMessage ? `daily.dev answered ${res.status}: ${apiMessage}` : `daily.dev answered ${res.status}.`, res.status);
  }
}
