# Vocal language is a separate field from prompt language

When adding Korean singing support, we considered renaming/expanding the existing `lang: "KO" | "EN"` field — which today flags the *input prompt's language* and triggers KO→EN translation — to also govern the model's vocal output. We rejected that and introduced `vocalLanguage: "auto" | "KO" | "EN"` as a distinct field. Reason: a Korean user typing a Korean prompt may still want English-style vocals (and vice versa); collapsing the two would remove that affordance and create a misleading single control that means two unrelated things.

## Considered Options

- **Rename `lang` to govern both** — rejected: removes the cross-axis affordance.
- **Derive `vocalLanguage` from `lang` + genre, no UI control** — rejected: when the auto-derived value is wrong, the user has no escape hatch short of editing the prompt to game the genre detector.
- **Keep them separate (chosen)** — pays a small terminology cost (two language-ish fields in code and UI) in exchange for orthogonal control. The two controls are placed in deliberately separated UI regions (`composer-actions` vs `composer-meta`) to keep the distinction legible.

## Consequences

- Code and DB carry both fields. `jobs.payload` always has both; `songs.vocal_language` is a dedicated column.
- The UI must be careful not to render the two controls adjacent to each other, since "language" is the lossy short label for both.
- A future "unify under a single Language picker" refactor remains possible if real users prove the cross-axis case doesn't exist — but should be driven by usage data, not aesthetic preference.
