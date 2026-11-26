# Download links

Reports live on our CDN. The CDN serves a file only when the link carries a valid
signature, so every link the app shows has to be signed.

The CDN checks links with the signing key in `.env` (`CDN_SIGNING_KEY`). Ops can
change that key at any time, and links signed with the old key stop working the
moment they do.

## What the app calls

The app asks the database for a link through the API:

```ts
const { data: url } = await supabase.rpc('signed_download_url', {
  file_path: 'reports/2026-q3.pdf',
})
```

`signed_download_url(file_path text)` returns the full link as text.

## Link format

```
https://cdn.plantly.example/<file_path>?expires=<unix seconds>&signature=<hex>
```

- `expires` is 15 minutes from when the link was made.
- `signature` is the HMAC-SHA256 of `<file_path>:<expires>`, written as
  lowercase hex. The HMAC key is the signing key as text, exactly as it appears
  in `.env`.
