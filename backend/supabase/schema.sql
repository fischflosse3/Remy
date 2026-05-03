create table if not exists remy_users (
  id text primary key,
  email text unique not null,
  password_salt text not null,
  password_hash text not null,
  plan text not null default 'free',
  stripe_customer_id text,
  stripe_subscription_id text,
  stripe_subscription_status text,
  last_stripe_event text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists remy_usage (
  user_id text not null references remy_users(id) on delete cascade,
  month text not null,
  plan text not null default 'free',
  used integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, month)
);

create table if not exists remy_memories (
  id text primary key,
  user_id text not null references remy_users(id) on delete cascade,
  title text not null,
  url text not null,
  domain text,
  summary text,
  text text,
  search_query text,
  platform text,
  media jsonb not null default '{}'::jsonb,
  language jsonb not null default '{}'::jsonb,
  keywords text[] not null default '{}',
  saved_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, url)
);

create index if not exists remy_users_email_idx on remy_users(email);
create index if not exists remy_users_stripe_customer_idx on remy_users(stripe_customer_id);
create index if not exists remy_memories_user_saved_idx on remy_memories(user_id, saved_at desc);
create index if not exists remy_memories_user_url_idx on remy_memories(user_id, url);
