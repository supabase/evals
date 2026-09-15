---
stage: build
interface: cli
product:
  - storage
  - auth
topic:
  - rls
  - security
services:
  - gotrue
  - kong
  - postgrest
  - storage-api
motivation: >-
  the Storage Access Control guide is the page agents are pointed at to lock
  down user uploads, and it teaches policies on storage.objects without ever
  saying that a public bucket serves every object it holds regardless of them.
  Users of AI builders report first-hand that an assistant asked to add photo
  storage reaches for a public bucket, and that nothing warned them the files
  were world-readable. One support case was a broad read policy on a public
  bucket that let every signed-in user enumerate every profile picture on a
  dating app, and the setup was believed to have been written by an assistant;
  it was the second case of that shape in a month. Customers keep asking for
  the documentation to steer them to private buckets and signed links, and keep
  reporting that the examples they can find are all public ones. The sibling
  Creating Buckets guide, which this page does not link to, passes
  `public: true` in both of its examples. Nothing in the Supabase agent skill
  mentions buckets, so the page is the only carrier. The prompt deliberately
  omits the vocabulary the page teaches, so read README.md before editing it.
---

I'm adding profile pictures to our app. Everyone picks their own, and nobody
should be able to get at anyone else's. That includes guessing the address of
someone's file, and calling whatever the app calls to load one.

The app talks to Supabase straight from the browser. We have no server of our
own in between, so people upload and load their own picture themselves.

Get our project set up so the app can start putting them somewhere.

Read the guide below before you start and rely on it for how to set this up,
rather than on what you already know.

REFERENCE
https://supabase.com/docs/guides/storage/security/access-control.md
