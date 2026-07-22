# @voxpelli/ast-grep-rules

**EXPERIMENTAL** staged extraction of the portable, project-authored
[ast-grep](https://ast-grep.github.io/) JSDoc/ESM lint rules originally carried
in `voxpelli/vp-claude`'s `.ast-grep/rules/`, plus one new rule
(`no-inline-jsdoc-import`). Data-only: the package ships YAML rules + their
snapshot tests — no JavaScript, so it opts out of the JS gates (tsc / eslint /
type-coverage / tstyche) the sibling `@voxpelli/*` packages run, and its
`check` / `test:node` scripts run `ast-grep test` instead.

The rules encode house conventions shared across the voxpelli siblings:
JSDoc-typed JavaScript, ESM-only, prefer `unknown` over `any`. They are the
narrow, cross-repo-agreed slice — the vp-claude-specific and bash rules stay
in vp-claude.

## Rules

| id | severity | catches | auto-fixable |
|----|----------|---------|--------------|
| `no-jsdoc-object-typedef` | warning | `@typedef {object} Name` followed by `@property` tags | **yes** — a surgical `transform.replace` strips just `{object} `; a node-local rewrite fully fixes it, so `ast-grep scan --update-all` cleans it up |
| `no-jsdoc-any-type` | warning | `@param`/`@returns`/`@type`/`@property {any}` | **no** — the correct narrower type (`unknown`, a named type, a union) is context-specific; a machine can't pick it |
| `no-inline-jsdoc-import` | warning | inline `import('module').Type` at a **use-site** inside a **JSDoc block** (`/** … */` only — `//` and plain `/* … */` prose are ignored). **Excludes** `@typedef {import(...)}` (a type ALIAS / cross-module re-export — the inline import IS the definition) and a `x is import(...).T` type-predicate position (the hoisted `@import` doesn't resolve there on the TS/JSDoc toolchain) | **no** — a correct fix must BOTH rewrite the inline ref → bare `Type` AND add a top-level `/** @import { Type } from 'module' */`; ast-grep's fix is node-local (matched comment only) and can't insert the second edit, so rewriting alone would leave `Type` undefined. Hoist by hand |

Why the split matters: only `no-jsdoc-object-typedef` is a *single-location* transform, so it's the one wired for `--update-all`. The other two flag drift that needs a human decision (which narrower type) or a second, non-local edit (the hoisted `@import`) that ast-grep can't perform safely — so they stay report-only.

All three are `severity: warning` heuristics (house `SHOULD`s), so
`ast-grep scan` exits 0 on findings — they surface, they do not fail CI on their
own.

## Consuming the rules

Point an `sgconfig.yml`'s `ruleDirs` at this package's `rules/` directory (or
copy/vendor the individual `.yml` files). A rule's own `language:` field scopes
it to matching files automatically, so a single `ast-grep scan` over your source
runs each rule only against files of its declared language.

```yaml
# sgconfig.yml
ruleDirs:
  - node_modules/@voxpelli/ast-grep-rules/rules
```

The package's bundled `sgconfig.yml` + `rule-tests/` are what `ast-grep test`
(the `check` / `test:node` scripts) uses to prove each rule fires on a planted
violation and stays silent on the correct form — the ast-grep-native equivalent
of a detector self-test.
