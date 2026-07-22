// haiku-jsdoc-sweep.workflow.js — a generalized, reusable Claude Code Workflow
// that applies the three @voxpelli/ast-grep-rules JSDoc rules across a repo with
// a CHEAP-MODEL FLEET, made safe by the repo's own type gate rather than by
// agent consensus.
//
// (This banner is `//` line comments, not `/* */` — a glob or regex example
// containing `*/` would otherwise close a block comment early.)
//
// ── What it does ────────────────────────────────────────────────────────────
//   Scout → Apply → Recover → Escalate → Verify, one agent per *grouping*:
//   1. Scout   (1 cheap agent) runs `ast-grep scan` over the module globs and
//              returns the findings as JSON — pure JSON-reading, mechanical.
//   2. Grouping (plain JS, no agent) sizes the work by MANUAL LOAD, not file
//              count: one module = one grouping by default; a monolith whose
//              inline-import count exceeds `cap` is split into file-batched
//              sub-groupings so no grouping carries more than `cap` hoists.
//              Every finding-carrying file lands in exactly one grouping
//              (file-disjoint), so parallel agents never fight over a file.
//   3. Apply   (1 cheap agent per grouping, parallel) fixes each finding by
//              doing EXACTLY what the rule's message/note says — bulk
//              --update-all for object-typedefs, the two-edit hoist for inline
//              imports, `unknown`+narrow (or "leave it") for `any`. No repo-wide
//              build, no commit.
//   4. Recover retries an unclean grouping once on the cheap model.
//   5. Escalate sends a still-unclean grouping to a STRONGER model (never
//              another cheap peer) — recorded separately from the raw datum.
//   6. Verify  (1 agent) runs the repo's deterministic gate (tsc/eslint/
//              type-coverage/tests). THIS, not agent agreement, decides
//              correctness — the model-routing floor is satisfied by a
//              downstream cross-check, so a cheap fleet is sound here.
//
//   The return value is a CAPABILITY SCORECARD: raw cheap-model success per
//   grouping (the datum), kept separate from what recovery/escalation fixed.
//
// ── Why it is safe to use a cheap model ─────────────────────────────────────
//   Each rule's diagnostic is an agent-executable instruction (message = what,
//   note = ordered how, metadata = routing). Correctness is decided by the
//   `gate`, not by peer voting — so the "N cheap agents agreeing isn't
//   corroboration" critique of consensus designs does not apply. Run it in a
//   repo-level git worktree so the churn is isolated and a bad run is a clean
//   `git worktree remove`.
//
// ── Prior art this implements ───────────────────────────────────────────────
//   • prompt → orient → retrieve → edit → VERIFY loop (addcommitpush,
//     "Write Code That AI Agents Love").
//   • verify at sync-points, not per-edit (the gate runs once at the end).
//   • a finite rule-set + a deterministic fact-checker (structural detector +
//     type gate) rather than free-form "clean this up".
//   • structural-AST detection over string-replace (ast-grep, CODESTRUCT).
//   • type-constrained generation: the gate is the constraint that makes
//     cheap-model edits trustworthy.
//
// ── Usage ───────────────────────────────────────────────────────────────────
//   Invoke the Workflow tool with `scriptPath` = this file and `args` =
//   (JSON object or JSON string):
//
//     {
//       "root":         "/abs/path/to/repo-or-worktree",   // required
//       "moduleGlobs":  "packages/*/lib src/lib",          // required, space-sep, relative to root
//       "gate":         "pnpm -r run check",               // required, run from root
//       "sgconfig":     "<root>/node_modules/@voxpelli/ast-grep-rules/sgconfig.yml", // default shown
//       "cap":          12,                                // optional, max inline hoists / grouping
//       "modulePattern":"^(.*/packages/[^/]+/lib)(/|$)",   // optional, group-1 = module key
//       "astGrepBin":   "ast-grep",                        // optional, default on PATH
//       "jqBin":        "jq",                              // optional, default on PATH
//       "label":        "sweep"                            // optional, progress label
//     }
//
//   The sgconfig.yml you point at must have `ruleDirs` including this package's
//   `rules/` (see the package README "Consuming the rules").

export const meta = {
  name: 'haiku-jsdoc-sweep',
  description: 'Cheap-model per-grouping JSDoc sweep: scout ast-grep findings, apply per rule message/note, record raw capability + escalate stragglers to a stronger model, verify the repo gate',
  phases: [
    { title: 'Scout', detail: 'one cheap agent runs ast-grep over the module globs, returns findings' },
    { title: 'Apply', detail: 'one cheap agent per grouping, fixes per the rule message/note (raw pass)' },
    { title: 'Recover', detail: 'unclean groupings retried on the cheap model' },
    { title: 'Escalate', detail: 'still-unclean groupings escalated to a stronger model' },
    { title: 'Verify', detail: 'one agent runs the repo quality gate' },
  ],
};

const A = typeof args === 'string' ? JSON.parse(args) : args;
const ROOT = A.root;
const GATE = A.gate;
const CAP = A.cap || 12;
const LABEL = A.label || 'sweep';
const AG = A.astGrepBin || 'ast-grep';
const JQ = A.jqBin || 'jq';
const CFG = A.sgconfig || `${ROOT}/node_modules/@voxpelli/ast-grep-rules/sgconfig.yml`;
const absGlobs = A.moduleGlobs.split(/\s+/).map(g => `${ROOT}/${g}`).join(' ');
// Group-1 of this regex is the "module key" that batches files into groupings.
// Default: a pnpm/npm workspace's `<...>/packages/<name>/lib`. A file that does
// not match falls back to grouping by its parent directory.
const MODULE_RE = new RegExp(A.modulePattern || '^(.*/packages/[^/]+/lib)(/|$)');

const SCOUT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { findings: { type: 'array', items: {
    type: 'object', additionalProperties: false,
    properties: { file: { type: 'string' }, rule: { type: 'string', enum: ['inline', 'object', 'any'] } },
    required: ['file', 'rule'],
  } } },
  required: ['findings'],
};
const APPLY_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    changed: { type: 'boolean' },
    scanClean: { type: 'boolean' },
    handledInline: { type: 'integer' },
    handledObject: { type: 'integer' },
    handledAny: { type: 'integer' },
    summary: { type: 'string' },
  },
  required: ['changed', 'scanClean', 'summary'],
};
const VERIFY_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { gatePass: { type: 'boolean' }, detail: { type: 'string' } },
  required: ['gatePass', 'detail'],
};

function moduleOf (file) {
  const m = file.match(MODULE_RE);
  return m ? m[1] : file.replace(/\/[^/]+$/, '');
}

// Group findings by module; split a module whose inline load exceeds CAP into
// file-batched sub-groupings so no grouping carries > CAP inline hoists. Every
// finding-carrying file lands in exactly one grouping (file-disjoint).
function buildGroupings (findings) {
  const byModule = new Map();
  for (const f of findings) {
    const mod = moduleOf(f.file);
    if (!byModule.has(mod)) byModule.set(mod, new Map());
    const files = byModule.get(mod);
    if (!files.has(f.file)) files.set(f.file, { file: f.file, inline: 0, object: 0, any: 0 });
    files.get(f.file)[f.rule]++;
  }
  const groupings = [];
  for (const [mod, filesMap] of byModule) {
    const files = [...filesMap.values()].sort((a, b) => b.inline - a.inline);
    const totalInline = files.reduce((s, f) => s + f.inline, 0);
    if (totalInline <= CAP) {
      groupings.push({ module: mod, files: files.map(f => f.file), inline: totalInline, object: files.reduce((s, f) => s + f.object, 0), any: files.reduce((s, f) => s + f.any, 0), split: false });
    } else {
      let batch = []; let bi = 0;
      const flush = () => { if (batch.length) { groupings.push({ module: mod, files: batch.map(f => f.file), inline: batch.reduce((s, f) => s + f.inline, 0), object: batch.reduce((s, f) => s + f.object, 0), any: batch.reduce((s, f) => s + f.any, 0), split: true }); batch = []; bi = 0; } };
      for (const f of files) {
        if (batch.length && bi + f.inline > CAP) flush();
        batch.push(f); bi += f.inline;
      }
      flush();
    }
  }
  return groupings;
}

const shortMod = m => m.split('/').slice(-2).join('/');

function scoutPrompt () {
  return `You are SCOUTING for JSDoc lint findings (discovery only — edit NOTHING). Run exactly:

  ${AG} scan -c ${CFG} ${absGlobs} --json=compact 2>/dev/null | ${JQ} -c '[.[] | {file: .file, ruleId: .ruleId}]'

Each element is a finding with an absolute .file and a .ruleId. Map ruleId → rule:
  no-inline-jsdoc-import → "inline"; no-jsdoc-object-typedef → "object"; no-jsdoc-any-type → "any".
Return JSON { "findings": [ { "file": <abs path>, "rule": <inline|object|any> }, ... ] } covering
EVERY finding (one array element per finding, duplicates by file allowed). If the command prints
[] there are no findings — return { "findings": [] }.`;
}

function applyPrompt (g) {
  const files = g.files.join(' ');
  return `You are cleaning up JSDoc-convention lint warnings across a FIXED set of files. A house
lint tool (ast-grep) reports warnings; each warning's message + note contains its own remediation
instructions. Follow ONLY what each message/note says — no external style guides, no invented
conventions, don't ask anyone. Edit ONLY these files (do not touch any other file):

${g.files.map(f => '  - ' + f).join('\n')}

Steps:
1. List findings + read every FULL message AND note:  ${AG} scan -c ${CFG} ${files}
2. Resolve every finding by doing EXACTLY what its message/note instructs. Efficiency:
   - object-typedef findings are bulk auto-fixable — clear them for these files in one shot:
     ${AG} scan -c ${CFG} ${files} --update-all   (run WITHOUT --json; --update-all is dropped when --json is present)
   - inline-import findings are NOT auto-fixable: each needs the two-edit hoist its note
     describes (add a top-level \`/** @import { T } from 'mod' */\` after that file's imports — or
     EXTEND an existing @import block from the same module — AND replace the inline
     \`import('mod').T\` with bare \`T\`), done per file.
   - any-type findings: follow the note's decision tree (\`unknown\` + narrow via @voxpelli/typed-utils
     isObject/typesafeIsArray, or a named type). If the value is USED, adding the narrower is
     required for it to compile — that's expected. If the note says a case is a DELIBERATE \`any\`
     to LEAVE (a 3rd-party boundary value, or a \`(...args: any[]) => any\` top-function type), leave it.
   If a message/note says a finding must NOT be changed a certain way (e.g. a \`@typedef {import()}\`
   re-export, or an \`x is import().T\` predicate), respect it.
3. Re-run \`${AG} scan -c ${CFG} ${files}\` and confirm 0 FIXABLE findings for these files
   (a deliberately-left \`any\` the note told you to keep is not a failure).
4. Do NOT run any project-wide build/test. Do NOT git commit/push. Leave edits in the working tree.

Return JSON: { "changed": <edited any file?>, "scanClean": <final scan of these files has only deliberately-left findings?>,
"handledInline": <count>, "handledObject": <count>, "handledAny": <count>,
"summary": "<one line: what you did + anything you deliberately left>" }.`;
}

function verifyPrompt () {
  return `Run this repo's quality gate and report whether it passes. Assert the repo's Node first:

  cd ${ROOT}
  node --version   # ensure it matches the repo's required major (e.g. via fnm/nvm/volta if used)
  ${GATE}

Capture the exit code + last ~30 lines. Exit 0 => gatePass true. Non-zero => gatePass false with
detail = the single most important error line (a tsc/eslint/type-coverage/test error), quoted.
Do NOT git commit/push. Return JSON { "gatePass": <bool>, "detail": "<one line>" }.`;
}

// ---- run ----
phase('Scout');
const scout = await agent(scoutPrompt(), { label: `scout:${LABEL}`, phase: 'Scout', model: 'haiku', effort: 'low', agentType: 'general-purpose', schema: SCOUT_SCHEMA });
const findings = (scout && Array.isArray(scout.findings)) ? scout.findings : [];
const groupings = buildGroupings(findings);
log(`Scout: ${findings.length} findings → ${groupings.length} grouping(s) (${groupings.filter(g => g.split).length} from monolith splits)`);

phase('Apply');
const rawApply = await parallel(groupings.map((g, i) => () =>
  agent(applyPrompt(g), { label: `fix:${shortMod(g.module)}#${i}`, phase: 'Apply', model: 'haiku', effort: 'medium', agentType: 'general-purpose', schema: APPLY_SCHEMA })
));
const state = groupings.map((g, i) => {
  const r = rawApply[i];
  return { g, rawClean: !!(r && r.scanClean), raw: r, final: r, tier: 'haiku', escalated: false, recovered: null };
});
log(`Apply (raw cheap-model): ${state.filter(s => s.rawClean).length}/${groupings.length} groupings clean unaided`);

// Recovery pass 1 — cheap-model retry (recorded separately from the raw capability datum)
phase('Recover');
const pend = state.filter(s => !s.rawClean);
if (pend.length) {
  const retry = await parallel(pend.map(s => () =>
    agent(applyPrompt(s.g), { label: `retry:${shortMod(s.g.module)}`, phase: 'Recover', model: 'haiku', effort: 'medium', agentType: 'general-purpose', schema: APPLY_SCHEMA })));
  pend.forEach((s, i) => { s.final = retry[i]; if (retry[i] && retry[i].scanClean) s.recovered = 'haiku-retry'; });
}

// Recovery pass 2 — escalation to a stronger model (never another cheap peer)
phase('Escalate');
const stillBad = state.filter(s => !s.rawClean && !(s.final && s.final.scanClean));
if (stillBad.length) {
  const strong = await parallel(stillBad.map(s => () =>
    agent(applyPrompt(s.g), { label: `escalate:${shortMod(s.g.module)}`, phase: 'Escalate', model: 'sonnet', effort: 'high', agentType: 'general-purpose', schema: APPLY_SCHEMA })));
  stillBad.forEach((s, i) => { s.final = strong[i]; s.tier = 'sonnet'; s.escalated = true; if (strong[i] && strong[i].scanClean) s.recovered = 'sonnet'; });
}
log(`Recovery: ${state.filter(s => !s.rawClean && s.final && s.final.scanClean).length}/${pend.length} recovered; ${state.filter(s => !(s.final && s.final.scanClean)).length} still unclean`);

phase('Verify');
const verify = await agent(verifyPrompt(), { label: `verify:${LABEL}`, phase: 'Verify', model: 'haiku', effort: 'low', agentType: 'general-purpose', schema: VERIFY_SCHEMA });

// Capability scorecard (raw cheap-model = the datum; recovery = separate)
return {
  totalFindings: findings.length,
  byRule: findings.reduce((m, f) => ((m[f.rule] = (m[f.rule] || 0) + 1), m), {}),
  groupings: groupings.length,
  splitGroupings: groupings.filter(g => g.split).length,
  rawCheapModelClean: state.filter(s => s.rawClean).length,
  cheapRetryRecovered: state.filter(s => s.recovered === 'haiku-retry').length,
  strongModelRecovered: state.filter(s => s.recovered === 'sonnet').length,
  stillUnclean: state.filter(s => !(s.final && s.final.scanClean)).map(s => ({ module: shortMod(s.g.module), files: s.g.files.length, summary: s.final && s.final.summary })),
  perGrouping: state.map(s => ({ module: shortMod(s.g.module), inline: s.g.inline, object: s.g.object, any: s.g.any, split: s.g.split, rawClean: s.rawClean, tier: s.tier, escalated: s.escalated, recovered: s.recovered })),
  gate: verify,
};
