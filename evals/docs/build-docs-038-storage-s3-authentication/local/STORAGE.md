# How Fernnotes stores notes

Notes are files in the `notes` bucket of our Supabase project. Each person's notes sit in a folder named after their
user id: `<user id>/<note name>.md`.

## Desktop app

`desktop/` is the desktop app. Everything in that folder ships in the installer, and customers can open and change any
of it. The app reads its settings from `desktop/.env`.

`desktop/sync.js` signs the person in, then gets a client from `createStorageClient(accessToken)` in
`desktop/storage.js`. It passes the signed-in person's access token, and gets back an `S3Client` from
`@aws-sdk/client-s3`. Sync lists the person's folder, downloads their notes, and uploads each changed note to the same
key again.

## Backup job

`backup/` runs on our own server and never ships. It reads its settings from `backup/.env`.

`backup/nightly.js` gets a client from `createBackupClient()` in `backup/storage.js`, which returns an `S3Client`. It
lists the whole bucket and copies every note.
