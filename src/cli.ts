import { parseArgs } from "node:util";
import { ApiError, BASE_URL, TOKEN_URL, createClient, type Client, type Comment, type Page, type Post } from "./api.ts";
import { createStyle, formatComments, formatPost, formatPostList, plural, stripControls, type Style } from "./format.ts";
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

Options:
  -n, --limit <n>        How many results (default 10)
  --cursor <cursor>      Get the next page (the cursor is printed after a full page)
  --json                 Print the raw API response, for scripts and agents
  --no-color             Turn off colors (NO_COLOR also works)
  -h, --help             Show this help
  -v, --version          Show the version

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
  const problem = checkUsage(command, spec, opts, args);
  if (problem) {
    io.stderr.write(`${problem}\nRun dailydev --help for usage.\n`);
    return 2;
  }

  const token = io.env.DAILY_DEV_TOKEN?.trim();
  if (!token) {
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
  opts: Record<string, string | boolean | undefined>;
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
};

interface Spec {
  /** Options the command takes, beyond --json and --no-color. */
  options?: string[];
  /** Names the positional arguments in error messages; "..." at the end means one or more. */
  args?: string;
  /** Lists take --limit and --cursor. */
  paged?: boolean;
  maxArgs?: number;
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

async function listPosts(ctx: Context, path: string, query: Record<string, string | number | boolean | undefined>, empty: string) {
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

function shellQuote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`;
}

const COMMANDS: Record<string, { spec: Spec; handler: (ctx: Context) => Promise<void> }> = {
  feed: { spec: { paged: true }, handler: (ctx) => listPosts(ctx, "/feeds/foryou", {}, "Your feed is empty.") },

  popular: {
    spec: { paged: true, options: ["tag"] },
    handler: (ctx) => listPosts(ctx, "/feeds/popular", { tags: opt(ctx, "tag") }, "No popular posts found."),
  },

  discussed: {
    spec: { paged: true, options: ["period", "tag"] },
    handler: (ctx) => listPosts(ctx, "/feeds/discussed", { period: opt(ctx, "period"), tag: opt(ctx, "tag") }, "No discussed posts found."),
  },

  tag: {
    spec: { paged: true, args: "<tag>" },
    handler: (ctx) => {
      const tag = ctx.args[0];
      return listPosts(ctx, `/feeds/tag/${encodeURIComponent(tag)}`, {}, `No posts for #${tag}. Find tag names with: dailydev tags ${tag}`);
    },
  },

  search: {
    spec: { paged: true, options: ["time"], args: "<words>..." },
    handler: (ctx) => {
      const q = ctx.args.join(" ");
      return listPosts(ctx, "/search/posts", { q, time: opt(ctx, "time") }, `No posts found for "${q}". Try fewer words: the search matches keywords, not sentences.`);
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
      return listPosts(ctx, search ? "/bookmarks/search" : "/bookmarks/", { q: search, unreadOnly: ctx.opts.unread ? "true" : undefined }, search ? `No bookmarks match "${search}".` : "You have no bookmarks.");
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
};

interface Profile {
  name: string;
  username: string;
  reputation: number;
  permalink: string;
  streak?: { current: number; max: number };
}
