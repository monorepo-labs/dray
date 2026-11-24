# Contributing

Read [README.md](README.md) for the layout and how to run each app, and
[CLAUDE.md](CLAUDE.md) for how work lands here.

## Screenshots in a pull request

A change you can see wants a screenshot in its PR. Upload it from the terminal
with the `dray` CLI:

```bash
dray upload before.png after.png
```

It prints one markdown image line per file. Paste them into the PR body.

- It signs in with your GitHub account: `GITHUB_TOKEN` if set, else
  `gh auth token`. The token is checked with GitHub and never kept.
- PNG, JPEG, GIF or WebP, 4 MB each at most. 30 uploads an hour per account.
- Images are public, so upload only what belongs in a public PR.
- No `dray` CLI? Install it with
  `curl -fsSL https://www.drayhq.com/install.sh | sh`, or call the endpoint
  with plain `curl`, as [the docs](https://www.drayhq.com/docs/cli/upload)
  show.
