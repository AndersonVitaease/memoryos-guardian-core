import { describe, expect, it } from "vitest";
import {
  type BindNotExecuted,
  type BindOutcome,
  type DomainAdapter,
  type GuardianResult,
  executeGuardianIntent,
} from "../src/guardianCore";

type Recorder = { calls: string[]; bindCalls: number; applyCalls: number };

function recorder(): Recorder {
  return { calls: [], bindCalls: 0, applyCalls: 0 };
}

type Script<I, B> = {
  bind: (intent: I) => BindOutcome<B> | Promise<BindOutcome<B>>;
  apply?: (proposal: B) => GuardianResult | Promise<GuardianResult>;
};

/** Minimal fake adapter: scripts bind/apply, records every call in strict order. */
function fakeAdapter<I, B>(script: Script<I, B>, rec: Recorder): DomainAdapter<I, B> {
  return {
    bind(intent) {
      rec.calls.push("bind");
      rec.bindCalls += 1;
      return script.bind(intent);
    },
    apply(proposal) {
      rec.calls.push("apply");
      rec.applyCalls += 1;
      if (!script.apply) throw new Error("APPLY_MUST_NOT_BE_CALLED");
      return script.apply(proposal);
    },
  };
}

function notExecuted(
  stage: "ELIGIBILITY" | "OBSERVATION" | "COMPATIBILITY",
  refusal: "BLOCKED" | "UNDETERMINED",
  reasons: string[],
): BindNotExecuted {
  return {
    outcome: "NOT_EXECUTED",
    stage,
    refusal,
    effect: { dispatched: false, state: "NONE_PROVEN" },
    reasons,
  };
}

describe("Guardian Core v0.1", () => {
  it("TEST 1 — eligibility block: apply never called, NOT_EXECUTED, proven zero effect", async () => {
    const rec = recorder();
    const adapter = fakeAdapter<string, object>(
      { bind: () => notExecuted("ELIGIBILITY", "BLOCKED", ["TARGET_NOT_IN_SCOPE"]) },
      rec,
    );

    const result = await executeGuardianIntent("merge-pr-1", adapter);

    expect(result).toEqual({
      outcome: "NOT_EXECUTED",
      stage: "ELIGIBILITY",
      refusal: "BLOCKED",
      effect: { dispatched: false, state: "NONE_PROVEN" },
      reasons: ["TARGET_NOT_IN_SCOPE"],
    });
    expect(rec.applyCalls).toBe(0);
    expect(rec.calls).toEqual(["bind"]);
  });

  it("TEST 2 — observation undetermined: NOT_EXECUTED/OBSERVATION/UNDETERMINED, apply never called", async () => {
    const rec = recorder();
    const adapter = fakeAdapter<string, object>(
      { bind: () => notExecuted("OBSERVATION", "UNDETERMINED", ["OBSERVATION_UNAVAILABLE"]) },
      rec,
    );

    const result = await executeGuardianIntent("redeploy-app", adapter);

    expect(result).toEqual({
      outcome: "NOT_EXECUTED",
      stage: "OBSERVATION",
      refusal: "UNDETERMINED",
      effect: { dispatched: false, state: "NONE_PROVEN" },
      reasons: ["OBSERVATION_UNAVAILABLE"],
    });
    expect(rec.applyCalls).toBe(0);
  });

  it("TEST 3 — bound -> success: exactly one bind and one apply, result and evidence preserved", async () => {
    const rec = recorder();
    const adapter = fakeAdapter<string, { marker: number }>(
      {
        bind: async () => ({ status: "BOUND", proposal: { marker: 7 } }),
        apply: async () => ({
          outcome: "SUCCESS_PROVEN",
          effect: { dispatched: true, state: "OCCURRED" },
          evidence: { kind: "post-read-equal" },
        }),
      },
      rec,
    );

    const result = await executeGuardianIntent("change-file", adapter);

    expect(result).toEqual({
      outcome: "SUCCESS_PROVEN",
      effect: { dispatched: true, state: "OCCURRED" },
      evidence: { kind: "post-read-equal" },
    });
    expect(rec.bindCalls).toBe(1);
    expect(rec.applyCalls).toBe(1);
  });

  it("TEST 4 — compatibility invalidated: NOT_EXECUTED/COMPATIBILITY with proven zero mutation preserved", async () => {
    const rec = recorder();
    const invalidated: GuardianResult = {
      outcome: "NOT_EXECUTED",
      stage: "COMPATIBILITY",
      refusal: "BLOCKED",
      effect: { dispatched: true, state: "NONE_PROVEN" },
      reasons: ["BINDING_INVALIDATED"],
    };
    const adapter = fakeAdapter<string, object>(
      { bind: () => ({ status: "BOUND", proposal: {} }), apply: () => invalidated },
      rec,
    );

    const result = await executeGuardianIntent("merge-pr-1", adapter);

    expect(result).toStrictEqual(invalidated);
    expect(rec.applyCalls).toBe(1);
  });

  it("TEST 5 — failure proven: postcondition proven NOT reached, never promoted to success", async () => {
    const rec = recorder();
    const adapter = fakeAdapter<string, object>(
      {
        bind: () => ({ status: "BOUND", proposal: {} }),
        apply: () => ({
          outcome: "FAILURE_PROVEN",
          effect: { dispatched: true, state: "OCCURRED" },
          evidence: { kind: "read-back-mismatch" },
          reasons: ["FINAL_CONTENT_DOES_NOT_MATCH_INTENDED"],
        }),
      },
      rec,
    );

    const result = await executeGuardianIntent("change-file", adapter);

    expect(result.outcome).toBe("FAILURE_PROVEN");
    expect(result).toEqual({
      outcome: "FAILURE_PROVEN",
      effect: { dispatched: true, state: "OCCURRED" },
      evidence: { kind: "read-back-mismatch" },
      reasons: ["FINAL_CONTENT_DOES_NOT_MATCH_INTENDED"],
    });
  });

  it("TEST 6 — apply returns INDETERMINATE: Core preserves it exactly, never converts", async () => {
    const rec = recorder();
    const indeterminate: GuardianResult = {
      outcome: "INDETERMINATE",
      effect: { dispatched: true, state: "UNDETERMINED" },
      reasons: ["DEPLOY_TIMEOUT_NO_ADJUDICATION"],
    };
    const adapter = fakeAdapter<string, object>(
      { bind: () => ({ status: "BOUND", proposal: {} }), apply: () => indeterminate },
      rec,
    );

    const result = await executeGuardianIntent("redeploy-app", adapter);

    expect(result).toStrictEqual(indeterminate);
    expect(result.outcome).not.toBe("SUCCESS_PROVEN");
    expect(result.outcome).not.toBe("FAILURE_PROVEN");
  });

  it("TEST 7 — bind throws: apply never called, INDETERMINATE, boundary NOT dispatched", async () => {
    const rec = recorder();
    const adapter = fakeAdapter<string, object>(
      {
        bind: () => {
          throw new Error("boom");
        },
      },
      rec,
    );

    const result = await executeGuardianIntent("merge-pr-1", adapter);

    expect(result).toEqual({
      outcome: "INDETERMINATE",
      effect: { dispatched: false, state: "NONE_PROVEN" },
      reasons: ["BIND_FAILED", "boom"],
    });
    expect(rec.applyCalls).toBe(0);
    const effect = (result as Extract<GuardianResult, { outcome: "INDETERMINATE" }>).effect;
    expect(effect.dispatched).toBe(false);
    expect(effect.state).not.toBe("OCCURRED");
  });

  it("TEST 8 — apply throws: boundary dispatched, occurrence UNDETERMINED, never success/NONE_PROVEN", async () => {
    const rec = recorder();
    const adapter = fakeAdapter<string, object>(
      {
        bind: () => ({ status: "BOUND", proposal: {} }),
        apply: () => {
          throw new Error("kaput");
        },
      },
      rec,
    );

    const result = await executeGuardianIntent("merge-pr-1", adapter);

    expect(result).toEqual({
      outcome: "INDETERMINATE",
      effect: { dispatched: true, state: "UNDETERMINED" },
      reasons: ["APPLY_FAILED", "kaput"],
    });
    const effect = (result as Extract<GuardianResult, { outcome: "INDETERMINATE" }>).effect;
    expect(effect.dispatched).toBe(true);
    expect(effect.state).not.toBe("NONE_PROVEN");
    expect(result.outcome).not.toBe("SUCCESS_PROVEN");
  });

  it("TEST 9 — result passthrough: every adapter adjudication is preserved verbatim", async () => {
    const scripted: GuardianResult[] = [
      {
        outcome: "SUCCESS_PROVEN",
        effect: { dispatched: true, state: "OCCURRED" },
        evidence: { kind: "independent-get" },
      },
      {
        outcome: "FAILURE_PROVEN",
        effect: { dispatched: true, state: "OCCURRED" },
        evidence: { kind: "read-back" },
        reasons: ["POSTCONDITION_NOT_REACHED"],
      },
      {
        outcome: "INDETERMINATE",
        effect: { dispatched: true, state: "UNDETERMINED" },
        reasons: ["NO_SUFFICIENT_EVIDENCE"],
      },
      {
        outcome: "NOT_EXECUTED",
        stage: "COMPATIBILITY",
        refusal: "BLOCKED",
        effect: { dispatched: true, state: "NONE_PROVEN" },
        reasons: ["INVALIDATED"],
      },
    ];

    for (const scriptedResult of scripted) {
      const rec = recorder();
      const adapter = fakeAdapter<number, object>(
        { bind: () => ({ status: "BOUND", proposal: {} }), apply: () => scriptedResult },
        rec,
      );
      const result = await executeGuardianIntent(1, adapter);
      expect(result).toStrictEqual(scriptedResult);
    }
  });

  it("TEST 10 — opaque proposal: Core forwards the exact same reference, no transformation", async () => {
    const rec = recorder();
    const opaque = Object.freeze({ sealed: Symbol("opaque-proposal") });
    let received: unknown;
    const adapter = fakeAdapter<string, object>(
      {
        bind: () => ({ status: "BOUND", proposal: opaque }),
        apply: (proposal) => {
          received = proposal;
          return {
            outcome: "SUCCESS_PROVEN",
            effect: { dispatched: true, state: "OCCURRED" },
            evidence: { kind: "proof" },
          };
        },
      },
      rec,
    );

    await executeGuardianIntent("change-file", adapter);

    expect(received).toBe(opaque); // identity: no clone, no reinterpretation
  });

  it("TEST 11 — strict call order: bind -> apply, never apply first, never twice", async () => {
    const rec = recorder();
    const adapter = fakeAdapter<string, object>(
      {
        bind: () => ({ status: "BOUND", proposal: {} }),
        apply: () => ({
          outcome: "SUCCESS_PROVEN",
          effect: { dispatched: true, state: "OCCURRED" },
          evidence: { kind: "proof" },
        }),
      },
      rec,
    );

    await executeGuardianIntent("merge-pr-1", adapter);

    expect(rec.calls).toEqual(["bind", "apply"]);
    expect(rec.applyCalls).toBe(1);
  });

  it("TEST 12 — no generic retry: apply invoked exactly once even when it throws", async () => {
    const rec = recorder();
    const adapter = fakeAdapter<string, object>(
      {
        bind: () => ({ status: "BOUND", proposal: {} }),
        apply: () => {
          throw new Error("kaput");
        },
      },
      rec,
    );

    const result = await executeGuardianIntent("merge-pr-1", adapter);

    expect(rec.applyCalls).toBe(1);
    expect(result.outcome).toBe("INDETERMINATE");
  });

  it("AUTHORITY — public surface is structural: exactly (intent, adapter); adapter exposes only bind/apply", () => {
    // The public function has exactly two parameters — no credential/token/URL/root/
    // shell/HTTP-method/mutation-callback/filesystem-primitive slot exists.
    expect(executeGuardianIntent.length).toBe(2);

    // Compile-time structural check: Record over keyof DomainAdapter requires the
    // literal to have EXACTLY the adapter's keys — extra or missing keys fail tsc.
    const adapterKeys: Record<keyof DomainAdapter<unknown, unknown>, true> = {
      bind: true,
      apply: true,
    };
    expect(Object.keys(adapterKeys).sort()).toEqual(["apply", "bind"]);
  });
});
