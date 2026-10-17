-- Payment Calendar: run this once in Supabase → SQL Editor → New query → Run.

create table public.payees (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name       text not null,
  created_at timestamptz not null default now()
);

create table public.payments (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  payee_id   uuid not null references public.payees(id) on delete cascade,
  invoice    text not null,
  amount     numeric(14,2) not null check (amount > 0),
  pay_date   date not null,
  created_at timestamptz not null default now()
);

create index payments_user_date  on public.payments (user_id, pay_date);
create index payments_user_payee on public.payments (user_id, payee_id);

-- Each signed-in user can only see and change their own rows.
alter table public.payees   enable row level security;
alter table public.payments enable row level security;

create policy "own payees" on public.payees
  for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy "own payments" on public.payments
  for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Live updates between devices.
alter publication supabase_realtime add table public.payees, public.payments;
