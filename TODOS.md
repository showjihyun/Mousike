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

### F1 (HIGH) — Mobile primary CTA "곡 만들기" is invisible

The submit button lives inside the prompt input on desktop and collapses out
of frame at 375px. Mobile users can type a prompt but have no visible way to
submit it. Either move the button below the input on mobile, or render it
as a sticky bottom bar. Touch: `src/pages/HomePage.tsx`, `styles.css`
(`.generate-btn` + the prompt-input layout).

### F2 (HIGH) — Mobile top-nav text wraps mid-character

"로그인" stacks as 로/그/인, "업그레이드" wraps as 업그레/이드, "오늘 3/3"
stacks 오/늘. F15 fixed the touch target heights but not the wrapping.
Either add `white-space: nowrap` + horizontal scroll, or restructure into
icon-only buttons on mobile. Touch: `styles.css` `.topright .btn-primary`,
`.btn-ghost`, `.credit-pill`, `.lang-toggle`.

### F3 (HIGH) — Mobile primary nav vanishes with no hamburger

`.topnav { display: none; }` in the ≤760px media query hides 탐험 / 내
라이브러리 / 도움말 with no alternative surface. Add a hamburger that
opens a drawer, OR a bottom-nav bar with the primary actions. Touch:
`src/components/Topbar.tsx` (or wherever topnav lives), `styles.css`
media query.

### F4 (HIGH) — Blue "업그레이드" outshines primary "곡 만들기" CTA

Top-right blue solid pulls more attention than the actual hero CTA. Either
demote 업그레이드 to ghost/outline, or promote 곡 만들기 to a brand-color
fill that beats it. Touch: `styles.css` `.btn-primary` (specifically the
top-bar instance) or apply a more restrained variant.

### F6 (HIGH) — Quick-start grid is the AI-slop 3-column feature grid

Two rows of three cards with soft-tinted icon + bold title + 2-line
subtitle. Replace with a single-row chip strip ("차분한 카페 · 집중 공부 ·
영상 BGM · 잠들기 · 드라이브 · 운동"), or merge with the prompt
placeholder rotation. Touch: `src/pages/HomePage.tsx` `.preset-grid`.

### F7 (HIGH) — Help button "도움말" is a dead-end toast

Fires "도움말은 아직 준비 중이에요!". A primary nav item that promises
content and delivers "soon" drains goodwill. Either hide until ready,
swap for a single FAQ modal, or replace with an onboarding tour.
Touch: `src/components/Topbar.tsx` + decide on real help surface.

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
