# Guardian Core

> **EXPERIMENTAL** — research code, not production software.

**Guardian Core is an experimental domain-agnostic Safe Execution Core that separates intent from controlled effects through state-bound execution and evidence-based outcomes.**

It was validated horizontally against three independently developed execution
domains (Filesystem, GitHub, VPS/Dokploy). It is **not** formally verified,
**not** proven universal, and **not** secure against malicious or incorrect
adapters.

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

## The five frozen invariants

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

## Horizontal validation (three independent domains)

| Domain        | bind                          | apply                                                     | state re-proof                          |
| ------------- | ----------------------------- | --------------------------------------------------------- | --------------------------------------- |
| Filesystem    | read-only plan + observation  | CAS write + read-back on one descriptor                   | `expectedCurrentContent` (same fd)      |
| GitHub        | read-only PR plan + snapshot  | fresh revalidation + one merge PUT + independent post-GET | proposal fingerprint + native head-SHA precondition |
| VPS/Dokploy   | doctor-style prechecks + plan | fresh reconcile + one redeploy + post-validation          | fresh reconcile + state comparison (no native CAS) |

Each conformance adapter is a thin, read-only import of a separately
certified, frozen domain proof; no domain security logic was duplicated into
the adapters and none leaked into the Core. Three domains is evidence of
portability of the pattern — **not** proof of universality.

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
default `test`/`typecheck`. They import three private sibling proof
repositories by relative path and therefore only run in a workspace that has
them:

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

## Scope

`src/guardianCore.ts` (the Core) is intentionally minimal: `GuardianResult`,
`Occurrence`, `DomainAdapter<I, B>` and `executeGuardianIntent` — nothing
else. The Core performs no I/O, persists nothing, retries nothing, and knows
no domain.
