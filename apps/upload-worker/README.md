# Upload Worker

`dray upload`'s endpoint (#1479): a Cloudflare Worker that takes one file per
`POST /`, checks the caller's GitHub token against `GET /user`, sniffs the
bytes, and streams the file into R2 through a binding. No S3 keys.

- Images (png, jpg, gif, webp) up to 20 MB; videos (mp4, webm, mov) up to 100 MB.
- Keys are 128 random bits plus the extension. Not a content hash, which would
  need the whole body in memory before the write starts.
- 120 requests an hour per address before GitHub is asked; 30 an hour and 200
  a day per GitHub user. Counted in a Durable Object (`Limiter`), since the
  Rate Limiting binding only counts over 10 or 60 seconds.
- The token is never stored or logged. Workers Logs stays off in
  `wrangler.jsonc`, since invocation logs record request headers.

Config lives in [wrangler.jsonc](wrangler.jsonc): the bucket (`bucket_name`),
its public domain (`PUBLIC_URL`) and the Worker's own domain (`routes`).

## Run it locally

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
3. **Deploy.** `pnpm run deploy`. That creates the Worker, the `Limiter` Durable
   Object (migration `v1`), the R2 binding, and `upload.drayhq.com` as the
   Worker's custom domain, DNS record included. It fails if a record for that
   name already exists.
4. **Check.** `curl -sI https://upload.drayhq.com/` answers a 302 to the docs.
   `dray upload shot.png` from a CLI built off this branch lands a file whose
   URL opens.

Cloudflare's own request body cap on the Free and Pro plans is 100 MB, so a
video just under the Worker's 100 MiB cap can be refused at the edge with
Cloudflare's own 413 before the Worker sees it.
