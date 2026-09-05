# Guardian Core

**Give AI agents capabilities. Not unrestricted authority.**

> **EXPERIMENTAL** — research code, not production software.

**Guardian Core is an experimental domain-agnostic Safe Execution Core that separates intent from controlled effects through state-bound execution and evidence-based outcomes.**

## The problem and the proposal

Today, an AI agent that calls a tool can reach a real system with a
potentially unrestricted effect:

```
Agent → Tool → potentially unrestricted effect
```

Guardian is an experimental execution layer that sits between AI agents and
real systems: the agent declares a data-only intent, the Guardian executes it
against the real system in a controlled way, and the outcome is returned as
evidence of what actually happened.

```
Agent → Guardian → controlled effect + evidence
```

## Four domains — experiments, not a universal proof

The pattern has been exercised in four domains — **Filesystem**, **GitHub**,
**VPS/Dokploy** and **Email**. Three of them (Filesystem, GitHub,
VPS/Dokploy) are the Core's three conformance adapters; Email is a fourth,
later, independent validation. These are four experiments, each a domain
proof — together they are **not** a universal proof and do **not** claim the
pattern works everywhere. The Core is **not** formally verified, **not**
proven universal, and **not** secure against malicious or incorrect adapters.

## What it is

`Guardian Core` is a single sequential executor plus a two-operation adapter
contract. The caller declares a **data-only intent**; an **operator-built
adapter** decides everything domain-specific:

```
executeGuardianIntent(intent, adapter)
  → adapter.bind(intent)          // read-only eligibility + observation
  → adapter.apply(boundProposal)  // the ONLY potentially mutating boundary
  → GuardianResult
```

## Five candidate invariants (supported across tested domains)

1. **NON-EXPANDABLE AUTHORITY** — the public surface receives only `(intent,
   adapter)`. No credentials, tokens, URLs, roots, shell, HTTP methods,
   mutation callbacks or filesystem primitives exist on this API. The adapter
   is built by the operator; its power stays closed inside it.
2. **FAIL-CLOSED ELIGIBILITY** — `apply` is unreachable unless `bind`
   returned `BOUND`.
3. **STATE-BOUND EXECUTION** — the opaque proposal carries the observation the
   decision is bound to. By adapter contract, `apply` must re-prove it within
   the controlled operation and refuse with zero mutation on mismatch. How a
   domain re-proves state is a domain primitive (CAS, fingerprint, reconcile).
   State-bound execution by itself does **not** imply cross-execution
   atomicity: two simultaneously compatible decisions can still collide unless
   the domain provides an atomic primitive (CAS, native precondition,
   transaction, lock/lease, idempotency or serialization).
4. **INTENT-CONFINED CONTROLLED EFFECTS** — `adapter.apply` is the only
   potentially mutating boundary; no machinery flows from the caller.
5. **EPISTEMIC HONESTY WITH INDETERMINACY** — the Core never invents, promotes
   or reinterprets outcomes. Machinery failure before the boundary reports
   `dispatched=false`; after it, `dispatched=true` with occurrence
   `UNDETERMINED` — never a fabricated success, never a fabricated
   "nothing happened".

## Result model

- `NOT_EXECUTED` — **zero mutation proven** (stage: `ELIGIBILITY`,
  `OBSERVATION`, `COMPATIBILITY`; refusal: `BLOCKED`, `UNDETERMINED`).
- `SUCCESS_PROVEN` — the postcondition was sufficiently established by
  evidence.
- `FAILURE_PROVEN` — the postcondition was sufficiently proven **not**
  reached.
- `INDETERMINATE` — evidence is insufficient; the outcome is reported as
  unknowable, never guessed.

`Occurrence = { dispatched: boolean; state: NONE_PROVEN | OCCURRED |
UNDETERMINED }` separates a clean refusal from an attempt whose outcome is
unknown. `dispatched` means only that the potentially mutating boundary was
reached — not that any effect occurred.

Exact semantics:

- `dispatched=false` → `adapter.apply` was **never invoked** by the Core.
- `dispatched=true + NONE_PROVEN` → `apply` was reached, but the adapter
  **proved no effect occurred** (e.g. a refusal inside `apply` before the
  internal domain mutation). `NOT_EXECUTED/COMPATIBILITY
  { dispatched: true, state: NONE_PROVEN }` is a correct, test-pinned shape
  for exactly that case.
- `dispatched=true + OCCURRED` → effect occurrence established by evidence.
- `dispatched=true + UNDETERMINED` → effect occurrence cannot be established
  honestly (machinery failure or unprovable outcome).

## Trust boundary (read this honestly)

The Core structurally guarantees: strict bind→apply ordering (apply is invoked
at most once), the effect-boundary/occurrence accounting above, and that no
retry machinery exists. **The Core cannot guarantee** what TypeScript cannot
express: that a given adapter's `bind` is really read-only, that its proposal
is not forged, that its evidence is truthful, or that its result mapping is
honest. Correctness is a property of the operator-built adapter and of the
certified domain mechanisms it reuses — not of the Core. There is **no
automatic retry** in the Core; whether a domain retries internally is a
domain decision.

The Core contains no policy engine, approval engine, registry, persistence,
retry/rollback framework, CAS, fingerprint or domain knowledge. Human approval
is external policy: adapters consume only externally authorized operations.

## Horizontal validation — three conformance adapters (Filesystem, GitHub, VPS/Dokploy)

| Domain        | bind                          | apply                                                     | state re-proof                          |
| ------------- | ----------------------------- | --------------------------------------------------------- | --------------------------------------- |
| Filesystem    | read-only plan + observation  | CAS write + read-back on one descriptor                   | `expectedCurrentContent` (same fd)      |
| GitHub        | read-only PR plan + snapshot  | fresh revalidation + one merge PUT + independent post-GET | proposal fingerprint + native head-SHA precondition |
| VPS/Dokploy   | doctor-style prechecks + plan | fresh reconcile + one redeploy + post-validation          | fresh reconcile + state comparison (no native CAS) |

Each conformance adapter is a thin, read-only import of a separately
certified, frozen domain proof; no domain security logic was duplicated into
the adapters and none leaked into the Core. Three domains is evidence of
portability of the pattern — **not** proof of universality. A fourth
independent validation (Email) followed later, outside this Core's
conformance suite — see the Email Guardian proof below.

## Commands

Core is self-contained:

```bash
npm install
npm test            # Core contract tests (13)
npm run typecheck
```

## Conformance adapters (experimental evidence, optional)

`src/filesystemAdapter.ts`, `src/githubAdapter.ts` and `src/vpsAdapter.ts`
plus their tests are **not part of the Core** and are excluded from the
default `test`/`typecheck`. They import three sibling proof repositories by
relative path and therefore only run in a workspace that has them:

```
../memoryos-filesystem-guardian-proof
../memoryos-github-guardian-proof
../memoryos-vps-guardian-pro
```

With those siblings present:

```bash
npm run test:conformance        # 28 conformance tests
npm run typecheck:conformance
npm run test:all                # everything (41 tests)
```

Without the siblings, the default `npm test` / `npm run typecheck` still pass
— conformance is optional evidence, never a broken promise.

Three of these domain proofs are publicly available:

- **VPS Guardian** — <https://github.com/AndersonVitaease/memoryos-vps-guardian-pro>
  Domain proof for governed AI-agent VPS operations, including stale-state
  protection, controlled redeploy and same-instance concurrent redeploy
  hardening.
- **GitHub Guardian** — <https://github.com/AndersonVitaease/memoryos-github-guardian-proof>
  State-bound PR merge execution using GitHub's native SHA precondition and
  independent post-merge verification.
- **Filesystem Guardian** — <https://github.com/AndersonVitaease/memoryos-filesystem-guardian-proof>
  Stale-state-safe file changes with bounded filesystem authority and
  read-back verification.

A fourth domain proof — outbound email — was later built as a blind,
independent validation and is also publicly available:

- **Email Guardian** — <https://github.com/AndersonVitaease/memoryos-email-guardian-proof>
  Bounded outbound email execution with stale-state protection,
  same-instance keyed duplicate suppression and evidence-based outcomes.

## Known limitations

**Per-execution Core.** The Core serializes nothing across executions: no
cross-execution serialization, no distributed locking, no cross-process or
cross-machine coordination, and no exactly-once execution.

**State-bound execution ≠ cross-execution atomicity.** It protects decisions
only when the domain can revalidate and prove incompatibility. Two
simultaneously compatible decisions can still collide unless the domain
supplies an atomic primitive (CAS, native precondition, transaction,
lock/lease, idempotency or serialization).

**Domain primitives decide concurrency strength.** Observed across the
conformance domains: GitHub — native SHA precondition; Filesystem —
same-descriptor state validation + controlled write path; Email and VPS —
same-instance keyed reservation (+ fresh evidence/fingerprint for VPS). This
is evidence, not a universal claim.

**Validated domains remain PARTIAL on concurrency beyond same-instance
protection:**

- `EMAIL_STATE_BOUND=PARTIAL` — GC-07R proved that two simultaneous decisions
  for the same `messageId` could duplicate dispatch; GC-08A added
  same-instance/same-`messageId` protection. Not provided: cross-process or
  cross-machine protection, exactly-once, provider-native idempotency,
  crash/restart durability. Known deviation: the email proof's concurrent
  loser reports `dispatched=false` from inside `apply` — a known
  adapter-level under-reporting relative to the Core contract above, with no
  mutation-integrity impact; intentionally left as-is in this release.
- `VPS_STATE_BOUND=PARTIAL` — GC-08B proved the simultaneous compatible
  redeploy collision (duplicate dispatch reproduced; backend distinct-effect
  semantics depended on coalescing/visibility); GC-08C added
  same-instance/same-`applicationId` protection. Not provided:
  cross-process/cross-machine serialization, distributed lock, exactly-once,
  backend idempotency. `NO_DEPLOYMENT_IN_FLIGHT` remains evidence-dependent.

## Scope

`src/guardianCore.ts` (the Core) is intentionally minimal: `GuardianResult`,
`Occurrence`, `DomainAdapter<I, B>` and `executeGuardianIntent` — nothing
else. The Core performs no I/O, persists nothing, retries nothing, and knows
no domain.

## License status

This repository is publicly available for evaluation and technical review.
No open-source license is currently granted; all rights are reserved by the
author. Public visibility does not grant redistribution or reuse rights.
