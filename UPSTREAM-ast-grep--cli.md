# UPSTREAM-ast-grep--cli

Tracking friction with [@ast-grep/cli](https://github.com/ast-grep/ast-grep) — the
structural-search engine this package's rules run under and are tested with via
`ast-grep test`.

## Feature Requests

_No entries yet._

## Bugs

- **0.45.0 `Smart` strictness skips comment/extra nodes for metavariable binding,
  breaking `pattern: $C` + `kind: comment`** (2026-07-27) \[regression\] — ast-grep
  0.45.0 deliberately made `Smart` strictness (the default for `pattern:`) ignore
  comment/extra nodes. The intent was structural: so `$A($B)` matches
  `foo(/* before */ bar /* after */)` without the comment interfering. The
  unintended side effect: a **bare metavariable pattern** (`pattern: $COMMENT`)
  combined with `kind: comment` no longer binds to comment nodes at all —
  `Smart` now *actively skips* extra nodes during metavariable binding.

  **Detection still works** — `kind: comment` routes through `KindMatcher`, which
  bypasses strictness, so the rules still *find* the comments they flag. What broke
  is the `Pattern` matcher path: `Pattern::match_node_impl()` →
  `should_skip_cand_for_metavar(candidate)` → returns `SkipCandidate` for comment
  nodes under `Smart` → match fails. So a rule that needs to *bind* the matched
  comment text to a metavariable (for `transform`-based message interpolation, or
  for a `fix:`) can no longer do so.

  **Three rules in this package were affected** (full per-rule impact in
  [`COMPAT-FIX-0-45.md`](./COMPAT-FIX-0-45.md)):

  | rule | lost |
  |------|------|
  | `no-jsdoc-any-type` | `$TAG` interpolation in `message` (which JSDoc tag carried `any`) |
  | `no-jsdoc-object-typedef` | `$NAME` interpolation in `message` **and** its `fix:` (the `{object}`-stripping auto-fix) |
  | `no-inline-jsdoc-import` | `$MOD`/`$TYP` interpolation in `message` (which module + type was imported inline) |

  All three were adapted to **Solution A** (graceful degradation): `pattern` /
  `transform` / `fix` removed, messages made static, `no-jsdoc-object-typedef`
  downgraded to `autofixable: false` / `applyMode: manual`. `ast-grep test` passes
  on 0.45.0 with the regenerated snapshot. Confirmed on 0.44.1 → 0.45.0:
  identical rule YAMLs pass on 0.44.1 and fail on 0.45.0 (the regression is wholly
  in the engine, not the rules).

  **Root cause — three commits in `crates/core/src/match_tree/strictness.rs`:**

  1. `ada747d0` — *"fix: make smart strictness ignore comment by default"* — the
     breaking change. `Smart` moved from the "don't skip comments" group to the
     "do skip comments" group in `should_skip_comment()`:
     ```rust
     // 0.44.1                              0.45.0
     M::Cst | M::Smart | M::Ast => false  →  M::Cst | M::Ast => false
     M::Relaxed | ... => true             →  M::Smart | M::Relaxed | ... => true
     ```
     The commit test documents it explicitly: `// smart now ignores comments by default`.
  2. `b358c284` — *"fix: unify skip metavar / skip comment"* — compounds it.
     `should_skip_cand_for_metavar()` was simplified to delegate to
     `should_skip_comment()`. In 0.44.1 `Smart` had an **explicit `false`** here
     (metavars could *always* bind, including to comments); in 0.45.0 it delegates
     to `should_skip_comment()`, which now returns `true` for `Smart`, so comment
     nodes are **skipped** during metavar binding.
  3. `a18c29c8` — *"fix: use is_extra instead of comment heuristic"* — changes
     *what* counts as a comment: `skip_comment()` went from
     `n.kind().contains("comment")` to `n.is_extra()`.

  **Why `strictness: cst` does not work around it.** `Cst` strictness does NOT skip
  comments, but `strictness` is only valid inside the pattern object form
  (`pattern: {context, selector, strictness}`) — not at the rule level, not in
  `constraints`, not for bare string patterns like `pattern: $C`. The pattern
  object form can't bind metavariables to comments anyway (comments are atomic
  leaf nodes in tree-sitter — no sub-nodes to bind to). So `strictness: cst` is
  not a viable workaround without an upstream change.

  Severity: regression (lost auto-fix + dynamic message content; detection
  intact) · Ownership: upstream (ast-grep 0.45.0) · Workaround: **partial, in
  place** — Solution A degrades the three rules to static-message detection (and
  manual edit for object-typedef); full capability returns if/when upstream
  restores comment-metavariable binding, at which point the `transform`/`fix`
  form documented in [`COMPAT-FIX-0-45.md`](./COMPAT-FIX-0-45.md) is reinstated.

  <details>
  <summary><strong>Drafted GitHub issue — NOT FILED.</strong> Paste-ready; filing needs an explicit go-ahead.</summary>

  **Title:** `[BUG] Smart strictness (0.45.0) skips comment/extra nodes for metavariable binding, breaking pattern: $C + kind: comment`

  **Body:**

  ````markdown
  ### Summary

  ast-grep 0.45.0 made `Smart` strictness (the default for `pattern:`) skip
  comment/extra nodes. This was intentional for *structural* matching (so
  `$A($B)` matches `foo(/* before */ bar)` without the comment interfering), but
  it has an unintended side effect: a **bare metavariable pattern**
  (`pattern: $COMMENT`) combined with `kind: comment` no longer binds to comment
  nodes at all.

  ### Repro

  Passes on 0.44.1, fails on 0.45.0:

  ```yaml
  language: JavaScript
  rule:
    kind: comment
    pattern: $C
  ```

  ### Root cause — three commits in `crates/core/src/match_tree/strictness.rs`

  1. `ada747d0` — *"fix: make smart strictness ignore comment by default"* — moved
     `Smart` from the "don't skip comments" group to the "do skip comments" group
     in `should_skip_comment()`.
  2. `b358c284` — *"fix: unify skip metavar / skip comment"* —
     `should_skip_cand_for_metavar()` was simplified to delegate to
     `should_skip_comment()`. In 0.44.1 `Smart` had an **explicit `false`** here
     (metavars could always bind, including to comments); in 0.45.0 it returns
     `true` for `Smart`, so comment nodes are skipped during metavar binding.
  3. `a18c29c8` — *"fix: use is_extra instead of comment heuristic"* —
     `skip_comment()` changed from `n.kind().contains("comment")` to `n.is_extra()`.

  The breaking path:

  ```rust
  // match_node.rs
  P::MetaVar { meta_var, .. } => {
      if strictness.should_skip_cand_for_metavar(candidate) {
          return MatchOneNode::SkipCandidate;  // ← comment nodes hit this under Smart in 0.45.0
      }
      match agg.match_meta_var(meta_var, candidate) { ... }
  }
  ```

  ```rust
  // strictness.rs — 0.44.1
  fn should_skip_cand_for_metavar(&self, candidate: &Node) -> bool {
      match self {
          M::Cst | M::Ast | M::Smart => false,  // Smart: NEVER skip
          M::Relaxed | M::Signature | M::Template => skip_comment(candidate),
      }
  }

  // strictness.rs — 0.45.0
  fn should_skip_cand_for_metavar(&self, candidate: &Node) -> bool {
      self.should_skip_comment() && skip_comment(candidate)
      // Smart now delegates to should_skip_comment() which returns true → SKIPS
  }
  ```

  `KindMatcher` bypasses strictness (so `kind: comment` still *finds* comments),
  but the `Pattern` matcher routes through `MatchStrictness` and is blocked for
  comment/extra nodes under `Smart`.

  The 0.45.0 test suite documents this as intentional:
  ```rust
  #[test]
  fn test_smart_match() {
      // smart now ignores comments by default
      matched("$A($B)", "foo(/* before */ bar /* after */)", M::Smart);
  }
  ```
  but the unintended consequence is that a bare metavariable pattern (`$COMMENT`)
  used with `kind: comment` no longer works at all.

  ### Why `strictness: cst` doesn't work around it

  `Cst` strictness does NOT skip comments, but `strictness` is only valid inside
  the pattern object form (`pattern: {context, selector, strictness}`) — not at
  the rule level, not in `constraints`, not for bare string patterns. The pattern
  object form can't bind metavariables to comments anyway (comments are atomic
  leaf nodes in tree-sitter — no sub-nodes to bind to). So there is currently no
  way to bind a metavariable to a comment node in 0.45.0.

  ### Suggested fixes (any one resolves it)

  1. Add `strictness` as a valid rule-level / constraint field (not just the
     pattern object form).
  2. Revert `should_skip_cand_for_metavar()` so `Smart` doesn't skip metavariable
     binding for extra nodes, while still skipping comments for *structural*
     pattern matching. (Least invasive — preserves the intended
     `$A($B)`-ignores-comments behavior for structural patterns while restoring
     bare-metavar binding.)
  3. Add an implicit `$0` metavariable that binds to the full matched node text.

  ###### Environment

  - `@ast-grep/cli` 0.45.0 (also measured 0.44.1 — passes there)
  - language: JavaScript (tree-sitter), but the path is language-agnostic
  ````

  </details>

## Upstream Opportunities

_No entries yet._

## Notes

- **Nothing is filed upstream yet.** The drafted issue above is paste-ready but
  is **not** filed; filing needs an explicit go-ahead. Recommended fix to lead
  with upstream is option **#2** (least invasive — preserves the intended
  structural behavior while restoring bare-metavar binding), with **#1**
  (rule-level `strictness`) as the broader enabler.
- **The full root-cause analysis lives in [`COMPAT-FIX-0-45.md`](./COMPAT-FIX-0-45.md)** —
  the exact `should_skip_cand_for_metavar` code path, a tried-and-rejected matrix
  of workarounds (`all:` composition, `regex` capture groups, `$0`/`$$VAR`,
  pattern-object `strictness: cst`), and the revert path (re-instate the
  `transform`/`fix` form once upstream restores comment-metavariable binding).
  This file is the durable tracker entry; that one is the working findings doc.
- **Cross-project convergence before filing:** the sibling tracker at
  [`voxpelli/claude-beads`](https://github.com/voxpelli/claude-beads)’s
  `UPSTREAM-ast-grep--cli.md` tracks a *different class* of ast-grep friction
  (the `ast-grep test` / `ast-grep scan` exit-code gaps: no `--strict` coverage
  mode; a non-existent scan-path exits 0). That class is process exit status;
  this entry is match-tree metavariable binding — the two are **not duplicates**,
  but if both are filed, cross-link them so the ast-grep maintainers see both
  friction surfaces together.