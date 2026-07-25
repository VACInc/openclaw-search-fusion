You are an autonomous builder agent in an isolated git worktree (your current directory). It may be a sparse checkout; only relevant directories are present.

HARD RULES:
- Never read or modify anything outside this worktree (package installs into the worktree are fine).
- Do NOT run git add / git commit / git checkout or ANY git write command; the shared object store is read-only for you. Leave all changes as uncommitted working-tree edits. Read-only git (status, diff, log) is fine.
- No placeholders, no TODO stubs, no fake data presented as real. Production-quality code, tested.
- Verify by actually running your tests/scripts and reading the output.
- When finished write PF-SUMMARY.md at the worktree root: what you built, every file added/changed, exact verification commands + observed results, known gaps/risks, suggested follow-ups.

You have up to ~100 minutes. Use them: be exhaustive, handle edge cases, write real tests.

TASK:
Repo: @vacinc/search-fusion. Read src/search-fusion.ts provider adapters first — verify what count/limit params each provider actually supports in the existing code; match style. npm install; npm test must pass before AND after.
Feature (0.3.x backlog): provider-native result counts.
- Today the fusion presumably requests a uniform small count; providers support more (backlog notes: tavily 20, parallel 40, exa 100 — treat these as researched config DEFAULTS, verified against each adapter's request shape, not magic hardcodes).
- Add per-provider maxResults config: default = provider-native maximum from a documented table in code; user config can lower it; requests clamp to provider max.
- Keep global output bounded: fusion-level cap on returned results (existing bounded-output behavior must be preserved), so higher per-provider pulls feed dedupe/ranking, not output bloat.
- Ensure keyless/free-tier providers are not pushed past free limits — respect any existing free-tier distinctions in the code.
- Tests: per-provider clamping, config override, global cap interaction, and that request payloads carry the right count param per provider (mock the transport). All tests must pass.
