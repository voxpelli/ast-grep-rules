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

| id | severity | catches | fixable |
|----|----------|---------|---------|
| `no-jsdoc-object-typedef` | warning | `@typedef {object} Name` followed by `@property` tags | **yes** — a surgical `transform.replace` strips just `{object} ` |
| `no-jsdoc-any-type` | warning | `@param`/`@returns`/`@type`/`@property {any}` | no — the correct narrower type is context-specific |
| `no-inline-jsdoc-import` | warning | inline `import('module').Type` inside a JSDoc tag | no — hoist to a top-level `/** @import { Type } from 'module' */` and use the bare `Type` |

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
