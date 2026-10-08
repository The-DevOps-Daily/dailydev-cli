# dailydev-cli

Read [daily.dev](https://daily.dev) from your terminal: your feed, popular posts, search, comments and bookmarks. Every command also has `--json`, so scripts and coding agents can use the same tool.

```bash
npm install -g @devopsdaily/dailydev-cli
export DAILY_DEV_TOKEN="dda_..."   # from https://daily.dev/settings/api
dailydev feed
```

This is a community project. It is not made by daily.dev. It uses the [daily.dev public API](https://docs.daily.dev/).

## What it looks like

```text
$ dailydev search terraform state lock -n 2
1. Terraform: remote state with AWS S3, and state locking with DynamoDB
   ITNEXT · 2 upvotes · 0 comments · 6 min read · 3y ago
   https://daily.dev/posts/terraform-remote-state-with-aws-s3-and-state-locking-with-dynamodb-rd2nsze5y  id Rd2NSzE5Y

2. Terraform State Lock: How It Works & Best Practices
   Spacelift · 0 upvotes · 0 comments · 15 min read · 7mo ago
   https://daily.dev/posts/terraform-state-lock-how-it-works-best-practices-exnksecg7  id eXNKSecg7

More: dailydev search terraform state lock -n 2 --cursor YXJyYXljb25uZWN0aW9uOjI=
```

## Commands

| Command | What it does |
| --- | --- |
| `dailydev feed` | Your For You feed |
| `dailydev popular [--tag kubernetes,docker]` | Popular posts, optionally for some tags |
| `dailydev discussed [--period 7\|30\|365] [--tag rust]` | The posts with the most comments |
| `dailydev tag <tag>` | The latest posts for one tag |
| `dailydev search <words> [--time week]` | Search posts |
| `dailydev post <id\|url>` | One post with its summary and links |
| `dailydev comments <id\|url> [--sort newest]` | The comment thread of a post |
| `dailydev bookmarks [--unread] [--search <words>]` | Your bookmarks |
| `dailydev bookmark <id\|url>...` | Bookmark one or more posts |
| `dailydev unbookmark <id\|url>` | Remove a bookmark |
| `dailydev tags <words>` | Find tag names to use with `tag` and `--tag` |
| `dailydev whoami` | Your profile and reading streak |

The commands that list posts or comments also take:

- `-n, --limit <n>`: how many results, from 1 to 50 (default 10)
- `--cursor <cursor>`: the next page; after a full page, the CLI prints the command for the next one

Every command takes:

- `--json`: print the raw API response
- `--no-color`: no colors (`NO_COLOR` works too; colors are off when the output is not a terminal)

A command stops with exit code 2 if you give it an option it does not use.

A post id is case sensitive. You can always paste the daily.dev URL of a post instead.

## Search tips

The search matches keywords, not sentences. `dailydev search another operation is in progress` finds nothing, and `dailydev search ImagePullBackOff` finds several posts. Use one to three words.

## For scripts and agents

`--json` prints the response exactly as the API sends it, with `data` and `pagination`. `unbookmark` gets no response body from the API, so with `--json` it prints nothing and exits 0.

```bash
# Titles and links of today's popular Kubernetes posts
dailydev popular --tag kubernetes --json | jq -r '.data[] | "\(.title)\t\(.commentsPermalink)"'

# Bookmark the top search result
dailydev bookmark "$(dailydev search pgvector -n 1 --json | jq -r '.data[0].id')"
```

Exit codes: `0` success, `1` an API or network error, `2` a usage error. Errors go to stderr.

## Notes

- The API allows 60 requests a minute. When you reach the limit, the CLI tells you how long to wait.
- Posts shared in a squad have no title in the public API, so the CLI shows who shared it and where.
- `DAILY_DEV_API_URL` changes the API base URL, for testing.
- The token goes only to the API base URL. The CLI does not follow redirects.
- Titles, summaries and comments come from other people, so the CLI removes terminal control characters from them before it prints. `--json` output is unchanged, because JSON escapes those characters.

## Development

```bash
npm install
npm test          # vitest, with a mocked API
npm run check     # TypeScript
npm run build     # writes dist/
node src/bin.ts feed   # run from source on Node 24
```

Releases: bump the version in `package.json`, `src/version.ts` and `CHANGELOG.md`, then push a `v*` tag. The release workflow tests, packs and publishes to npm.

## License

MIT
