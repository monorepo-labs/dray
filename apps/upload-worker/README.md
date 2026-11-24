# Upload Worker

`dray upload`'s endpoint (#1479): a Cloudflare Worker that takes one file per
`POST /`, checks the caller's GitHub token against `GET /user`, checks the
caller contributes to Dray, sniffs the bytes, and streams the file into R2
through a binding. No S3 keys.

- **Dray contributors only** (#1501): a collaborator of `monorepo-labs/dray`,
  a member of the `monorepo-labs` org, or the author of a PR open there.
  Anyone else gets 403 `not_a_contributor`. Asked in that order with Dray's own
  token, the `GITHUB_LOOKUP_TOKEN` secret, never the caller's
  ([contributor.ts](src/contributor.ts)). Open PRs are matched on user id,
  since a login can be renamed and reused. No secret set = 503 `uploads_off`;
  GitHub refusing it = 503 `contributor_check_failed`.
- Images (png, jpg, gif, webp) up to 20 MB; videos (mp4, webm, mov) up to 100 MB.
- Keys are 128 random bits plus the extension. Not a content hash, which would
  need the whole body in memory before the write starts.
- 600 requests an hour per address before GitHub is asked; 300 an hour and 2000
  a day per GitHub user, counted before the contributor lookup so a stranger
  retrying costs our token little. Counted in a Durable Object (`Limiter`), since the
  Rate Limiting binding only counts over 10 or 60 seconds.
- The token is never stored or logged. Workers Logs stays off in
  `wrangler.jsonc`, since invocation logs record request headers.

Config lives in [wrangler.jsonc](wrangler.jsonc): the bucket (`bucket_name`),
its public domain (`PUBLIC_URL`) and the Worker's own domain (`routes`).

## Run it locally

`pnpm dev` needs a lookup token. Put `GITHUB_LOOKUP_TOKEN=<token>` in
`.dev.vars` here (gitignored); your own `gh auth token` works, being a
collaborator's.

```bash
pnpm dev                                          # wrangler dev, local R2 and Durable Objects
DRAY_UPLOAD_URL=http://127.0.0.1:8787 dray upload shot.png
pnpm test                                         # unit tests, then wrangler dev against a fake GitHub
```

Locally, the URLs answered point at `PUBLIC_URL`, which serves nothing. Read
what landed through wrangler's local explorer:
`http://127.0.0.1:8787/cdn-cgi/local/explorer/api/r2/buckets/dray-uploads/objects`.

## Deploy

Not wired into CI. From this directory, signed in with `pnpm exec wrangler login`:

1. **Bucket.** `pnpm exec wrangler r2 bucket create dray-uploads`, or point
   `bucket_name` at an existing bucket.
2. **Public access.** Dashboard → R2 → the bucket → Settings → Custom Domains →
   Connect Domain → `img.drayhq.com`. Another domain works; change `PUBLIC_URL`
   to match. Leave the `r2.dev` URL off; it is rate-limited and not for production.
3. **Lookup token.** Create a fine-grained personal access token at
   GitHub → Settings → Developer settings → Fine-grained tokens, signed in as
   an admin of `monorepo-labs`:
   - Resource owner: `monorepo-labs`. Repository access: only `monorepo-labs/dray`.
   - Repository permissions: Metadata, read (set by default), and Pull
     requests, read.
   - Organization permissions: Members, read.
   - Expiration: the longest the org allows. When it lapses, uploads answer
     503 `contributor_check_failed` until it is replaced.

   The collaborator check also needs the token's owner to have push access to
   the repo. Then `pnpm exec wrangler secret put GITHUB_LOOKUP_TOKEN` and paste
   it.
4. **Deploy.** `pnpm run deploy`. That creates the Worker, the `Limiter` Durable
   Object (migration `v1`), the R2 binding, and `upload.drayhq.com` as the
   Worker's custom domain, DNS record included. It fails if a record for that
   name already exists.
5. **Check.** `curl -sI https://upload.drayhq.com/` answers a 302 to
   CONTRIBUTING.md. `dray upload shot.png` as a contributor lands a file whose
   URL opens; as anyone else it says uploads are for Dray contributors.

Cloudflare's own request body cap on the Free and Pro plans is 100 MB, so a
video just under the Worker's 100 MiB cap can be refused at the edge with
Cloudflare's own 413 before the Worker sees it.
