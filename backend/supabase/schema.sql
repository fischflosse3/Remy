create extension if not exists pgcrypto;
create table if not exists remy_users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  password_hash text not null,
  password_salt text default '',
  plan text not null default 'free',
  stripe_customer_id text,
  created_at timestamptz not null default now()
);
alter table if exists remy_users alter column password_salt drop not null;
alter table if exists remy_users alter column password_salt set default '';

create table if not exists remy_usage (
  user_id uuid not null references remy_users(id) on delete cascade,
  month text not null,
  used integer not null default 0,
  primary key (user_id, month)
);

create table if not exists remy_free_trials (
  user_id uuid primary key references remy_users(id) on delete cascade,
  used boolean not null default false,
  used_at timestamptz
);
