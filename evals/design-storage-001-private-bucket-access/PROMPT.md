---
stage: design
suite: benchmark
product:
  - storage
  - database
topic:
  - rls
  - sdk
motivation: AI-810, STORAGE-478, AI-676
---

# Private User Files in Storage

You are working on a Supabase project for an app where signed-in users keep
personal files (receipts and statements). Files are private — a user must only
ever be able to upload and download their own files. The app uploads each file
under a path prefixed with the owner's user id, e.g.
`<user_id>/receipt-march.pdf`.

Configure Storage for this feature:

1. Create a Storage bucket named `user-files` for these files.
2. Set up access control so authenticated users can upload files only under
   their own folder and download only their own files.
3. Occasionally a user shares one of their files with someone else through a
   temporary link that expires; provide the supabase-js code the app should
   use to produce that link.

Apply the required changes to the project. End your turn when storage access
is configured and you have provided the sharing code.
