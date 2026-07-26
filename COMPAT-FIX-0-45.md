# ast-grep 0.45.0 Compatibility Fix — Findings & Solutions

## Status

- **Confirmed regression**: Tests pass on 0.44.1, fail on 0.45.0 (3/3 rules)
- **Root cause identified**: `Smart` strictness now skips comment nodes for metavariable binding
- **Workaround implemented**: Rules rewritten without `pattern: $C` / `transform` / dynamic `fix`
- **Upstream issue**: Needs filing against ast-grep/ast-grep

## Thesis

**ast-grep 0.45.0 intentionally made `Smart` strictness (the default for `pattern:`)
ignore comment/extra nodes. This broke the ability to bind metavariables to comment
nodes via `pattern: $C` + `kind: comment`, which three rules in this project relied on
for `transform`-based message interpolation and auto-fix. The change was deliberate
(making `$A($B)` match `foo(/* before */ bar)` without the comment interfering) but
had an unintended side effect: bare metavariable patterns can no longer match comment
odes at all, because `Smart` now actively skips extra nodes during metavariable binding.**

### Root cause — three commits in `strictness.rs`

The 0.45.0 release includes three commits to `crates/core/src/match_tree/strictness.rs`,
all part of issue #2821 (extending `strictness: relaxed` to ignore Python line
continuations):

1. **`ada747d0` — "fix: make smart strictness ignore comment by default"** — THE breaking
   change. `Smart` was moved from the "don't skip comments" group to the "do skip
   comments" group in `should_skip_comment()`:
   ```rust
   // 0.44.1                          0.45.0
   M::Cst | M::Smart | M::Ast => false  →  M::Cst | M::Ast => false
   M::Relaxed | ... => true           →  M::Smart | M::Relaxed | ... => true
   ```
   The commit test explicitly documents this: `// smart now ignores comments by default`.

2. **`b358c284` — "fix: unify skip metavar / skip comment"** — compounds the issue.
   `should_skip_cand_for_metavar()` was simplified to delegate to `should_skip_comment()`:
   ```rust
   // 0.44.1                                      0.45.0
   match self {                                     self.should_skip_comment()
     M::Cst | M::Ast | M::Smart => false,    &&      && skip_comment(candidate)
     M::Relaxed | ... => skip_comment(candidate),
   }
   ```
   In 0.44.1, `Smart` had an **explicit `false`** — metavars could ALWAYS bind to any
   node, including comments. In 0.45.0, this delegates to `should_skip_comment()`,
   which now returns `true` for `Smart`, causing comment nodes to be **skipped** when a
   metavariable tries to bind to them.

3. **`a18c29c8` — "fix: use is_extra instead of comment heuristic"** — changes WHAT is
   considered a comment. `skip_comment()` changed from `n.kind().contains("comment")`
   to `n.is_extra()`, generalizing from string matching to tree-sitter's native API.

### The exact code path that breaks

When a rule has `pattern: $COMMENT` + `kind: comment`:

1. `KindMatcher` finds comment nodes (raw `kind_id` comparison — no strictness involved)
2. `Pattern::match_node_impl()` tries to bind `$COMMENT` to the comment node
3. Calls `strictness.should_skip_cand_for_metavar(candidate)`
4. **0.44.1**: `Smart` → `false` → proceeds to `match_meta_var` → **binds** → match ✓
5. **0.45.0**: `Smart` → `true` (because `should_skip_comment()` is `true` for `Smart`
   and `skip_comment(candidate)` is `true` because comment `is_extra()`) → returns
   `SkipCandidate` → match **fails** ✗

### Why `strictness: cst` doesn't fix it

`Cst` strictness does NOT skip comments (`should_skip_comment()` returns `false`).
But `strictness` is ONLY available inside the pattern object form
(`pattern: {context, selector, strictness}`) — not at the rule level, not in
`constraints`, not for bare string patterns like `pattern: $C`. The pattern object
form can't bind metavariables to comments anyway because comments are atomic leaf
nodes in tree-sitter (no sub-nodes to bind to). So `strictness: cst` is not a viable
workaround without upstream changes to ast-grep.

### Why this is hard to work around

- Comments are tree-sitter "extra" nodes — present in the tree but not children of
  any normal AST node
- `KindMatcher` bypasses strictness → can find comments
- `Pattern` matcher routes through strictness → blocked for comments under `Smart`
- `all:` evaluates sub-rules on the SAME node — KindMatcher matches, Pattern doesn't
- `regex` can match comment text but creates no metavariables
- `transform` requires a pre-bound metavariable as `source` — no implicit `$0`
- Pattern object form can't bind metavars inside comment text (atomic leaf nodes)
- There is no mechanism in ast-grep 0.45.0 to bind a metavariable to a comment node

### What was lost

| Rule | Lost capability |
|------|----------------|
| `no-jsdoc-any-type` | `$TAG` in message (which JSDoc tag carried the `any`) |
| `no-jsdoc-object-typedef` | `$NAME` in message + **auto-fix** (removed `{object}` from comment) |
| `no-inline-jsdoc-import` | `$MOD`/`$TYP` in message (which module + type was imported inline) |

### What still works

All three rules still **detect** the patterns they're supposed to flag. They just
can't interpolate dynamic content into their messages, and `no-jsdoc-object-typedef`
lost its auto-fix capability. The rules remain useful as lint warnings — they just
provide less context in the diagnostic message.

### Recommended upstream fix

File an issue at `ast-grep/ast-grep` suggesting one of:
1. Add `strictness` as a valid field at the rule level (not just pattern object form)
2. Add a `strictness` option for bare string patterns
3. Revert the `should_skip_cand_for_metavar()` change so `Smart` doesn't skip
   metavariable binding for extra nodes (while still skipping comments for
   structural pattern matching)
4. Add an implicit `$0` metavariable that binds to the full matched node text

### The exact code path (ast-grep source)

```rust
// match_node.rs
P::MetaVar { meta_var, .. } => {
    if strictness.should_skip_cand_for_metavar(candidate) {
        return MatchOneNode::SkipCandidate;  // ← THIS IS THE BREAKING PATH
    }
    match agg.match_meta_var(meta_var, candidate) {
        Some(()) => MatchOneNode::MatchedBoth,
        None => MatchOneNode::NoMatch,
    }
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

```rust
// strictness.rs — 0.44.1
fn should_skip_comment(&self) -> bool {
    match self {
        M::Cst | M::Smart | M::Ast => false,  // Smart does NOT skip comments
        M::Relaxed | M::Signature | M::Template => true,
    }
}

// strictness.rs — 0.45.0
fn should_skip_comment(&self) -> bool {
    match self {
        M::Cst | M::Ast => false,             // Smart now SKIPS comments
        M::Smart | M::Relaxed | M::Signature | M::Template => true,
    }
}
```

The 0.45.0 test suite documents this as intentional:
```rust
#[test]
fn test_smart_match() {
    // smart now ignores comments by default
    matched("$A($B)", "foo(/* before */ bar /* after */)", M::Smart);
}
```

But the unintended consequence: a **bare metavariable pattern** (`$COMMENT`) used with
**`kind: comment`** no longer works at all — `Smart` strictness actively skips comment/extra
nodes when trying to bind them to metavariables.

## What Works / What Doesn't in 0.45.0

| Approach | Match? | Metavariable? | Fix? |
|---|---|---|---|
| `kind: comment` alone | ✅ | N/A | N/A |
| `kind: comment` + `regex` | ✅ | N/A | ✅ (static) |
| `kind: comment` + `pattern: $C` | ❌ | — | — |
| `all: [kind: comment, pattern: $C]` | ❌ | — | — |
| `all: [kind: comment, pattern: $C, regex]` | ❌ | — | — |
| `pattern: {context, selector: comment}` | ✅ | ❌ (empty) | — |
| `kind: comment` + `regex` + `$0` in fix | ✅ | ❌ (`$0` undefined) | — |
| `kind: program` + `has: {kind: comment}` | ✅ | N/A | ❌ (replaces program) |
| `kind: comment` + `regex` + static `fix` | ✅ | N/A | ✅ (static only) |
| `strictness: cst` + `pattern: $C` + `kind: comment` | ❌ | — | — | `strictness` not valid at rule level; pattern object form can't bind metavars to comments |

### ~~Untested: `strictness: cst`~~ — TESTED, DOESN'T WORK

`strictness` is only valid inside the pattern object form (`pattern: {context, selector, strictness}`).
While `Cst` strictness doesn't skip comments in the source code, there's no way to
apply it to a bare string pattern like `pattern: $C`. The pattern object form
can't bind metavariables to comment nodes because comments are atomic leaf nodes
in tree-sitter (no sub-nodes to bind to).

## Attempted Solutions

### Solution A (Current): Remove `pattern`/`transform`/`fix` — degrade gracefully

- Drop `pattern: $C` from all three rules
- Drop `transform` (no source metavariable)
- Drop `fix` from `no-jsdoc-object-typedef` (can't reconstruct comment text)
- Static messages (lose `$TAG`/`$NAME`/`$MOD`/`$TYP` interpolation)
- `metadata.autofixable: false` for `no-jsdoc-object-typedef` (was `true`)

**Pros**: Works immediately, simple
**Cons**: Loses dynamic message content, loses auto-fix, significant functionality regression

### Solution B (TESTED, DOESN'T WORK): Use `strictness: cst`

- `strictness` is ONLY available inside the pattern object form: `pattern: {context, selector, strictness}`
- It is NOT valid at the rule level, in `constraints`, or in `utils`
- The pattern object form can't bind metavariables to comments (atomic leaf nodes)
- Therefore, `strictness: cst` cannot fix the bare metavariable pattern `pattern: $C`
- Would need ast-grep to add support for strictness on bare string patterns or a global config

**Status**: ❌ Tested and rejected — not viable without upstream changes

### Solution C: Pin to 0.44.1 — temporary freeze

- Pin `@ast-grep/cli` to `0.44.1` in package.json
- Wait for upstream fix

**Pros**: Zero code changes, full functionality
**Cons**: Can't use 0.45.0 features/fixes

### Solution D: File upstream bug + use Solution A temporarily

- File issue against ast-grep/ast-grep with the root cause analysis
- Implement Solution A as temporary workaround
- Revert to original rules when upstream fixes the regression

## Research Agents — Complete Findings

### Agent 1: Source code changes ✅ Found exact root cause

The file `crates/core/src/match_tree/strictness.rs` has **two distinct changes** that
together cause the regression:

1. `skip_comment()` changed from `n.kind().contains("comment")` to `n.is_extra()`
2. `Smart` strictness moved from "don't skip comments" to "do skip comments" group
3. `should_skip_cand_for_metavar()` simplified to delegate to `should_skip_comment()`

The exact code path: `Pattern::match_node_impl()` → `should_skip_cand_for_metavar()`
→ returns `SkipCandidate` for comment nodes under `Smart` strictness → match fails.

### Agent 2: GitHub issues search ✅ No existing reports

- The ast-grep FAQ documents that `kind` + `pattern` generally don't work together
- But this is about non-metavariable patterns (e.g., `pattern: console.log($ARG)` + `kind: call_expression`)
- Our case (bare metavariable `$C` + `kind: comment`) was a special case that worked in 0.44.1
- 0.45.0 is extremely new (~hours old), nobody has reported the regression yet
- No discussions about extra nodes, comment metavariable binding, or tree-sitter extras

### Agent 3: Tree-sitter extra nodes ✅ Architectural analysis

- Comments are both `named` AND `extra` in tree-sitter
- `KindMatcher` bypasses the strictness system → works for comments
- `Pattern` matcher routes through `MatchStrictness` → blocked by `should_skip_cand_for_metavar()`
- `cst` and `ast` strictness DON'T skip comments, but `strictness` is only
  available in the pattern object form, not for bare string patterns
- `all:` evaluates sub-rules on the SAME node — KindMatcher matches, Pattern doesn't

### Agent 4: Alternative approaches ✅ No workaround found

- No mechanism in ast-grep 0.45.0 to bind a metavariable to comment text
- Comments are leaf nodes — no sub-nodes for metavariables to bind to
- `regex` atomic rule does NOT support capture groups as metavariables
- `$0`, `$1` are undefined metavariables
- Pattern object form can't bind metavariables inside comment text (atomic nodes)
- `transform` requires a pre-bound metavariable as `source` — no implicit `$0`
- `$$VAR` (double-dollar for unnamed nodes) doesn't help — comments ARE named nodes
- Recommended: use ast-grep for finding, external script for transforming
- Or use `@ast-grep/napi` for programmatic control

### Agent 5: Changelog/breaking changes ✅ Three commits identified

The 0.45.0 release does NOT label this as a breaking change. Three commits in
`strictness.rs`:

1. **`ada747d0`** — "fix: make smart strictness ignore comment by default" — THE breaking change
   - `Smart` moved from "don't skip" to "do skip" group in `should_skip_comment()`
2. **`b358c284`** — "fix: unify skip metavar / skip comment"
   - `should_skip_cand_for_metavar()` now delegates to `should_skip_comment()`
3. **`a18c29c8`** — "fix: use is_extra instead of comment heuristic"
   - `skip_comment()` changed from `n.kind().contains("comment")` to `n.is_extra()`

The commit message says "fix: make smart strictness ignore comment by default" —
this was an intentional behavior change, not an accident. The test comment says:
```rust
// smart now ignores comments by default
```

The intent was to make `Smart` mode ignore comments in patterns like `$A($B)` matching
`foo(/* before */ bar /* after */)`. But the side effect is that bare metavariable
patterns (`$COMMENT`) combined with `kind: comment` no longer work at all.

### `strictness: cst` workaround — TESTED, DOESN'T WORK

Multiple agents suggested `strictness: cst` as a workaround. Testing showed:
- `strictness` is ONLY valid inside the pattern object form: `pattern: {context, selector, strictness}`
- It is NOT valid at the rule level, in `constraints`, or in `utils`
- The pattern object form can't bind metavariables to comments (comments are atomic leaf nodes)
- Therefore, `strictness: cst` cannot fix the bare metavariable pattern `pattern: $C`

The only way to use `strictness: cst` would be if ast-grep added support for setting
strictness on bare string patterns, or if there was a global default strictness config.

## Rule-by-Rule Impact

### `no-jsdoc-any-type` (detection only, no fix)
- **Before**: `pattern: $COMMENT` + `kind: comment` + `regex` + `transform.TAG` → message with `$TAG`
- **After (Sol A)**: `kind: comment` + `regex` → static message (loses `$TAG`)
- **After (Sol B)**: Add `strictness: cst` → keep everything

### `no-jsdoc-object-typedef` (was auto-fixable)
- **Before**: `pattern: $COMMENT` + `kind: comment` + `regex` + `transform.FIXED` + `transform.NAME` + `fix: $FIXED`
- **After (Sol A)**: `kind: comment` + `regex` → static message, NO fix (loses auto-fix + `$NAME`)
- **After (Sol B)**: Add `strictness: cst` → keep everything

### `no-inline-jsdoc-import` (detection only, no fix)
- **Before**: `all: [pattern: $C, kind: comment, regex, not, not]` + `transform.MOD` + `transform.TYP` → message with `$MOD`/`$TYP`
- **After (Sol A)**: `all: [kind: comment, regex, not, not]` → static message (loses `$MOD`/`$TYP`)
- **After (Sol B)**: Add `strictness: cst` to pattern → keep everything