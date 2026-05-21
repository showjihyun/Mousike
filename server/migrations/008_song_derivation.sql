-- Records song parentage so the Master canvas can render the user's
-- session as a directed graph (Song nodes + Derivation edges). Also
-- powers the simpler "← parent song" link that the Play mode plan calls
-- for in Month 2 (acestep-ui-design-plan.md §C.3).
--
-- Decision recorded in docs/adr/0001-song-derivation-on-songs-table.md:
-- we denormalize derivation onto songs rather than reconstructing it
-- from jobs.payload on each graph render. Trade-off accepted because
-- derivation is immutable after the row is created.
--
-- Schema invariants:
--   Seed Song    (generate result): parent_song_id IS NULL AND derivation_kind IS NULL
--   Derived Song (non-generate):    parent_song_id IS NOT NULL AND derivation_kind IS NOT NULL
-- Enforced by songs_derivation_paired below.
--
-- derivation_kind's CHECK starts narrow ('repaint', 'lego') — the only
-- non-generate jobs.kind values today. Widen it when cover / extract /
-- complete ship.
--
-- Legacy Songs created before this migration keep both columns NULL and
-- render as seeds on the canvas. No backfill — older repaint/lego
-- outputs lose their parent link, which is an accepted loss.

alter table songs
  add column if not exists parent_song_id   text references songs(id) on delete cascade,
  add column if not exists derivation_kind  text;

alter table songs
  add constraint songs_derivation_kind_chk
    check (derivation_kind is null or derivation_kind in ('repaint', 'lego'));

alter table songs
  add constraint songs_derivation_paired
    check ((parent_song_id is null) = (derivation_kind is null));

-- Graph render walks children from a parent → frequent filter.
create index if not exists songs_parent_idx
  on songs (parent_song_id)
  where parent_song_id is not null;
