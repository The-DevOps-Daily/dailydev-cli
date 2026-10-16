import { feedRequest, type Feed, type Post, type Query } from "./api.ts";
import { plural, postMeta, postTitle, shellQuote, wrap } from "./format.ts";
import { VERSION } from "./version.ts";

export type DigestFormat = "markdown" | "text" | "html";

export interface DigestPlan {
  feed: Feed;
  /** The heading and the start of the email subject. */
  label: string;
  limit: number;
  /** Search only: keep the posts that daily.dev added in the last `days` days. */
  days?: number;
  format: DigestFormat;
  email?: { to: string[]; from: string; dryRun: boolean };
}

export const SOURCES = "popular, discussed, tag <tag>, search <words>, feed or bookmarks";
const PACKAGE = "@devopsdaily/dailydev-cli";
const MAX_RECIPIENTS = 50;
const SUMMARY_LENGTH = 200;

// CR and LF would start a new mail header; no other control character belongs in one either.
const HEADER_UNSAFE = /[\u0000-\u001f\u007f-\u009f]/;
const ADDRESS = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;

type Opts = Record<string, unknown>;

const str = (value: unknown) => (typeof value === "string" ? value : undefined);

/** Reads the source, options and addresses of a digest, or says what is wrong with them. */
export function planDigest(opts: Opts, args: string[], env: Record<string, string | undefined>): { plan: DigestPlan } | { error: string } {
  const fail = (error: string) => ({ error });
  const [source = "popular", ...rest] = args;

  // Checked on the raw values, before any trimming: --schedule prints the command as it was typed.
  for (const [name, value] of Object.entries(opts)) {
    const values = Array.isArray(value) ? value : [value];
    if (values.some((v) => typeof v === "string" && HEADER_UNSAFE.test(v))) return fail(`--${name} cannot contain line breaks or other control characters.`);
  }
  if (args.some((a) => HEADER_UNSAFE.test(a))) return fail("Tags and search words cannot contain line breaks or other control characters, because they go into the email subject.");
  if (env.SMTPFAST_FROM && HEADER_UNSAFE.test(env.SMTPFAST_FROM)) return fail("SMTPFAST_FROM cannot contain line breaks or other control characters.");
  if (opts.schedule) {
    const typed = [...args, ...Object.values(opts).flat(), opts.email && opts.from === undefined ? env.SMTPFAST_FROM : undefined];
    // GitHub reads ${{ ... }} as an expression even inside a quoted shell argument.
    if (typed.some((v) => typeof v === "string" && v.includes("${{"))) return fail("--schedule cannot write ${{ into a GitHub Actions workflow, because GitHub reads it as an expression.");
  }

  if (opts.tags !== undefined && opts.tag !== undefined) return fail("Give --tags or --tag, not both.");
  const tagsOpt = str(opts.tags) ?? str(opts.tag);
  const tags = tagsOpt
    ?.split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  if (tagsOpt !== undefined && !tags?.length) return fail("--tags needs at least one tag, for example: --tags kubernetes,docker");
  if (tagsOpt !== undefined && source !== "popular" && source !== "discussed") return fail(`dailydev digest ${source} does not take --tags.`);
  if (opts.days !== undefined && source !== "search") return fail("--days is for dailydev digest search.");

  const noArgs = () => (rest.length ? `dailydev digest ${source} takes no more arguments.` : undefined);
  let feed: Feed;
  let label: string;
  let days: number | undefined;
  switch (source) {
    case "popular": {
      const problem = noArgs();
      if (problem) return fail(problem);
      feed = { kind: "popular", tags: tags?.join(",") };
      label = tags ? `Popular on daily.dev: ${tags.join(", ")}` : "Popular on daily.dev";
      break;
    }
    case "discussed": {
      const problem = noArgs();
      if (problem) return fail(problem);
      if (tags && tags.length > 1) return fail("dailydev digest discussed takes one tag.");
      feed = { kind: "discussed", period: "7", tag: tags?.[0] };
      label = tags ? `Most discussed on daily.dev this week: ${tags[0]}` : "Most discussed on daily.dev this week";
      break;
    }
    case "tag": {
      if (rest.length !== 1) return fail("dailydev digest tag needs one tag, for example: dailydev digest tag kubernetes");
      feed = { kind: "tag", tag: rest[0] };
      label = `Latest ${rest[0]} posts on daily.dev`;
      break;
    }
    case "search": {
      if (!rest.length) return fail("dailydev digest search needs words, for example: dailydev digest search terraform");
      days = opts.days === undefined ? 7 : Number(opts.days);
      if (!Number.isInteger(days) || days < 1 || days > 365) return fail("--days must be a whole number from 1 to 365.");
      const q = rest.join(" ");
      feed = { kind: "search", q, time: searchWindow(days) };
      label = `daily.dev search "${q}", last ${days === 1 ? "day" : `${days} days`}`;
      break;
    }
    case "feed": {
      const problem = noArgs();
      if (problem) return fail(problem);
      feed = { kind: "feed" };
      label = "Your daily.dev feed";
      break;
    }
    case "bookmarks": {
      const problem = noArgs();
      if (problem) return fail(problem);
      feed = { kind: "bookmarks" };
      label = "Your daily.dev bookmarks";
      break;
    }
    default:
      return fail(`Unknown digest source "${source}". Use ${SOURCES}.`);
  }
  // The label is the start of the email subject.
  if (HEADER_UNSAFE.test(label)) return fail("Tags and search words cannot contain line breaks or other control characters, because they go into the email subject.");

  const format = (str(opts.format) ?? "markdown") as DigestFormat;
  const limit = opts.limit === undefined ? 10 : Number(opts.limit);
  const plan: DigestPlan = { feed, label, limit, days, format };

  const emails = Array.isArray(opts.email) ? (opts.email as string[]) : typeof opts.email === "string" ? [opts.email] : undefined;
  if (!emails) {
    for (const name of ["from", "dry-run"]) {
      if (opts[name] !== undefined) return fail(`--${name} is only used with --email.`);
    }
    if (opts.format !== undefined && opts.json) return fail("Give --format or --json, not both.");
    return { plan };
  }

  if (opts.format !== undefined) return fail("--format is for printing. The email always has an HTML part and a text part.");
  const to: string[] = [];
  for (const address of emails.flatMap((e) => e.split(",")).map((e) => e.trim())) {
    if (!address) continue;
    if (HEADER_UNSAFE.test(address)) return fail("--email cannot contain line breaks or other control characters.");
    if (!ADDRESS.test(address)) return fail(`--email: "${address}" is not an email address.`);
    if (!to.some((a) => a.toLowerCase() === address.toLowerCase())) to.push(address);
  }
  if (!to.length) return fail("--email needs an address, for example: --email you@example.com");
  if (to.length > MAX_RECIPIENTS) return fail(`SMTPfast takes up to ${MAX_RECIPIENTS} recipients for one email.`);

  const fromName = opts.from !== undefined ? "--from" : "SMTPFAST_FROM";
  const from = (str(opts.from) ?? env.SMTPFAST_FROM ?? "").trim();
  if (!from) return fail("Give a From address with --from or SMTPFAST_FROM. It must be on a domain you verified in your SMTPfast account.");
  if (HEADER_UNSAFE.test(from)) return fail(`${fromName} cannot contain line breaks or other control characters.`);
  if (!fromAddress(from)) return fail(`${fromName}: "${from}" is not an email address. Use you@example.com or "Your Name <you@example.com>".`);

  plan.email = { to, from, dryRun: opts["dry-run"] === true };
  return { plan };
}

/** "you@example.com" or "Name <you@example.com>". SMTPfast checks the rest. */
function fromAddress(value: string): string | undefined {
  const named = value.match(/^([^<>]*)<([^<>]+)>$/);
  const address = (named ? named[2] : value).trim();
  return ADDRESS.test(address) ? address : undefined;
}

/** The smallest search window of the API that covers `days`. The posts are then filtered to the exact number of days. */
function searchWindow(days: number): string {
  if (days <= 1) return "day";
  if (days <= 7) return "week";
  if (days <= 30) return "month";
  return "year";
}

export function digestRequest(plan: DigestPlan): { path: string; query: Query } {
  const { path, query } = feedRequest(plan.feed);
  // A search is filtered by date after it arrives, so it asks for as many posts as the API gives.
  return { path, query: { ...query, limit: plan.days === undefined ? plan.limit : 50 } };
}

/** Search keeps the posts added in the last `days` days. The API's search window also counts from when daily.dev added a post. */
export function selectPosts(plan: DigestPlan, posts: Post[], now: number): Post[] {
  const kept = plan.days === undefined ? posts : posts.filter((p) => Date.parse(p.createdAt) >= now - plan.days! * 86_400_000);
  return kept.slice(0, plan.limit);
}

export interface Digest {
  label: string;
  subject: string;
  date: string;
  posts: Post[];
}

export function buildDigest(plan: DigestPlan, posts: Post[], now: number): Digest {
  const date = new Date(now).toISOString().slice(0, 10);
  return { label: plan.label, subject: `${plan.label} (${date})`, date, posts };
}

/** Only http and https links go into a digest. */
function link(post: Post): string | undefined {
  for (const candidate of [post.commentsPermalink, post.url]) {
    if (!candidate) continue;
    try {
      const url = new URL(candidate);
      if (url.protocol === "https:" || url.protocol === "http:") return url.href;
    } catch {
      // not a URL
    }
  }
  return undefined;
}

function shorten(text: string | null | undefined, max = SUMMARY_LENGTH): string {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s.,;:]+$/, "")}…`;
}

function intro(d: Digest): string {
  return `${d.date} · ${plural(d.posts.length, "post")}`;
}

export function renderText(d: Digest, now?: number): string {
  return `${d.subject}\n\n${renderTextList(d, now)}`;
}

/** The numbered posts of the text digest. */
export function renderTextList(d: Digest, now?: number): string {
  const pad = String(d.posts.length).length;
  const items = d.posts.map((post, i) => {
    const indent = " ".repeat(pad + 2);
    const lines = [`${String(i + 1).padStart(pad)}. ${postTitle(post)}`, `${indent}${postMeta(post, now)}`];
    const summary = shorten(post.summary);
    if (summary) lines.push(wrap(summary, 76, indent));
    const url = link(post);
    if (url) lines.push(`${indent}${url}`);
    return lines.join("\n");
  });
  return items.map((item) => `${item}\n`).join("\n");
}

// Backslash escapes keep API text from becoming links, raw HTML or formatting.
function md(text: string): string {
  return text.replace(/[\\`*_[\]<>#|~]/g, "\\$&").replace(/^([-+=]|\d+[.)])/, "\\$1");
}

function mdUrl(url: string): string {
  return url.replace(/[()]/g, (c) => (c === "(" ? "%28" : "%29"));
}

export function renderMarkdown(d: Digest, now?: number): string {
  const items = d.posts.map((post, i) => {
    const marker = `${i + 1}. `;
    const indent = " ".repeat(marker.length);
    const url = link(post);
    const title = url ? `**[${md(postTitle(post))}](${mdUrl(url)})**` : `**${md(postTitle(post))}**`;
    const lines = [title, md(postMeta(post, now))];
    const summary = shorten(post.summary);
    if (summary) lines.push(md(summary));
    // A backslash at the end of a line is a line break in CommonMark.
    return marker + lines.join(`\\\n${indent}`);
  });
  return [`# ${md(d.label)}`, "", intro(d), "", ...items.flatMap((item) => [item, ""])].join("\n");
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function renderHtml(d: Digest, now?: number): string {
  const items = d.posts.map((post, i) => {
    const url = link(post);
    const title = escapeHtml(postTitle(post));
    const heading = url ? `<a href="${escapeHtml(url)}" style="color:#0969da;text-decoration:none;">${title}</a>` : title;
    const summary = shorten(post.summary);
    return [
      '<div style="margin:0 0 20px;">',
      `<div style="font-size:16px;font-weight:600;line-height:1.4;">${i + 1}. ${heading}</div>`,
      `<div style="margin-top:4px;font-size:13px;color:#59636e;">${escapeHtml(postMeta(post, now))}</div>`,
      summary ? `<div style="margin-top:6px;font-size:14px;line-height:1.5;">${escapeHtml(summary)}</div>` : "",
      "</div>",
    ]
      .filter(Boolean)
      .join("\n");
  });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(d.subject)}</title>
</head>
<body style="margin:0;padding:24px 12px;background:#f4f5f7;color:#1f2328;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
<div style="max-width:600px;margin:0 auto;padding:24px;background:#ffffff;border:1px solid #e1e4e8;border-radius:8px;">
<h1 style="margin:0 0 4px;font-size:20px;line-height:1.3;">${escapeHtml(d.label)}</h1>
<p style="margin:0 0 20px;font-size:13px;color:#59636e;">${escapeHtml(intro(d))}</p>
${items.join("\n")}
</div>
</body>
</html>
`;
}

export function renderDigest(d: Digest, format: DigestFormat, now?: number): string {
  if (format === "html") return renderHtml(d, now);
  if (format === "text") return renderText(d, now);
  return renderMarkdown(d, now);
}

/** The same command without --schedule, --dry-run and --json (which is for the schedule itself), with the From address written out. */
export function scheduledArgs(argv: string[], plan: DigestPlan): string[] {
  const args = argv.filter((a) => a !== "--schedule" && a !== "--dry-run" && a !== "--json");
  const hasFrom = args.some((a) => a === "--from" || a.startsWith("--from="));
  if (plan.email && !hasFrom) args.push("--from", plan.email.from);
  return args;
}

export function scheduleText(argv: string[], plan: DigestPlan): { cron: string; workflow: string } {
  const command = scheduledArgs(argv, plan).map(shellQuote).join(" ");
  const secrets = plan.email ? ["DAILY_DEV_TOKEN", "SMTPFAST_API_KEY"] : ["DAILY_DEV_TOKEN"];
  // cron reads % as a line break, so it is escaped.
  const cron = `0 8 * * 1 dailydev ${command.replace(/%/g, "\\%")}`;
  const workflow = `name: daily.dev digest

on:
  schedule:
    - cron: "0 8 * * 1" # Mondays at 08:00 UTC
  workflow_dispatch:

permissions:
  contents: read

jobs:
  digest:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v5
        with:
          node-version: 24
      - name: ${plan.email ? "Send the digest" : "Build the digest"}
        env:
${secrets.map((s) => `          ${s}: \${{ secrets.${s} }}`).join("\n")}
        run: |
          npx --yes ${PACKAGE}@${VERSION} ${command}
`;
  return { cron, workflow };
}

export function formatSchedule(s: { cron: string; workflow: string }, plan: DigestPlan): string {
  const secrets = plan.email ? "DAILY_DEV_TOKEN and SMTPFAST_API_KEY" : "DAILY_DEV_TOKEN";
  return [
    `# cron, every Monday at 08:00. Set ${secrets} in the cron environment, and put dailydev on its PATH.`,
    s.cron,
    "",
    `# GitHub Actions: save as .github/workflows/dailydev-digest.yml and add the repository secrets ${secrets}.`,
    s.workflow,
  ].join("\n");
}
