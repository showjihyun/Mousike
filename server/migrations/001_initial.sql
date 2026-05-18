-- Mousike initial schema.
-- Run on a fresh Supabase project. Idempotent: safe to re-run.

create extension if not exists "pgcrypto";

create table if not exists users (
  id          uuid primary key default gen_random_uuid(),
  google_id   text unique not null,
  email       text not null,
  name        text,
  picture     text,
  created_at  timestamptz not null default now()
);

create table if not exists credits (
  user_id     uuid primary key references users(id) on delete cascade,
  balance     int not null default 0,
  updated_at  timestamptz not null default now()
);

-- IDs are client-generated text (carried over from the localStorage era) so the
-- same row keys exist on client and server with no translation layer.
create table if not exists generations (
  id              text primary key,
  user_id         uuid not null references users(id) on delete cascade,
  prompt          text not null,
  parent_gen_id   text references generations(id) on delete set null,
  parent_song_id  text,
  variation_type  text,
  palette         jsonb not null,
  created_at      timestamptz not null default now()
);

create index if not exists generations_user_created_idx
  on generations (user_id, created_at desc);

-- `key` is awkward in SQL; store the musical key as music_key.
create table if not exists songs (
  id            text primary key,
  gen_id        text not null references generations(id) on delete cascade,
  user_id       uuid not null references users(id) on delete cascade,
  title         text not null,
  style         text not null,
  bpm           int  not null,
  music_key     text not null,
  vibe          text not null,
  duration_sec  int  not null,
  prompt        text not null,
  liked         boolean not null default false,
  waveform      jsonb not null,
  instruments   jsonb not null,
  palette       jsonb not null,
  audio_url     text,
  created_at    timestamptz not null default now()
);

create index if not exists songs_gen_idx on songs (gen_id);
create index if not exists songs_user_liked_idx on songs (user_id, liked);
