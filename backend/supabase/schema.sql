create extension if not exists pgcrypto;
create table if not exists remy_users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  password_hash text not null,
  plan text not null default 'free',
  stripe_customer_id text,
  updated_at timestamptz,
  created_at timestamptz not null default now()
);
create table if not exists remy_usage (
  user_id uuid not null references remy_users(id) on delete cascade,
  month text not null,
  used integer not null default 0,
  primary key (user_id, month)
);


alter table remy_users add column if not exists stripe_customer_id text;
alter table remy_users add column if not exists updated_at timestamptz;
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'remy_users' and column_name = 'password_salt'
  ) then
    alter table remy_users alter column password_salt drop not null;
    alter table remy_users alter column password_salt set default '';
  end if;
end $$;
