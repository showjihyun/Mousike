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

## Design (deferred from /design-review 2026-05-21)

Full report: `~/.gstack/projects/showjihyun-Mousike/designs/design-audit-20260521/design-audit-localhost.md`

### ~~F1 (HIGH) — Mobile primary CTA "곡 만들기" is invisible~~

**Fixed by /design-review on main, 2026-05-21 (commit `a8649b5`).** The
composer-box now stacks vertically at ≤760px so KO + 곡 만들기 share a
bottom row, with the CTA flex-growing.

### ~~F2 (HIGH) — Mobile top-nav text wraps mid-character~~

**Fixed by /design-review on main, 2026-05-21 (commit `66410cd`).** Added
`white-space: nowrap` to all top-bar interactive elements at ≤760px, plus
tightened gap and padding so 4 chips fit at 375px.

### F3 (HIGH) — Mobile primary nav vanishes with no hamburger

`.topnav { display: none; }` in the ≤760px media query hides 탐험 / 내
라이브러리 with no alternative surface (도움말 is now removed entirely per
F7). Add a hamburger that opens a drawer, OR a bottom-nav bar with the
primary actions. Touch: `src/components/Topbar.tsx` (or new
`MobileDrawer.tsx`), `styles.css` media query. Deferred from /design-review
2026-05-21 round 2 — risk budget would have spilled mid-build.

### ~~F4 (HIGH) — Blue "업그레이드" outshines primary "곡 만들기" CTA~~

**Fixed by /design-review on main, 2026-05-21 (commit `0bd4907`).**
Top-bar 업그레이드 now uses a new `.btn-upgrade-top` class — brand-purple
tinted background + thin border — instead of `.btn-primary` solid blue.
Modal Pay button keeps `.btn-primary` since "결제하기" IS the primary
action in that context.

### F6 (HIGH) — Quick-start grid is the AI-slop 3-column feature grid

Two rows of three cards with soft-tinted icon + bold title + 2-line
subtitle. Replace with a single-row chip strip ("차분한 카페 · 집중 공부 ·
영상 BGM · 잠들기 · 드라이브 · 운동"), or merge with the prompt
placeholder rotation. Touch: `src/pages/HomePage.tsx` `.preset-grid`.

### ~~F7 (HIGH) — Help button "도움말" is a dead-end toast~~

**Fixed by /design-review on main, 2026-05-21 (commit `b13b705`).** Removed
the 도움말 button from the topnav entirely, dropped `onHelp` from
`TopbarProps`, and removed the placeholder handler from `App.tsx`. When
real help content lands (FAQ modal, onboarding tour, docs page), add the
button back wired to a real surface.

### F9 (MEDIUM) — "로그인" instant-redirects to Google OAuth

No app-side preview. Add a 1-screen "What is Mousike + sign in with
Google" intermediate (matches the same flow's modal for repaint/lego
auth gates). Touch: `src/components/LoginModal.tsx` + Topbar handler.

### F10 (MEDIUM) — Three different primary-button styles

Blue-filled (top-nav 업그레이드), black-filled (곡 만들기, 결제하기),
outline (닫기, disabled). Pick one primary style. The "important paid
action" (결제하기) should match the "go upgrade" CTA visually since
they're the same flow. Touch: `styles.css` `.btn-primary`,
`.generate-btn`, `.plan-buy-btn`.

### F11 (MEDIUM) — 현금영수증 mixed into plan comparison modal

Move tax-receipt config to a checkout step AFTER tier selection. Mixes
"deciding" with "configuring". Touch:
`src/components/UpgradeModal.tsx`, possibly split modal into two stages.

### F14 (MEDIUM) — H2 skipped in heading hierarchy

Only H1 (52px) and H3 (20px) exist on landing. Either upgrade "빠른 시작"
/ "오늘 가장 많이 들은 음악" to H2, or downgrade H1 to remove the gap.
Touch: `src/pages/HomePage.tsx`.

### F17 (MEDIUM) — Toast lifetime overlaps subsequent actions

Observed: a "Failed to fetch" toast still visible 4+ seconds later when
the user clicked a quick-start card. Either shorten TOAST_MS, or dismiss
the previous toast when a new action is taken. Touch:
`src/App.tsx` `showToast` / `TOAST_MS`.

### F18 (MEDIUM) — No search box on landing

For an app where users accumulate generations, a top-bar search is the
natural element. Trunk test fails on this. Touch: `src/components/Topbar.tsx`
+ search route + library filter integration.

### F19 (POLISH) — Trending card decorative gradients

"여름 카페 오후" / "새벽 코딩 BGM" / "한강 드라이브" / "ASMR 빗소리" use
solid color-block gradients as placeholder art. Generate per-song
thumbnails (waveform peek, key chord, BPM glyph) or constrain to one
gradient with the song title doing the work. Touch:
`src/components/PopularRow.tsx`.

### F21 (POLISH) — Free tier column has empty bottom space

Add "현재 플랜" chip or balance heights with a placeholder. Touch:
`src/components/UpgradeModal.tsx` plan card render.

### F22 (POLISH) — Single typeface family is generic for a brand-forward hero

NotionInter/Inter on the "potentially generic" list. Pair with a display
typeface for the hero (Korean serif or expressive sans). Two typefaces
max. Touch: `styles.css` `--font-family-display`, `index.html` font links.

### F23 (POLISH) — No footer anywhere

Add a minimal footer: brand, copyright, terms/privacy, contact. Touch:
new `src/components/Footer.tsx`.

### F24 (POLISH) — `prefers-reduced-motion` respect not verified

Spot-check CSS for any unconditional animations and add a
`@media (prefers-reduced-motion: reduce)` block that disables them.
Touch: `styles.css`, `src/animations.css`.
