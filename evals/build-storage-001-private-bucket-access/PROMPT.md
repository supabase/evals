---
stage: build
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

Our app lets signed-in users keep personal files like receipts and bank
statements. These files are private — a user must only ever be able to upload
and download their own. The app uploads each file under a path that starts
with the owner's user id, e.g. `<user_id>/receipt-march.pdf`.

Set up a `user-files` bucket on our project and lock it down that way.

Users also sometimes share one of their files with someone else through a
temporary link that expires. Include the supabase-js code the app should use
for that.
