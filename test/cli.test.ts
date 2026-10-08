import { describe, expect, it } from "vitest";
import type { Post } from "../src/api.ts";
import { postRef, run } from "../src/cli.ts";
import { formatPostList, createStyle, timeAgo, wrap } from "../src/format.ts";

const NOW = Date.parse("2026-10-08T12:00:00Z");

const post = (over: Partial<Post> = {}): Post => ({
  id: "D2ornCubs",
  title: "A Missing Binary Turned a Kubernetes Liveness Probe Into a Restart Loop",
  url: "https://example.com/article",
  summary: "The probe used pgrep, which the slim image did not have.",
  type: "article",
  publishedAt: "2026-09-25T10:42:11.000Z",
  createdAt: "2026-09-25T11:39:15.045Z",
  commentsPermalink: "https://daily.dev/posts/a-missing-binary-d2orncubs",
  source: { id: "cloudnativenow", name: "Cloud Native Now" },
  tags: ["kubernetes"],
  readTime: 5,
  numUpvotes: 27,
  numComments: 2,
  ...over,
});

interface Call {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body?: unknown;
}

function harness(responses: Record<string, { status?: number; body?: unknown; headers?: Record<string, string> }> = {}) {
  const calls: Call[] = [];
  let out = "";
  let err = "";
  const fetchMock = (async (input: URL, init: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ method: init.method ?? "GET", url, headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const key = `${init.method} ${url.pathname}`;
    const r = responses[key] ?? { body: { data: [], pagination: { hasNextPage: false, cursor: null } } };
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status ?? 200, headers: r.headers });
  }) as unknown as typeof fetch;

  const exec = (argv: string[], env: Record<string, string | undefined> = { DAILY_DEV_TOKEN: "dda_test" }) =>
    run(argv, {
      env,
      fetch: fetchMock,
      now: NOW,
      stdout: { write: (s: string) => (out += s), isTTY: false, columns: 80 },
      stderr: { write: (s: string) => (err += s) },
    });

  return { calls, exec, out: () => out, err: () => err };
}

describe("requests", () => {
  it("sends the token and maps -n to limit", async () => {
    const h = harness();
    expect(await h.exec(["feed", "-n", "3"])).toBe(0);
    expect(h.calls[0].url.href).toBe("https://api.daily.dev/public/v1/feeds/foryou?limit=3");
    expect(h.calls[0].headers.Authorization).toBe("Bearer dda_test");
    expect(h.calls[0].headers["User-Agent"]).toMatch(/^dailydev-cli\//);
  });

  it("joins search words and passes --time", async () => {
    const h = harness();
    await h.exec(["search", "terraform", "state", "lock", "--time", "year"]);
    expect(h.calls[0].url.pathname).toBe("/public/v1/search/posts");
    expect(h.calls[0].url.searchParams.get("q")).toBe("terraform state lock");
    expect(h.calls[0].url.searchParams.get("time")).toBe("year");
  });

  it("maps --tag to the tags filter on popular and the tag filter on discussed", async () => {
    const h = harness();
    await h.exec(["popular", "--tag", "kubernetes,docker"]);
    await h.exec(["discussed", "--period", "30", "--tag", "rust"]);
    expect(h.calls[0].url.searchParams.get("tags")).toBe("kubernetes,docker");
    expect(h.calls[1].url.searchParams.get("period")).toBe("30");
    expect(h.calls[1].url.searchParams.get("tag")).toBe("rust");
  });

  it("uses bookmark search and the unread filter", async () => {
    const h = harness();
    await h.exec(["bookmarks", "--search", "postgres", "--unread"]);
    expect(h.calls[0].url.pathname).toBe("/public/v1/bookmarks/search");
    expect(h.calls[0].url.searchParams.get("q")).toBe("postgres");
    expect(h.calls[0].url.searchParams.get("unreadOnly")).toBe("true");
  });

  it("resolves a post URL to its id before bookmarking", async () => {
    const h = harness({ "GET /public/v1/posts/a-missing-binary-d2orncubs": { body: { data: post() } } });
    expect(await h.exec(["bookmark", "https://daily.dev/posts/a-missing-binary-d2orncubs", "Y4Q54mLwx"])).toBe(0);
    const postCall = h.calls.find((c) => c.method === "POST");
    expect(postCall?.body).toEqual({ postIds: ["D2ornCubs", "Y4Q54mLwx"] });
    expect(h.out()).toContain("Bookmarked 2 posts.");
  });

  it("removes a bookmark by id", async () => {
    const h = harness();
    await h.exec(["unbookmark", "D2ornCubs"]);
    expect(h.calls[0].method).toBe("DELETE");
    expect(h.calls[0].url.pathname).toBe("/public/v1/bookmarks/D2ornCubs");
  });
});

describe("output", () => {
  it("prints the raw response with --json", async () => {
    const body = { data: [post()], pagination: { hasNextPage: true, cursor: "abc" } };
    const h = harness({ "GET /public/v1/feeds/popular": { body } });
    await h.exec(["popular", "--json"]);
    expect(JSON.parse(h.out())).toEqual(body);
  });

  it("lists posts with meta, link and id, and a next-page hint", async () => {
    const h = harness({ "GET /public/v1/feeds/foryou": { body: { data: [post()], pagination: { hasNextPage: true, cursor: "abc" } } } });
    await h.exec(["feed"]);
    expect(h.out()).toContain("1. A Missing Binary");
    expect(h.out()).toContain("Cloud Native Now · 27 upvotes · 2 comments · 5 min read · 13d ago");
    expect(h.out()).toContain("id D2ornCubs");
    expect(h.out()).toContain("--cursor abc");
    expect(h.out()).not.toContain("\x1b[");
  });

  it("names shares, which have no title in the API", () => {
    const text = formatPostList([post({ title: "", type: "share", source: { id: "x", name: "DevOps Daily" }, author: { username: "someone" } })], createStyle(false), NOW);
    expect(text).toContain("Shared by @someone in DevOps Daily");
  });

  it("tells the user when a search finds nothing", async () => {
    const h = harness();
    await h.exec(["search", "another operation is in progress"]);
    expect(h.out()).toContain("Try fewer words");
  });
});

describe("errors", () => {
  it("explains a missing token without calling the API", async () => {
    const h = harness();
    expect(await h.exec(["feed"], {})).toBe(1);
    expect(h.err()).toContain("DAILY_DEV_TOKEN is not set");
    expect(h.calls).toHaveLength(0);
  });

  it("explains a rejected token", async () => {
    const h = harness({ "GET /public/v1/feeds/foryou": { status: 401, body: { error: "unauthorized" } } });
    expect(await h.exec(["feed"])).toBe(1);
    expect(h.err()).toContain("did not accept the token");
  });

  it("shows the rate limit reset", async () => {
    const h = harness({ "GET /public/v1/feeds/foryou": { status: 429, body: {}, headers: { "x-ratelimit-reset": "42" } } });
    expect(await h.exec(["feed"])).toBe(1);
    expect(h.err()).toContain("Try again in 42s");
  });

  it("rejects a bad --limit and unknown commands", async () => {
    const h = harness();
    expect(await h.exec(["feed", "-n", "500"])).toBe(2);
    expect(await h.exec(["nope"])).toBe(2);
    expect(h.calls).toHaveLength(0);
  });
});

describe("helpers", () => {
  it("takes the slug from a daily.dev URL", () => {
    expect(postRef("https://daily.dev/posts/a-missing-binary-d2orncubs?utm=x")).toBe("a-missing-binary-d2orncubs");
    expect(postRef("D2ornCubs")).toBe("D2ornCubs");
  });

  it("formats relative times", () => {
    expect(timeAgo("2026-10-08T11:59:30Z", NOW)).toBe("30s ago");
    expect(timeAgo("2026-10-08T09:00:00Z", NOW)).toBe("3h ago");
    expect(timeAgo("2026-06-08T12:00:00Z", NOW)).toBe("4mo ago");
    expect(timeAgo("2023-10-08T12:00:00Z", NOW)).toBe("3y ago");
  });

  it("wraps text to the width", () => {
    const lines = wrap("one two three four five six seven", 12, "  ").split("\n");
    expect(lines.every((l) => l.length <= 12)).toBe(true);
    expect(lines[0]).toBe("  one two");
  });
});

describe("version", () => {
  it("matches package.json", async () => {
    const { readFile } = await import("node:fs/promises");
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    const { VERSION } = await import("../src/version.ts");
    expect(VERSION).toBe(pkg.version);
  });
});

describe("hardening", () => {
  it("does not follow a redirect", async () => {
    const h = harness({ "GET /public/v1/feeds/foryou": { status: 302, headers: { location: "https://elsewhere.example/" } } });
    expect(await h.exec(["feed"])).toBe(1);
    expect(h.err()).toContain("does not follow redirects");
    expect(h.calls).toHaveLength(1);
  });

  it("rejects a success response that is not JSON", async () => {
    const fetchHtml = (async () => new Response("<html>proxy</html>", { status: 200 })) as unknown as typeof fetch;
    let err = "";
    const code = await run(["bookmark", "D2ornCubs"], {
      env: { DAILY_DEV_TOKEN: "dda_test" },
      fetch: fetchHtml,
      stdout: { write: () => true },
      stderr: { write: (s: string) => (err += s) },
    });
    expect(code).toBe(1);
    expect(err).toContain("not JSON");
  });

  it("does not treat inherited object keys as commands", async () => {
    const h = harness();
    expect(await h.exec(["toString"])).toBe(2);
    expect(await h.exec(["constructor"])).toBe(2);
  });

  it("checks usage before it asks for a token", async () => {
    const h = harness();
    expect(await h.exec(["nope"], {})).toBe(2);
    expect(await h.exec(["search"], {})).toBe(2);
    expect(await h.exec(["discussed", "--period", "9"], {})).toBe(2);
  });

  it("rejects options and arguments that a command does not use", async () => {
    const h = harness();
    expect(await h.exec(["feed", "--time", "week"])).toBe(2);
    expect(h.err()).toContain("does not take --time");
    expect(await h.exec(["post", "D2ornCubs", "-n", "3"])).toBe(2);
    expect(await h.exec(["unbookmark", "A", "B"])).toBe(2);
    expect(await h.exec(["whoami", "extra"])).toBe(2);
    expect(h.calls).toHaveLength(0);
  });

  it("prints nothing for unbookmark --json, because the API sends no body", async () => {
    const h = harness({ "DELETE /public/v1/bookmarks/D2ornCubs": { status: 204 } });
    expect(await h.exec(["unbookmark", "D2ornCubs", "--json"])).toBe(0);
    expect(h.out()).toBe("");
  });
});
