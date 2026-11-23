-- Tidewater rents out boats by the day. The help center is a table of
-- articles that support writes and the website lists.

create table public.articles (
  id bigint primary key generated always as identity,
  title text not null,
  -- Support starts an article with just a title and fills the text in later,
  -- so some of these are empty for a while.
  body text,
  created_at timestamptz not null default now()
);

insert into public.articles (title, body) values
  (
    'How to book a boat',
    'Pick a boat, choose your dates and pay the deposit. You will get a confirmation email with the harbour map.'
  ),
  (
    'Changing the date of a booking',
    'You can move a booking up to 48 hours before pickup from the bookings page. Moving it later than that costs a rebooking fee.'
  ),
  (
    'Refunds',
    'Bookings cancelled at least a week ahead are refunded in full. Inside a week we keep the deposit.'
  ),
  (
    'Life jackets and safety briefing',
    'Every boat carries a life jacket per seat. A short safety briefing happens at the harbour office before you leave.'
  ),
  ('Fuel and mooring fees', null),
  (
    'Bringing a dog on board',
    'Dogs are welcome on the open boats. Please bring a towel and a lead.'
  );
