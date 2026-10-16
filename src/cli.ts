import { parseArgs } from "node:util";
import { ApiError, BASE_URL, TOKEN_URL, createClient, feedRequest, type Client, type Comment, type Feed, type Page, type Post } from "./api.ts";
import { buildDigest, digestRequest, formatSchedule, planDigest, renderDigest, renderHtml, renderText, renderTextList, scheduleText, selectPosts, type DigestPlan } from "./digest.ts";
import { createStyle, formatComments, formatPost, formatPostList, plural, shellQuote, stripControls, type Style } from "./format.ts";
import { MISSING_KEY, sendEmail } from "./smtpfast.ts";
import { VERSION } from "./version.ts";

export interface Io {
  env: Record<string, string | undefined>;
  stdout: { write(s: string): unknown; isTTY?: boolean; columns?: number };
  stderr: { write(s: string): unknown };
  fetch?: typeof fetch;
  now?: number;
}

const HELP = `dailydev ${VERSION}: read daily.dev from your terminal

Usage: dailydev <command> [options]

Commands:
  feed                   Your For You feed
  popular                Popular posts           [--tag <tags>]
  discussed              Most discussed posts    [--period 7|30|365] [--tag <tag>]
  tag <tag>              Latest posts for a tag
  search <words>         Search posts            [--time day|week|month|year|all]
  post <id|url>          One post with its summary
  comments <id|url>      Comments on a post      [--sort oldest|newest]
  bookmarks              Your bookmarks          [--unread] [--search <words>]
  bookmark <id|url>...   Bookmark posts
  unbookmark <id|url>    Remove a bookmark
  tags <words>           Find tag names
  whoami                 Your profile and reading streak
  digest [source]        A digest to print or email; the source is popular (default),
                         discussed, tag <tag>, search <words>, feed or bookmarks

Options:
  -n, --limit <n>        How many results (default 10)
  --cursor <cursor>      Get the next page (the cursor is printed after a full page)
  --json                 Print the raw API response, for scripts and agents
  --no-color             Turn off colors (NO_COLOR also works)
  -h, --help             Show this help
  -v, --version          Show the version

Digest options:
  --tags <tags>          Tags for popular, or one tag for discussed
  --days <n>             For search: posts added in the last n days (default 7)
  --format <format>      markdown, text or html (default markdown)
  --email <address>      Send it with SMTPfast (needs SMTPFAST_API_KEY); repeat or comma separate
  --from <address>       The From address, on a domain verified in SMTPfast (or SMTPFAST_FROM)
  --dry-run              With --email: show the email and send nothing
  --schedule             Print a weekly cron line and a GitHub Actions workflow for the command

Set DAILY_DEV_TOKEN to a personal access token from ${TOKEN_URL}.
`;

const OPTIONS = {
  limit: { type: "string", short: "n" },
  cursor: { type: "string" },
  json: { type: "boolean" },
  color: { type: "boolean" },
  "no-color": { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  tag: { type: "string" },
  period: { type: "string" },
  time: { type: "string" },
  sort: { type: "string" },
  unread: { type: "boolean" },
  search: { type: "string" },
  tags: { type: "string" },
  days: { type: "string" },
  format: { type: "string" },
  email: { type: "string", multiple: true },
  from: { type: "string" },
  "dry-run": { type: "boolean" },
  schedule: { type: "boolean" },
} as const;

export async function run(argv: string[], io: Io): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    io.stderr.write(`${(err as Error).message}\nRun dailydev --help for usage.\n`);
    return 2;
  }
  const { values: opts, positionals } = parsed;
  const [command, ...args] = positionals;

  if (opts.version) {
    io.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (opts.help || !command || command === "help") {
    io.stdout.write(HELP);
    return command || opts.help ? 0 : 2;
  }

  if (!Object.hasOwn(COMMANDS, command)) {
    io.stderr.write(`Unknown command "${command}". Run dailydev --help for the list.\n`);
    return 2;
  }
  const { spec, handler } = COMMANDS[command];
  const problem = checkUsage(command, spec, opts, args) ?? spec.check?.(opts, args, io.env);
  if (problem) {
    io.stderr.write(`${problem}\nRun dailydev --help for usage.\n`);
    return 2;
  }

  const missing = spec.preflight?.(opts, io.env);
  if (missing) {
    io.stderr.write(`${missing}\n`);
    return 1;
  }

  const token = io.env.DAILY_DEV_TOKEN?.trim() ?? "";
  if (!token && !spec.tokenless?.(opts)) {
    io.stderr.write(`DAILY_DEV_TOKEN is not set. Create a token at ${TOKEN_URL}, then run:\n  export DAILY_DEV_TOKEN="dda_..."\n`);
    return 1;
  }

  const color = !opts["no-color"] && !io.env.NO_COLOR && (opts.color || Boolean(io.stdout.isTTY));
  const ctx: Context = {
    client: createClient({ token, baseUrl: io.env.DAILY_DEV_API_URL || BASE_URL, userAgent: `dailydev-cli/${VERSION}`, fetch: io.fetch }),
    opts,
    args,
    io,
    style: createStyle(color),
    width: Math.min(io.stdout.columns || 80, 100),
    command,
    argv,
  };

  try {
    await handler(ctx);
    return 0;
  } catch (err) {
    if (err instanceof ApiError) {
      io.stderr.write(`${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

interface Context {
  client: Client;
  opts: Record<string, string | boolean | string[] | undefined>;
  args: string[];
  io: Io;
  style: Style;
  width: number;
  command: string;
  argv: string[];
}

const GLOBAL_OPTIONS = new Set(["json", "color", "no-color", "help", "version"]);
const CHOICES: Record<string, string[]> = {
  period: ["7", "30", "365"],
  time: ["day", "week", "month", "year", "all"],
  sort: ["oldest", "newest"],
  format: ["markdown", "text", "html"],
};

interface Spec {
  /** Options the command takes, beyond --json and --no-color. */
  options?: string[];
  /** Names the positional arguments in error messages; "..." at the end means one or more. */
  args?: string;
  /** Lists take --limit and --cursor. */
  paged?: boolean;
  maxArgs?: number;
  /** Checks of its own, after the common ones. Returns the problem, if any. */
  check?: (opts: Record<string, unknown>, args: string[], env: Record<string, string | undefined>) => string | undefined;
  /** True when this run calls no API, so it needs no token. */
  tokenless?: (opts: Record<string, unknown>) => boolean;
  /** A setting this run is missing, checked before the token. Printed as it is, with exit code 1. */
  preflight?: (opts: Record<string, unknown>, env: Record<string, string | undefined>) => string | undefined;
}

export function checkUsage(command: string, spec: Spec, opts: Record<string, unknown>, args: string[]): string | undefined {
  const allowed = new Set([...(spec.options ?? []), ...(spec.paged ? ["limit", "cursor"] : [])]);
  for (const name of Object.keys(opts)) {
    if (opts[name] !== undefined && !GLOBAL_OPTIONS.has(name) && !allowed.has(name)) return `dailydev ${command} does not take --${name}.`;
  }

  const variadic = spec.args?.endsWith("...") ?? false;
  const wanted = spec.args ? 1 : 0;
  const max = spec.maxArgs ?? (variadic ? Infinity : wanted);
  if (args.length < wanted) return `dailydev ${command} needs ${spec.args?.replace("...", "")}, for example: dailydev ${command} ${EXAMPLES[command] ?? ""}`.trimEnd();
  if (args.length > max) {
    if (!wanted) return `dailydev ${command} takes no arguments.`;
    return variadic ? `dailydev ${command} takes up to ${max} posts at a time.` : `dailydev ${command} takes one ${spec.args}.`;
  }

  if (opts.limit !== undefined) {
    const n = Number(opts.limit);
    if (!Number.isInteger(n) || n < 1 || n > 50) return "--limit must be a whole number from 1 to 50.";
  }
  for (const [name, choices] of Object.entries(CHOICES)) {
    const value = opts[name];
    if (value !== undefined && !choices.includes(String(value))) return `--${name} must be one of: ${choices.join(", ")}.`;
  }
  return undefined;
}

const EXAMPLES: Record<string, string> = {
  tag: "kubernetes",
  search: "terraform state lock",
  post: "D2ornCubs",
  comments: "D2ornCubs",
  bookmark: "D2ornCubs",
  unbookmark: "D2ornCubs",
  tags: "kube",
};

function limit(ctx: Context): number {
  return ctx.opts.limit === undefined ? 10 : Number(ctx.opts.limit);
}

function opt(ctx: Context, name: string): string | undefined {
  const value = ctx.opts[name];
  return typeof value === "string" ? value : undefined;
}

/** Accepts a post id, a daily.dev post URL or the slug from one. The API resolves slugs to posts. */
export function postRef(input: string): string {
  const match = input.match(/daily\.dev\/posts\/([^/?#]+)/);
  return encodeURIComponent(match ? match[1] : input);
}

async function resolveId(ctx: Context, input: string): Promise<string> {
  const ref = postRef(input);
  if (!/[/.]/.test(input)) return ref;
  const res = await ctx.client.get<{ data: Post }>(`/posts/${ref}`);
  return res.data.id;
}

function print(ctx: Context, text: string) {
  ctx.io.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

function printJson(ctx: Context, value: unknown) {
  print(ctx, JSON.stringify(value, null, 2));
}

async function listPosts(ctx: Context, feed: Feed, empty: string) {
  const { path, query } = feedRequest(feed);
  const raw = await ctx.client.get<Page<Post>>(path, { limit: limit(ctx), cursor: opt(ctx, "cursor"), ...query });
  if (ctx.opts.json) return printJson(ctx, raw);
  const res = stripControls(raw);
  if (!res.data.length) return print(ctx, empty);
  print(ctx, formatPostList(res.data, ctx.style, ctx.io.now));
  printNextPage(ctx, res);
}

function printNextPage(ctx: Context, res: Page<unknown>) {
  if (res.pagination?.hasNextPage && res.pagination.cursor) {
    print(ctx, ctx.style.dim(`\nMore: ${nextPageCommand(ctx.argv, res.pagination.cursor)}`));
  }
}

/** The same command line with the new cursor, ready to copy. */
export function nextPageCommand(argv: string[], cursor: string): string {
  const kept: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--cursor") {
      i++;
      continue;
    }
    if (!argv[i].startsWith("--cursor=")) kept.push(argv[i]);
  }
  return ["dailydev", ...kept, "--cursor", cursor].map(shellQuote).join(" ");
}

const COMMANDS: Record<string, { spec: Spec; handler: (ctx: Context) => Promise<void> }> = {
  feed: { spec: { paged: true }, handler: (ctx) => listPosts(ctx, { kind: "feed" }, "Your feed is empty.") },

  popular: {
    spec: { paged: true, options: ["tag"] },
    handler: (ctx) => listPosts(ctx, { kind: "popular", tags: opt(ctx, "tag") }, "No popular posts found."),
  },

  discussed: {
    spec: { paged: true, options: ["period", "tag"] },
    handler: (ctx) => listPosts(ctx, { kind: "discussed", period: opt(ctx, "period"), tag: opt(ctx, "tag") }, "No discussed posts found."),
  },

  tag: {
    spec: { paged: true, args: "<tag>" },
    handler: (ctx) => {
      const tag = ctx.args[0];
      return listPosts(ctx, { kind: "tag", tag }, `No posts for #${tag}. Find tag names with: dailydev tags ${tag}`);
    },
  },

  search: {
    spec: { paged: true, options: ["time"], args: "<words>..." },
    handler: (ctx) => {
      const q = ctx.args.join(" ");
      return listPosts(ctx, { kind: "search", q, time: opt(ctx, "time") }, `No posts found for "${q}". Try fewer words: the search matches keywords, not sentences.`);
    },
  },

  post: {
    spec: { args: "<id|url>" },
    async handler(ctx) {
      const raw = await ctx.client.get<{ data: Post }>(`/posts/${postRef(ctx.args[0])}`);
      if (ctx.opts.json) return printJson(ctx, raw);
      const res = stripControls(raw);
      print(ctx, formatPost(res.data, ctx.style, ctx.width, ctx.io.now));
    },
  },

  comments: {
    spec: { paged: true, options: ["sort"], args: "<id|url>" },
    async handler(ctx) {
      const raw = await ctx.client.get<Page<Comment>>(`/posts/${postRef(ctx.args[0])}/comments`, {
        limit: limit(ctx),
        cursor: opt(ctx, "cursor"),
        sort: opt(ctx, "sort"),
      });
      if (ctx.opts.json) return printJson(ctx, raw);
      const res = stripControls(raw);
      if (!res.data.length) return print(ctx, "No comments yet.");
      print(ctx, formatComments(res.data, ctx.style, ctx.width, ctx.io.now));
      printNextPage(ctx, res);
    },
  },

  bookmarks: {
    spec: { paged: true, options: ["unread", "search"] },
    handler: (ctx) => {
      const search = opt(ctx, "search");
      return listPosts(ctx, { kind: "bookmarks", search, unread: ctx.opts.unread === true }, search ? `No bookmarks match "${search}".` : "You have no bookmarks.");
    },
  },

  bookmark: {
    // The API takes up to 100 posts in one call.
    spec: { args: "<id|url>...", maxArgs: 100 },
    async handler(ctx) {
      const postIds = [];
      for (const input of ctx.args) postIds.push(await resolveId(ctx, input));
      const res = await ctx.client.post<unknown>("/bookmarks/", { postIds });
      if (ctx.opts.json) return printJson(ctx, res);
      print(ctx, `Bookmarked ${plural(postIds.length, "post")}.`);
    },
  },

  unbookmark: {
    spec: { args: "<id|url>" },
    async handler(ctx) {
      const id = await resolveId(ctx, ctx.args[0]);
      // The API answers 204 with no body, so --json prints nothing.
      await ctx.client.delete<unknown>(`/bookmarks/${encodeURIComponent(id)}`);
      if (!ctx.opts.json) print(ctx, "Bookmark removed.");
    },
  },

  tags: {
    spec: { args: "<words>..." },
    async handler(ctx) {
      const q = ctx.args.join(" ");
      const raw = await ctx.client.get<{ data: { name: string }[] }>("/search/tags", { q });
      if (ctx.opts.json) return printJson(ctx, raw);
      const res = stripControls(raw);
      if (!res.data.length) return print(ctx, `No tags match "${q}".`);
      print(ctx, res.data.map((t) => t.name).join("\n"));
    },
  },

  whoami: {
    spec: {},
    async handler(ctx) {
      const raw = await ctx.client.get<Profile | { data: Profile }>("/profile/");
      if (ctx.opts.json) return printJson(ctx, raw);
      const res = stripControls(raw);
      const p: Profile = "data" in res ? res.data : res;
      const lines = [`${ctx.style.bold(p.name)} ${ctx.style.dim(`@${p.username}`)}`, `Reputation  ${p.reputation}`];
      if (p.streak) lines.push(`Streak      ${plural(p.streak.current, "day")} (longest ${p.streak.max})`);
      lines.push(ctx.style.accent(p.permalink));
      print(ctx, lines.join("\n"));
    },
  },

  digest: {
    spec: {
      options: ["limit", "tags", "tag", "days", "format", "email", "from", "dry-run", "schedule"],
      maxArgs: Infinity,
      check: (opts, args, env) => {
        const res = planDigest(opts, args, env);
        return "error" in res ? res.error : undefined;
      },
      tokenless: (opts) => opts.schedule === true,
      preflight: (opts, env) => {
        if (opts.email === undefined || opts["dry-run"] || opts.schedule) return undefined;
        const key = env.SMTPFAST_API_KEY?.trim();
        if (!key) return MISSING_KEY;
        // fetch refuses such a header with an error that can quote it, and a key never has these characters.
        if (!/^[\x21-\x7e]+$/.test(key)) return "SMTPFAST_API_KEY has characters that an API key cannot have. Copy it again from your SMTPfast dashboard.";
        return undefined;
      },
    },
    handler: digest,
  },
};

async function digest(ctx: Context) {
  const planned = planDigest(ctx.opts, ctx.args, ctx.io.env);
  if ("error" in planned) throw new Error(planned.error);
  const { plan } = planned;
  const now = ctx.io.now ?? Date.now();

  if (ctx.opts.schedule) {
    const schedule = scheduleText(ctx.argv, plan);
    return ctx.opts.json ? printJson(ctx, schedule) : print(ctx, formatSchedule(schedule, plan));
  }

  // The preflight check has made sure that a send has a usable key.
  const apiKey = ctx.io.env.SMTPFAST_API_KEY?.trim() ?? "";

  const { path, query } = digestRequest(plan);
  const raw = await ctx.client.get<Page<Post>>(path, query);
  const posts = selectPosts(plan, raw.data ?? [], now);
  const d = buildDigest(plan, stripControls(posts), now);
  const json = { subject: d.subject, posts };

  if (!plan.email) {
    if (ctx.opts.json) return printJson(ctx, json);
    if (!posts.length) return print(ctx, digestEmpty(plan));
    return print(ctx, renderDigest(d, plan.format, now));
  }

  const { from, to, dryRun } = plan.email;
  if (dryRun) {
    if (ctx.opts.json) return printJson(ctx, { dryRun: true, from, to, ...json });
    const head = ["Dry run: nothing was sent.", `From:    ${from}`, `To:      ${to.join(", ")}`, `Subject: ${d.subject}`].join("\n");
    return print(ctx, `${head}\n\n${posts.length ? renderTextList(d, now) : `${digestEmpty(plan)} A real run sends no email.`}`);
  }

  if (!posts.length) {
    if (ctx.opts.json) return printJson(ctx, { id: null, from, to, ...json });
    return print(ctx, `${digestEmpty(plan)} No email was sent.`);
  }
  const { id } = await sendEmail({
    apiKey,
    message: { from, to, subject: d.subject, html: renderHtml(d, now), text: renderText(d, now) },
    userAgent: `dailydev-cli/${VERSION}`,
    fetch: ctx.io.fetch,
  });
  if (ctx.opts.json) return printJson(ctx, { id, from, to, ...json });
  print(ctx, `Sent "${d.subject}" to ${to.join(", ")}. SMTPfast email id: ${id}`);
}

function digestEmpty(plan: DigestPlan): string {
  return plan.days === undefined ? "No posts found for this digest." : `No posts found in the last ${plural(plan.days, "day")}. Try fewer words or more --days.`;
}

interface Profile {
  name: string;
  username: string;
  reputation: number;
  permalink: string;
  streak?: { current: number; max: number };
}
