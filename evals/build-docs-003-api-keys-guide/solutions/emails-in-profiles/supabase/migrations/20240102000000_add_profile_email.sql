-- The flaw: the address is copied out of auth.users into a table whose read
-- policy is public. RLS is on and a policy exists, so the guide's checklist is
-- satisfied while every email is readable by anon.

ALTER TABLE profiles ADD COLUMN email text;
