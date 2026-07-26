# @voxpelli/ast-grep-rules

**EXPERIMENTAL** staged extraction of the portable, project-authored
[ast-grep](https://ast-grep.github.io/) JSDoc/ESM lint rules.

The rules encode house conventions shared across the voxpelli siblings:
JSDoc-typed JavaScript, ESM-only, prefer `unknown` over `any`. They are the
narrow, cross-repo-agreed slice.

It also ships one optional Claude Code
sweep workflow under `workflows/` (an example script, not gated — see
[Applying these rules with an AI agent](#applying-these-rules-with-an-ai-agent)).

## Rules

| id | severity | catches | auto-fixable |
|----|----------|---------|--------------|
| `no-jsdoc-object-typedef` | warning | `@typedef {object} Name` followed by `@property` tags | **yes** — a surgical [`transform`](https://ast-grep.github.io/reference/yaml.html#transform) strips just `{object} `; a node-local [`fix`](https://ast-grep.github.io/reference/yaml.html#fix) fully repairs it, so [`ast-grep scan --update-all`](https://ast-grep.github.io/reference/cli/scan.html) cleans it up |
| `no-jsdoc-any-type` | warning | `@param`/`@returns`/`@type`/`@property {any}` | **no** — the correct narrower type (`unknown`, a named type, a union) is context-specific; a machine can't pick it |
| `no-inline-jsdoc-import` | warning | inline `import('module').Type` at a **use-site** inside a **JSDoc block** (`/** … */` only — `//` and plain `/* … */` prose are ignored). **Excludes** `@typedef {import(...)}` (a type ALIAS / cross-module re-export — the inline import IS the definition) and a `x is import(...).T` type-predicate position (the hoisted `@import` doesn't resolve there on the TS/JSDoc toolchain) | **no** — a correct fix must BOTH rewrite the inline ref → bare `Type` AND add a top-level `/** @import { Type } from 'module' */`; ast-grep's fix is node-local (matched comment only) and can't insert the second edit, so rewriting alone would leave `Type` undefined. Hoist by hand |

Why the split matters: only `no-jsdoc-object-typedef` is a *single-location* transform, so it's the one wired for `--update-all`. The other two flag drift that needs a human decision (which narrower type) or a second, non-local edit (the hoisted `@import`) that ast-grep can't perform safely — so they stay report-only.

All three are `severity: warning` heuristics (house `SHOULD`s), so
`ast-grep scan` exits 0 on findings — they surface, they do not fail CI on their
own.

## Diagnostic structure — `message` / `note` / `metadata`

Each rule's diagnostic is authored as an **agent-executable instruction**, split
across three ast-grep fields ([rule config reference](https://ast-grep.github.io/reference/yaml.html))
with distinct jobs:

- **[`message`](https://ast-grep.github.io/reference/yaml.html#message)** — one
  line: *what* is wrong, with the concrete captured tokens interpolated
  (`$MOD`/`$TYP`, `$TAG`, `$NAME`). Rendered as the diagnostic headline. ast-grep
  interpolates `$`-vars here (fed via
  [`transform`](https://ast-grep.github.io/reference/yaml.html#transform)) — a
  regex named capture can't reach `message` directly, so it goes through
  `transform`.
- **[`note`](https://ast-grep.github.io/reference/yaml.html#note)** — multi-line
  markdown: the *ordered how-to-repair* (or, for the `any` rule, a decision
  tree). Rendered as the `= …` block beneath the message. Per the docs, `note`
  *"can contain markdown syntax, but it cannot reference meta-variables"* — so
  everything concrete stays in `message`; the note is the reusable procedure.
- **[`metadata`](https://ast-grep.github.io/reference/yaml.html#metadata)** —
  arbitrary machine-readable key/values, so a scout→apply harness can route a
  rule to a strategy **without parsing the prose**. ast-grep emits it in JSON
  output via
  [`ast-grep scan --json --include-metadata`](https://ast-grep.github.io/reference/cli/scan.html),
  so a harness reads the routing fields below straight from the scan result.

### `metadata` fields

Every rule carries the same five keys. Values are the options in use across this
package; the schema is open (ast-grep treats `metadata` as free-form), so a
consumer can add its own keys, but these five are the contract this package
documents:

| field | type | options | meaning |
|-------|------|---------|---------|
| `autofixable` | boolean | `true` · `false` | The rule has a [`fix:`](https://ast-grep.github.io/reference/yaml.html#fix) that fully repairs the finding node-locally, so [`ast-grep scan --update-all`](https://ast-grep.github.io/reference/cli/scan.html) (`-U`) is safe to run unattended. Only `no-jsdoc-object-typedef` is `true`. |
| `edits` | number \| string | `1` · `2` · `context-dependent` | How many source edits a correct fix takes. `2` means the second edit lands in a **different location** than the match — which is exactly why ast-grep can't autofix it. `context-dependent` = the count depends on how the flagged value is used. |
| `applyMode` | enum | `bulk` · `agent` · `judgment` | How to apply the fix. `bulk` = blind `--update-all`. `agent` = an LLM applies the deterministic recipe in `note`, then the `gate` verifies. `judgment` = needs genuine type judgment; the rule over-fires on legitimate cases the model must recognise and skip. |
| `cheapModelSafe` | boolean | `true` · `false` | Whether a cheap model (e.g. Haiku) applies the fix reliably **when gated by `gate`**. Calibrated from the pilot below — a measured value, not an aspiration. |
| `gate` | string | `tsc --noEmit` | The deterministic check that must pass after applying. This — not agent agreement — is what decides correctness; a wrong edit fails the gate. |

Per-rule values:

| rule | `autofixable` | `edits` | `applyMode` | `cheapModelSafe` | `gate` |
|------|---------------|---------|-------------|------------------|--------|
| `no-jsdoc-object-typedef` | `true` | `1` | `bulk` | `true` | `tsc --noEmit` |
| `no-inline-jsdoc-import` | `false` | `2` | `agent` | `true` | `tsc --noEmit` |
| `no-jsdoc-any-type` | `false` | `context-dependent` | `judgment` | `false` | `tsc --noEmit` |

## Applying these rules with an AI agent

These rules are designed so a **cheap model can apply the fix from the diagnostic
alone**, made safe by the `tsc` gate rather than by agent consensus. In ESLint's
vocabulary: `no-jsdoc-object-typedef` is a `fix` (mechanically safe); the other
two are `suggestion`-class — agent-in-the-loop, never a blind `--fix`.

**The `tsc` gate is the semantic backstop.** "Auto-fixable" is a *syntactic*
property: a structural detector (ast-grep, Semgrep) validates the *shape* of an
edit, not its *meaning*. `unknown` + narrow, gated by `tsc --noEmit`, is the
mechanism that makes cheap-model application safe — a semantically wrong edit
fails the gate even when it is syntactically valid.

**Two design laws** the `note`s follow (learned from applying the rules at scale):

1. **Tell the model that a downstream error can be the EXPECTED next step.**
   Hoisting an import, or swapping `any`→`unknown`, deliberately produces a tsc
   error at the next site — that error is the signal to add the second edit / the
   narrower, *not* to revert. Each `note` says so in as many words.
2. **Name the legitimate exceptions the rule over-fires on**, or the model
   mis-applies. `no-jsdoc-any-type`'s note names the two "leave it" cases: an
   untyped 3rd-party boundary value, and the `(...args: any[]) => any`
   top-function constraint (where `unknown[] => unknown` would reject typed
   handlers by contravariance).

### Calibrated cheap-model safety (pilot: 211 findings, 17 groupings)

| rule | raw cheap-model success | apply as |
|------|-------------------------|----------|
| `no-jsdoc-object-typedef` | 100% | blind `--update-all` |
| `no-inline-jsdoc-import` | ~99% | agent + `tsc` gate — the single miss was a duplicate `@import` (a TS2300), now pre-empted by the note's dedup instruction |
| `no-jsdoc-any-type` | ~4/9 | agent + gate, expect escalation to a stronger model — it is a judgment call, not a mechanical one |

The cliff falls exactly at the single-step → multi-step / judgment boundary: a
one-location mechanical fix is bulk-safe; a two-location but deterministic fix
needs an agent plus the gate; a fix that requires knowing what a value *is* needs
judgment and will need escalation.

**Detection-only is forced by ast-grep, not a defect.** ast-grep's `fix` edits a
single node range, so a repair that requires a second edit elsewhere (the hoisted
top-level `@import`) simply can't be expressed as a `fix` — hence
`no-inline-jsdoc-import` is report-only by construction, and the `note` carries
the recipe a human or agent runs instead.

### Reusable sweep workflow

`workflows/haiku-jsdoc-sweep.js` packages the above as a runnable Claude Code
Workflow script: **scout → apply → recover → escalate → verify**, one agent per
*grouping* (a module, or a
file-batched slice of a monolith split by an inline-import cap). A cheap-model
fleet applies the fixes from the diagnostics; a stronger model recovers
stragglers; the repo's own gate is the deterministic cross-check; the run returns
a capability scorecard. It is a documented example, not gated by this package's
`ast-grep test` — pass a repo's `root` / `moduleGlobs` / `gate` via the
Workflow tool's `args` (see the header of the file for the full arg reference).

## Consuming the rules

Point an [`sgconfig.yml`](https://ast-grep.github.io/reference/sgconfig.html)'s
[`ruleDirs`](https://ast-grep.github.io/reference/sgconfig.html#ruledirs) at this
package's `rules/` directory (or copy/vendor the individual `.yml` files). A
rule's own [`language:`](https://ast-grep.github.io/reference/yaml.html#language)
field scopes it to matching files automatically, so a single `ast-grep scan` over
your source runs each rule only against files of its declared language.

```yaml
# sgconfig.yml
ruleDirs:
  - node_modules/@voxpelli/ast-grep-rules/rules
```

The package's bundled `sgconfig.yml` +
[`rule-tests/`](https://ast-grep.github.io/guide/test-rule.html) are what
[`ast-grep test`](https://ast-grep.github.io/guide/test-rule.html) (the `check` /
`test:node` scripts) uses to prove each rule fires on a planted violation and
stays silent on the correct form — the ast-grep-native equivalent of a detector
self-test. The [`testConfigs`](https://ast-grep.github.io/reference/sgconfig.html#testconfigs)
in `sgconfig.yml` wires `rule-tests/` and its `__snapshots__/` together.

## ast-grep documentation

- [Rule config reference](https://ast-grep.github.io/reference/yaml.html) —
  [`message`](https://ast-grep.github.io/reference/yaml.html#message) ·
  [`note`](https://ast-grep.github.io/reference/yaml.html#note) ·
  [`metadata`](https://ast-grep.github.io/reference/yaml.html#metadata) ·
  [`severity`](https://ast-grep.github.io/reference/yaml.html#severity) ·
  [`transform`](https://ast-grep.github.io/reference/yaml.html#transform) ·
  [`fix`](https://ast-grep.github.io/reference/yaml.html#fix)
- [`ast-grep scan` CLI](https://ast-grep.github.io/reference/cli/scan.html) —
  `--update-all`/`-U`, `--json`, `--include-metadata`
- [Project config `sgconfig.yml`](https://ast-grep.github.io/reference/sgconfig.html)
  — `ruleDirs`, `testConfigs`
- [Testing rules](https://ast-grep.github.io/guide/test-rule.html) ·
  [Rewriting code (`fix`)](https://ast-grep.github.io/guide/rewrite-code.html)
