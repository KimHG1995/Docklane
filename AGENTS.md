# AGENTS.md

Repository-wide instructions for coding agents and automation.

## Mandatory workflow

1. Read `CONTRIBUTING.md` and relevant specs before changing code.
2. Use one task per branch and one branch per PR.
3. Start from the latest `main`.
4. Do not open a PR until the requested scope is implemented and internally reviewed.
5. Do not create one commit per file.
6. Batch related file changes into one coherent commit whenever practical.
7. Prefer Git tree/batch commit operations over repeated file-level commits.
8. Do not use GitHub Actions as a formatter.
9. Align formatting, types, contracts, and tests before opening the PR.
10. If CI fails, inspect all failing job logs before editing.
11. Group fixes from the same CI failure into one follow-up commit.
12. Merge only when the latest PR head is green.
13. Use squash merge unless the task explicitly requires another strategy.
14. Treat the post-merge `main` validation run as expected.
15. Do not use GitHub Actions to discover basic implementation, test, formatting, shell, certificate-path, port-mapping, or harness setup mistakes that can be checked before push.
16. Product/runtime code and new Functional/Operational acceptance harness work are separate work units by default. Use separate branches and PRs unless the harness is a tiny deterministic regression test with no new infrastructure or environment setup.
17. For a new heavy harness or environment scenario, first make the product change green against existing validation. Add the new acceptance harness only in the next PR.
18. Before pushing a workflow or shell harness change, run every locally reproducible static/preflight check available for that file (syntax, path existence assumptions, configuration shape, formatting, and referenced build outputs).
19. Do not push speculative fixes one at a time. Diagnose the complete failure, update all related causes together, then push one correction.
20. Avoid creating extra workflow runs for documentation-only follow-ups. Documentation needed to describe an accepted feature belongs in the acceptance/docs PR, not as a commit after the final acceptance run.
21. Every work unit must include roadmap synchronization. Review `docs/ROADMAP.md` before implementation and again before merge. If implementation, validation, or acceptance changes an item's state or evidence, update the roadmap in the same PR whenever that result is already known.
22. When an acceptance result is only known after merge on `main`, the next work unit must begin by synchronizing that result into `docs/ROADMAP.md` before adding new scope. Include the successful run/evidence in that same PR instead of leaving roadmap drift unresolved.

## Commit hygiene

Target:

```text
normal task: 1 commit before PR
CI-specific correction: a small number of follow-up commits
main: 1 squash commit per PR
```

Avoid:

- file-by-file commits
- formatting-only commit chains
- repeated speculative CI fixes
- opening a PR just to discover formatting errors

## Validation

Before PR creation, align with `.github/workflows/validate.yml`.

TypeScript:

```bash
corepack enable
pnpm install --no-frozen-lockfile
pnpm typecheck
pnpm --filter @docklane/api test
pnpm build
```

Go:

```bash
cd agent
go mod tidy
gofmt -w .
go vet ./...
go test ./...
go build -o bin/docklane-agent ./cmd/docklane-agent
```

If `go mod tidy` or `gofmt` changes files, include those changes before opening the PR.

## Docklane mutation rule

Never treat command acceptance as success.

Mutation work must preserve:

- canonical resource identity
- affected-resource coordination
- version/spec preconditions
- persisted intent and audit
- idempotent operation IDs
- uncertain outcome reconciliation
- restart recovery
- external change detection
- convergence verification

When a mutation touches multiple resources, all affected resource relationships must be considered in both entry checks and retries/reconciliation.


## CI noise control

GitHub Actions is a validation gate, not the primary development loop.

Required default split:

```text
PR A: product/runtime change
  -> unit/integration regression tests
  -> existing CI/PoC compatibility
  -> green
  -> merge

PR B: new acceptance harness / workflow / environment scenario
  -> harness static checks
  -> real acceptance run
  -> evidence + docs
  -> green
  -> merge
```

A combined PR is allowed only when all of the following are true:

- no new Docker/network/TLS/process orchestration is introduced
- no new GitHub Actions workflow or heavy job is introduced
- the added test is deterministic and fast
- the test can be exercised before opening the PR
- failure cannot create repeated speculative workflow runs

When CI fails:

1. classify it as product-code, regression-test, workflow/harness, or external-infrastructure failure
2. collect the complete failing logs
3. reproduce locally or with the narrowest available preflight when possible
4. fix the root cause and adjacent deterministic issues together
5. push once
6. do not add unrelated cleanup or documentation commits while waiting for the rerun

For expensive Operational Readiness workflows, a successful acceptance run is evidence. Do not retrigger the same heavy scenario solely because a later commit changes prose. Keep acceptance evidence and documentation in the same acceptance PR before the final run whenever practical.

Heavy Operational Readiness workflows must not run automatically on every pull-request synchronization. PR validation is limited to deterministic static/preflight checks; real multi-node acceptance runs belong on `main` push or explicit `workflow_dispatch`.

Operational Readiness static validation must discover harness scripts and standalone helpers dynamically. Do not maintain a hand-written file allowlist that can silently omit a new scenario.


## Roadmap synchronization

Roadmap synchronization is part of the definition of done for every task.

Required flow:

```text
start task
  -> read ROADMAP
  -> implement / validate
  -> re-check ROADMAP
  -> update status and evidence if changed
  -> merge
```

Rules:

- Do not leave a completed implementation or accepted scenario unchecked in `docs/ROADMAP.md`.
- Do not mark acceptance complete from implementation alone. Record the actual successful run or equivalent evidence.
- If a heavy acceptance runs only after merge, carry that result into the very next work unit before new scope.
- Do not create a separate documentation-only PR solely for routine roadmap synchronization when it can be included in the active work unit.
- When a task does not change roadmap state, explicitly verify that no roadmap change is required before merge.
