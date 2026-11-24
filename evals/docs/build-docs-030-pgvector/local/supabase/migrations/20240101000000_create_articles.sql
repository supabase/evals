-- Tidewater's help center articles. The search box on the help center finds
-- related articles from a sentence a visitor types (see app/search.mjs).
create table public.articles (
  id bigint generated always as identity primary key,
  title text not null,
  body text not null
);

insert into public.articles (title, body) values
  ('Resetting your password', 'To reset your password open Settings and choose Reset password. We email you a link that works for one hour.'),
  ('Updating your billing address', 'Open Billing in Settings and edit the address on your invoices. New invoices use it straight away.'),
  ('Cancelling a subscription', 'You can cancel a subscription from Billing at any time. It stays active until the end of the period you paid for.'),
  ('Exporting your data', 'Choose Export in Settings to download your orders and customers as a spreadsheet. Large exports are emailed to you.'),
  ('Inviting teammates', 'Owners can invite teammates by email from the Team page. Each teammate picks their own password.'),
  ('Two step sign in', 'Turn on two step sign in under Security to ask for a code from your phone every time you sign in.');
