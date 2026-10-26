---
stage: build
interface: cli
product:
  - storage
topic:
  - security
projectRunning: false
needsDocker: false
motivation: CLI-2713, https://linear.app/supabase/issue/CLI-2713/eval-seed-storage-buckets-and-move-files-locally, FDBKIN-5816, https://linear.app/supabase/issue/FDBKIN-5816/add-a-cli-flag-or-command-to-make-a-storage-bucket-public, FDBKIN-5351, https://linear.app/supabase/issue/FDBKIN-5351/improve-documentation-for-declarative-storage-bucket-and-file-seeding, FDBKIN-25373, https://linear.app/supabase/issue/FDBKIN-25373/fix-storage-move-method-to-correctly-handle-destination-buckets
area: storage
journeyPhase: design
---

Customer invoices are ending up in our public storage bucket when I run Supabase locally. Can you move them into a private bucket, and make sure a fresh local setup doesn't put them back in the public one? Leave it running when you're done, I want to check it myself.
