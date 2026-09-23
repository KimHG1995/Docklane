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
