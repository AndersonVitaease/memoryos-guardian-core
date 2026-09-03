# memoryos-guardian-core

> **EXPERIMENTAL**
> **GC — Guardian Core v0.1**
> **Minimal executable core (GC-01)**

The smallest executable architecture that enforces the five frozen Guardian Core
invariants horizontally, without embedding any VPS, GitHub or Filesystem specifics.

## Frozen contract (GC-00 — CORE_CONTRACT_CHANGED=no)

1. NON-EXPANDABLE AUTHORITY — the public surface receives only the caller's intent
   and an operator-owned adapter; no credentials, tokens, URLs, roots, shell, HTTP
   methods, mutation callbacks or filesystem primitives exist on this API.
2. FAIL-CLOSED ELIGIBILITY — `apply` is unreachable unless `bind` returned BOUND.
3. STATE-BOUND EXECUTION — the opaque proposal forges the observation the decision
   is bound to; per adapter contract, `apply` must re-prove it within the controlled
   operation and refuse with zero mutation on mismatch.
4. INTENT-CONFINED CONTROLLED EFFECTS — `adapter.apply` is the only potentially
   mutating boundary; no machinery flows from the caller.
5. EPISTEMIC HONESTY WITH INDETERMINACY — the Core never invents, promotes or
   reinterprets outcomes; machinery failure is reported honestly (before the
   boundary: dispatched=false; after it: dispatched=true + occurrence UNDETERMINED).

## Scope

- `src/guardianCore.ts` — the Core: `GuardianResult`, `Occurrence`,
  `DomainAdapter<I, B>` (bind/apply only), `executeGuardianIntent`.
- `test/guardianCore.test.ts` — contract tests with fake adapters only.

The Core never interprets state or evidence, never performs domain I/O, never
persists, retries, rolls back, and holds no policy, approval, registry, snapshot,
fingerprint or CAS machinery. No real domain adapters exist in this lab.

## Commands

- `npm run typecheck`
- `npm test`
