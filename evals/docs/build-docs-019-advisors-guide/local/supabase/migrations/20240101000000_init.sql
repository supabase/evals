-- Clinicly, a booking app for physio clinics. A clinic has treatment rooms
-- and practitioners, and patients book an appointment with a practitioner
-- in one of the clinic's rooms.

create table public.clinics (
  id bigint primary key generated always as identity,
  name text not null
);

-- Room codes are only unique inside a clinic. Every clinic has a "1".
create table public.rooms (
  clinic_id bigint not null references public.clinics,
  code text not null,
  primary key (clinic_id, code)
);

create table public.practitioners (
  id bigint primary key generated always as identity,
  clinic_id bigint not null references public.clinics,
  name text not null
);

-- A practitioner sees many patients a day, often in the same room.
create table public.appointments (
  id bigint primary key generated always as identity,
  clinic_id bigint not null,
  room_code text not null,
  practitioner_id bigint not null references public.practitioners,
  starts_at timestamptz not null,
  foreign key (clinic_id, room_code) references public.rooms (clinic_id, code)
);

-- The room calendar shows one room's day in time order.
create index appointments_room_calendar
  on public.appointments (room_code, starts_at);
