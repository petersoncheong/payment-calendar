-- Payment Calendar: push-notification table. Run once in Supabase → SQL Editor → New query → Run.
-- (Run supabase-setup.sql first.)

create table public.push_subscriptions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  endpoint     text not null unique,                 -- one row per device/browser
  p256dh       text not null,
  auth         text not null,
  timezone     text not null default 'UTC',          -- the device's time zone, so "8 AM" means 8 AM for you
  notify_hour  int  not null default 8 check (notify_hour between 0 and 23),
  currency     text not null default '$',
  last_sent_on date,                                 -- set by the server so a day is only alerted once
  created_at   timestamptz not null default now()
);

create index push_subscriptions_user on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;

-- Signed-in users manage only their own devices. The Edge Function uses the service role, which bypasses this.
create policy "own subscriptions" on public.push_subscriptions
  for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
