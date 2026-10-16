# dailydev-cli

Read [daily.dev](https://daily.dev) from your terminal: your feed, popular posts, search, comments and bookmarks. Every command also has `--json`, so scripts and coding agents can use the same tool.

```bash
npm install -g @devopsdaily/dailydev-cli
export DAILY_DEV_TOKEN="dda_..."   # from https://daily.dev/settings/api
dailydev feed
```

A community project from [DevOps Daily](https://devops-daily.com). It is not made by daily.dev. It uses the [daily.dev public API](https://docs.daily.dev/).

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
| `dailydev digest [source]` | A digest to print or send by email, see [Email digest](#email-digest) |

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

## Email digest

`dailydev digest` builds a digest of posts and prints it as Markdown, or as text or HTML with `--format text` or `--format html`. The source is one of:

- `popular` (the default), with `--tags kubernetes,docker` for some tags
- `discussed`: the most discussed posts of the week, with `--tags rust` for one tag
- `tag <tag>`
- `search <words>`: the posts daily.dev added in the last `--days` days (default 7)
- `feed`: your For You feed
- `bookmarks`

`--limit` sets how many posts (default 10). With `--json`, the CLI prints the subject and the posts as the API sends them.

`--email` sends the digest through [SMTPfast](https://smtpfa.st) with your own API key. Give it more than once, or comma separate the addresses. All recipients go in the To field of one email, so they see each other's addresses. The From address comes from `--from` or `SMTPFAST_FROM`, and it must be on a domain you verified in your SMTPfast account.

```bash
export SMTPFAST_API_KEY="sf_..."
export SMTPFAST_FROM="Digest <digest@yourdomain.dev>"

# Show the subject, the recipients and the posts, and send nothing
dailydev digest popular --tags kubernetes,docker --email you@yourdomain.dev --dry-run

dailydev digest popular --tags kubernetes,docker --email you@yourdomain.dev,team@yourdomain.dev
```

`--schedule` prints a weekly cron line and a GitHub Actions workflow that run the same command, without `--dry-run`. It runs nothing. The workflow reads the repository secrets `DAILY_DEV_TOKEN` and `SMTPFAST_API_KEY`.

```bash
dailydev digest popular --tags kubernetes --email you@yourdomain.dev --schedule
```

The key goes only to `https://smtpfa.st/api/v1/emails`, and that URL is fixed. The CLI does not follow redirects and never prints the key. When the digest has no posts, the CLI sends no email.

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

## About

Built and maintained by [DevOps Daily](https://devops-daily.com), a blog and set of free tools for DevOps and platform engineers: Kubernetes, Docker, Terraform, CI/CD, Linux and cloud. You can also follow the [DevOps Daily squad](https://daily.dev/squads/devopsdaily) on daily.dev.

## License

MIT
