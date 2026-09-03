/**
 * Guardian Core v0.1 — minimal executable core (GC-01).
 *
 * Contract frozen at GC-00 — CORE_CONTRACT_CHANGED=no. The five invariants this
 * executable shape enforces horizontally:
 *
 * 1. NON-EXPANDABLE AUTHORITY — the public surface receives ONLY the caller's
 *    intent and an operator-owned adapter. No credentials, tokens, URLs, roots,
 *    shell, HTTP methods, mutation callbacks or filesystem primitives exist on
 *    this API; there is no channel through which a caller could expand authority.
 * 2. FAIL-CLOSED ELIGIBILITY — adapter.apply is unreachable unless adapter.bind
 *    returned BOUND; a bind that refuses or cannot establish terminates the run
 *    with zero mutation.
 * 3. STATE-BOUND EXECUTION — the opaque proposal forged by bind carries the
 *    observation the decision is bound to; per adapter contract, apply must
 *    re-prove it against current state within the controlled operation and
 *    refuse with NOT_EXECUTED(COMPATIBILITY) (zero mutation) on mismatch.
 *    The Core never inspects the proposal.
 * 4. INTENT-CONFINED CONTROLLED EFFECTS — adapter.apply is the ONLY potentially
 *    mutating boundary; the Core forwards the proposal unchanged; no machinery
 *    of any kind flows from the caller.
 * 5. EPISTEMIC HONESTY WITH INDETERMINACY — the Core never invents, promotes or
 *    reinterprets adapter adjudications; on machinery failure it reports honestly:
 *    before the boundary (dispatched=false) or after it (dispatched=true,
 *    occurrence UNDETERMINED) — never SUCCESS_PROVEN without adapter proof.
 *
 * Domain-agnostic by construction: no domain I/O, no state/evidence/fingerprint/
 * snapshot/SHA/expected-content interpretation, no policy, persistence, retry,
 * rollback, approval, registry or status zoo.
 */

/** Occurrence of the declared persistent effect. */
export interface Occurrence {
  /**
   * True ONLY when the Core actually invoked adapter.apply — i.e. the potentially
   * mutating boundary was reached. It does NOT mean a persistent effect occurred.
   */
  dispatched: boolean;
  /**
   * NONE_PROVEN: no persistent effect — only with proof (boundary never reached,
   * or the adapter proved refusal). OCCURRED: the declared effect is proven.
   * UNDETERMINED: occurrence could not be established.
   */
  state: "NONE_PROVEN" | "OCCURRED" | "UNDETERMINED";
}

/**
 * Honest result — four semantic outcomes only:
 *  - NOT_EXECUTED:   ZERO mutation PROVEN (stopped before any effect; stage and
 *                    refusal say why). Never used when effect occurrence is in doubt.
 *  - SUCCESS_PROVEN: the intended postcondition is proven established.
 *  - FAILURE_PROVEN: sufficient evidence the intended postcondition was NOT reached.
 *  - INDETERMINATE:  no sufficient evidence to adjudicate honestly.
 */
export type GuardianResult =
  | {
      outcome: "NOT_EXECUTED";
      stage: "ELIGIBILITY" | "OBSERVATION" | "COMPATIBILITY";
      refusal: "BLOCKED" | "UNDETERMINED";
      effect: Occurrence;
      reasons: string[];
    }
  | { outcome: "SUCCESS_PROVEN"; effect: Occurrence; evidence: unknown }
  | { outcome: "FAILURE_PROVEN"; effect: Occurrence; evidence?: unknown; reasons: string[] }
  | { outcome: "INDETERMINATE"; effect: Occurrence; reasons: string[] };

/** The NOT_EXECUTED shape adapters may return from bind. */
export type BindNotExecuted = Extract<GuardianResult, { outcome: "NOT_EXECUTED" }>;
export type BindOutcome<B> = { status: "BOUND"; proposal: B } | BindNotExecuted;

/**
 * Domain adapter — the only two operations the Core knows.
 * I: data-only intent. B: opaque proposal, forged by bind, consumed only by apply.
 *
 * Adapter contract (domain responsibility — the Core implements none of it):
 *  - bind(intent) is READ-ONLY: fail-closed eligibility + observation of the
 *    relevant state -> BOUND | NOT_EXECUTED(stage ELIGIBILITY|OBSERVATION).
 *  - apply(proposal) is the ONLY potentially mutating boundary: re-prove the
 *    proposal's observation against the current state, refuse with
 *    NOT_EXECUTED(stage COMPATIBILITY, zero mutation) on mismatch, execute only
 *    the declared effect, then adjudicate the postcondition with sufficient
 *    domain evidence (post-read, independent read, or authoritative transactional
 *    result — the domain's choice).
 * The adapter is constructed by the operator; power (credentials, roots,
 * allowlists, endpoints) is closed inside it — never accepted from the caller.
 */
export interface DomainAdapter<I, B> {
  bind(intent: I): BindOutcome<B> | Promise<BindOutcome<B>>;
  apply(proposal: B): GuardianResult | Promise<GuardianResult>;
}

function failureReasons(label: string, error: unknown): string[] {
  return [label, error instanceof Error ? error.message : String(error)];
}

/**
 * Execute one governed intent — the entire Core.
 * Sequential, no state machine, no persistence: bind -> gate -> apply -> result.
 */
export async function executeGuardianIntent<I, B>(
  intent: I,
  adapter: DomainAdapter<I, B>,
): Promise<GuardianResult> {
  let bound: BindOutcome<B>;
  try {
    bound = await adapter.bind(intent);
  } catch (error) {
    // bind is read-only by contract: the mutating boundary was never reached.
    // dispatched=false and NONE_PROVEN are proven facts here (apply was never
    // invoked and all effects flow through it) — not an invention. The run
    // itself is unadjudicable -> INDETERMINATE; never OCCURRED, never success.
    return {
      outcome: "INDETERMINATE",
      effect: { dispatched: false, state: "NONE_PROVEN" },
      reasons: failureReasons("BIND_FAILED", error),
    };
  }

  if (!("status" in bound)) {
    // Fail-closed gate: preserve the adapter's NOT_EXECUTED verbatim (zero mutation).
    return bound;
  }

  try {
    // The single controlled dispatch: the opaque proposal is forwarded unchanged.
    return await adapter.apply(bound.proposal);
  } catch (error) {
    // The boundary WAS reached (dispatched=true) but no trustworthy adjudication
    // exists: occurrence is UNDETERMINED. Never SUCCESS_PROVEN, never NONE_PROVEN.
    return {
      outcome: "INDETERMINATE",
      effect: { dispatched: true, state: "UNDETERMINED" },
      reasons: failureReasons("APPLY_FAILED", error),
    };
  }
}
