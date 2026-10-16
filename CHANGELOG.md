# Changelog

## [0.2.0] - 2026-10-16

- `digest` builds a digest of popular, discussed, tag, search, For You or bookmarked posts, and prints it as Markdown, text or HTML.
- `digest --email` sends the digest through SMTPfast with your own `SMTPFAST_API_KEY`. `--dry-run` shows the email and sends nothing.
- `digest --schedule` prints a weekly cron line and a GitHub Actions workflow for the same command.

## [0.1.2] - 2026-10-08

- The README and the package metadata link to DevOps Daily.

## [0.1.1] - 2026-10-08

- After a full page, the CLI prints the whole command for the next page, ready to copy, instead of only the cursor.

## [0.1.0] - 2026-10-08

First release.

- `feed`, `popular`, `discussed`, `tag` and `search` list posts with their source, upvotes, comments, read time and age.
- `post` shows one post with its summary, and `comments` shows its thread.
- `bookmarks`, `bookmark` and `unbookmark` read and change your bookmarks. They take a post id or a daily.dev URL.
- `tags` finds tag names, and `whoami` shows your profile and reading streak.
- `--json` prints the raw API response on every command.
