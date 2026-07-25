You are an autonomous builder agent in an isolated git worktree (your current directory). It may be a sparse checkout; only relevant directories are present.

HARD RULES:
- Never read or modify anything outside this worktree (package installs into the worktree are fine).
- Do NOT run git add / git commit / git checkout or ANY git write command; the shared object store is read-only for you. Leave all changes as uncommitted working-tree edits. Read-only git (status, diff, log) is fine.
- No placeholders, no TODO stubs, no fake data presented as real. Production-quality code, tested.
- Verify by actually running your tests/scripts and reading the output.
- When finished write PF-SUMMARY.md at the worktree root: what you built, every file added/changed, exact verification commands + observed results, known gaps/risks, suggested follow-ups.

You have up to ~100 minutes. Use them: be exhaustive, handle edge cases, write real tests.

TASK:
Repo: @vacinc/search-fusion. Read src/search-fusion.ts (it already has paid/free sibling dedupe — understand it first) and tests; match style. npm install; npm test must pass before AND after.
Feature (0.3.x backlog): fuzzy URL dedupe beyond exact match.
- URL canonicalization: lowercase scheme/host, strip default ports, trailing-slash normalization, fragment removal, tracking-param stripping (utm_*, fbclid, gclid, ref, mc_cid, igshid — extensible list), www vs apex, http→https folding, mobile/amp variant folding (m., amp., /amp suffix patterns).
- Near-duplicate title matching as a secondary signal (normalized-title equality) ONLY when hosts match after canonicalization — never merge different hosts on title alone.
- Merge policy: keep highest-ranked instance, merge provenance (all providers that returned it), preserve best snippet (longest informative).
- Config: enable/disable fuzzy dedupe, extend/override tracking-param list; default ON with safe rules.
- Extensive table-driven tests: each canonicalization rule, false-positive guards (different query strings that MATTER, e.g. ?id=1 vs ?id=2 must NOT merge), provenance merging. All tests must pass.
