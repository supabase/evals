CREATE TABLE bookmarks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  title text NOT NULL,
  url text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Bug: RLS is enabled and the grants are in place, but no policies were ever
-- created, so the Data API silently returns zero rows to every user.
ALTER TABLE bookmarks ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT ON bookmarks TO authenticated;
