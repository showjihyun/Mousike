# Record song derivation on the `songs` table

The Master canvas (a ComfyUI-styled graph view planned for Mousike's Master mode) needs to render each user's full song derivation history — every `repaint`/`lego`/etc. job produces a child Song whose parent must be visible on the graph. We record this on `songs` as `parent_song_id` (nullable FK to `songs`) plus `derivation_kind` (text, mirroring the operation that produced the row), rather than reconstructing it on each render from `jobs.payload`.

## Considered Options

- **(a) Two new columns on `songs` (chosen).** Graph render becomes a single self-join (`SELECT id, parent_song_id, derivation_kind FROM songs WHERE user_id = ?`). Slight denormalization is acceptable because derivation is immutable after generation — there is no sync risk between the song row and its derivation.
- **(b) Read from `jobs.payload` on each graph render.** Pure (no denormalization) but every render becomes a join with JSONB parsing across potentially hundreds of nodes, and the rendering layer ends up tightly coupled to the specific shape of `jobs.payload` for each kind. Rejected on performance + coupling grounds.
- **(c) Separate `derivations` join table (`parent_id, child_id, kind, params`).** Cleanest if a derivation ever becomes many-to-many (e.g. an op that mixes two parent songs). Every current ACE-Step operation has exactly one parent, so the extra table is overhead today. Revisit if/when a multi-parent op ships.

## Consequences

- A new migration adds the two columns to `songs`, plus a `CHECK ((parent_song_id IS NULL) = (derivation_kind IS NULL))` invariant so seed Songs and derived Songs are distinguishable by either column alone.
- The worker (`server/jobs.ts`) populates these columns when finishing any non-`generate` job. `generate` (seed) jobs leave both NULL.
- Legacy Songs (created before this migration) keep both columns NULL and are treated as seeds on the canvas — no backfill required.
- `derivation_kind`'s `CHECK` constraint starts at `('repaint', 'lego')` and will be widened when `cover` / `extract` / `complete` are added as new `jobs.kind` values.
