import type { Comment, Post } from "./api.ts";

export interface Style {
  bold(s: string): string;
  dim(s: string): string;
  accent(s: string): string;
}

const wrapAnsi = (open: number, close: number) => (s: string) => `\x1b[${open}m${s}\x1b[${close}m`;

export function createStyle(color: boolean): Style {
  if (!color) return { bold: (s) => s, dim: (s) => s, accent: (s) => s };
  return { bold: wrapAnsi(1, 22), dim: wrapAnsi(2, 22), accent: wrapAnsi(33, 39) };
}

// API text is written by other people. These characters can move the cursor, rewrite the screen,
// set the terminal title or reorder what you read, so they never reach the terminal.
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

export function stripControls<T>(value: T): T {
  if (typeof value === "string") return value.replace(UNSAFE, "") as T;
  if (Array.isArray(value)) return value.map(stripControls) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, stripControls(v)])) as T;
  return value;
}

export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const seconds = Math.max(0, (now - Date.parse(iso)) / 1000);
  const steps: [number, string][] = [
    [60, "s"],
    [60, "m"],
    [24, "h"],
    [30, "d"],
    [12, "mo"],
  ];
  let value = seconds;
  for (const [size, unit] of steps) {
    if (value < size) return `${Math.floor(value)}${unit} ago`;
    value /= size;
  }
  return `${Math.floor(value)}y ago`;
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Shares come back from the public API with an empty title. */
export function postTitle(post: Post): string {
  if (post.title) return post.title;
  const by = post.author?.username ? ` by @${post.author.username}` : "";
  return post.source?.name ? `Shared${by} in ${post.source.name}` : `Shared post${by}`;
}

export function wrap(text: string, width: number, indent = ""): string {
  const lines: string[] = [];
  for (const paragraph of text.split(/\n+/)) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (line && indent.length + line.length + 1 + word.length > width) {
        lines.push(indent + line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    if (line) lines.push(indent + line);
  }
  return lines.join("\n");
}

export function postMeta(post: Post, now?: number): string {
  return [
    post.source?.name,
    plural(post.numUpvotes, "upvote"),
    plural(post.numComments, "comment"),
    post.readTime ? `${post.readTime} min read` : "",
    timeAgo(post.publishedAt ?? post.createdAt, now),
  ]
    .filter(Boolean)
    .join(" · ");
}

export function formatPostList(posts: Post[], style: Style, now?: number): string {
  const pad = String(posts.length).length;
  return posts
    .map((post, i) => {
      const indent = " ".repeat(pad + 2);
      return [
        `${String(i + 1).padStart(pad)}. ${style.bold(postTitle(post))}`,
        `${indent}${style.dim(postMeta(post, now))}`,
        `${indent}${style.accent(post.commentsPermalink)}  ${style.dim(`id ${post.id}`)}`,
      ].join("\n");
    })
    .join("\n\n");
}

export function formatPost(post: Post, style: Style, width: number, now?: number): string {
  const out = [style.bold(postTitle(post)), style.dim(postMeta(post, now))];
  if (post.tags?.length) out.push(style.dim(post.tags.map((t) => `#${t}`).join(" ")));
  if (post.summary) out.push("", wrap(post.summary, width));
  out.push("");
  if (post.url) out.push(`Article  ${style.accent(post.url)}`);
  out.push(`Discuss  ${style.accent(post.commentsPermalink)}`);
  out.push(style.dim(`id ${post.id}`));
  return out.join("\n");
}

export function formatComments(comments: Comment[], style: Style, width: number, now?: number, depth = 0): string {
  const indent = "  ".repeat(depth);
  return comments
    .map((c) => {
      const head = [style.bold(`@${c.author?.username ?? "unknown"}`), style.dim(timeAgo(c.createdAt, now)), c.numUpvotes ? style.dim(plural(c.numUpvotes, "upvote")) : ""]
        .filter(Boolean)
        .join(style.dim(" · "));
      const parts = [indent + head, wrap(c.content, width, indent + "  ")];
      if (c.children?.length) parts.push(formatComments(c.children, style, width, now, depth + 1));
      return parts.join("\n");
    })
    .join("\n\n");
}
