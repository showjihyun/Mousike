# TODOS

Deferred follow-up work. Each entry should carry enough context that someone
picking it up in 3 months understands the motivation, the current state, and
where to start.

## Async queue

### Thread queue position into Repaint/Lego modals

- **What:** Pass `onProgress` through `apiRepaint` / `apiLego` so the
  Repaint/Lego modal loading text reflects queue position the same way
  `App.tsx:generate()` already does for the main generate flow.
- **Why:** A Pro user kicking off a 3-min repaint behind a queue currently
  sees a plain modal spinner with no feedback. The main generate flow
  shows "N명 앞에 대기 중…" via `loadingMsg`; repaint/lego should match.
- **Pros:** Same UX guarantee across all three job kinds. Cheap — the
  plumbing (`onProgress` callback, `BackendSong` poll loop) already
  exists in `src/api.ts`.
- **Cons:** Touches `RepaintModal` and `LegoModal` props + their
  internal loading state.
- **Context:** Captured in `docs/async-queue.md` §8 as "Cheap to thread
  a `loadingMsg` prop through `RepaintModal` / `LegoModal` when wanted."
  Callsites: `src/App.tsx:500` (apiRepaint) and `src/App.tsx:547`
  (apiLego) — neither passes an `onProgress` callback today.
- **Depends on / blocked by:** None.
