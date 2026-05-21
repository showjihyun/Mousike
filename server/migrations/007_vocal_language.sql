-- Vocal language the song was generated to sing in. Nullable on purpose:
-- rows predating this column have no recorded value and resolve to "unknown"
-- on read, preserving today's behavior with zero backfill risk.
--
-- Values: 'KO' | 'EN' | 'unknown' (resolved server-side from the user's
-- 'auto' | 'KO' | 'EN' input via the vocal-language auto rule).

alter table songs
  add column if not exists vocal_language text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'songs_vocal_language_check'
  ) then
    alter table songs
      add constraint songs_vocal_language_check
        check (vocal_language is null or vocal_language in ('KO', 'EN', 'unknown'));
  end if;
end $$;
