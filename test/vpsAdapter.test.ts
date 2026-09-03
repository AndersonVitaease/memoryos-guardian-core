/**
 * GC-04 — Conformance tests: VPS adapter (engineering.vps.change.safe /
 * application-redeploy) over Guardian Core v0.1.
 *
 * All fakes reuse the certified VPS Guardian Pro test pattern (scripted
 * ApplicationDeploymentAdapter + recording SafeChangeAdapter over a plain
 * ProContext). Deterministic, HTTP-free: no real VPS/Dokploy is ever
 * touched and no real mutation can occur.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CHANGE_SAFE_ACTION,
  type ResolvedApplicationTarget,
} from "../../memoryos-vps-guardian-pro/src/change/changeSafe";
import { CHANGE_MUTATION_TOOL } from "../../memoryos-vps-guardian-pro/src/change/safeChangeAdapter";
import type { ProContext } from "../../memoryos-vps-guardian-pro/src/proContext";
import { createVpsAdapter } from "../src/vpsAdapter";
import type { VpsAdapterDeps, VpsIntent, VpsProposal } from "../src/vpsAdapter";
import { executeGuardianIntent, type DomainAdapter } from "../src/guardianCore";

// ---- deterministic fixtures (fixed timestamps; synthetic "fake"/"r-*" values only) ----

const healthyHost = {
  uptimeSeconds: 987654,
  cpuCount: 4,
  loadAverage1m: 0.4,
  memoryTotalBytes: 17_179_869_184,
  memoryFreeBytes: 8_589_934_592,
};

const healthyApp = {
  applicationId: "app-1",
  observedAt: "2026-09-02T12:00:00Z",
  source: "release-state-file",
  deploymentStatus: "SUCCEEDED",
  applicationHealthy: true,
  currentReleaseId: "r-2",
  previousReleaseId: "r-1",
  lastDeploymentFinishedAt: "2026-09-02T11:00:00Z",
};

const newReleaseApp = {
  ...healthyApp,
  observedAt: "2026-09-02T13:00:00Z",
  currentReleaseId: "r-3",
  previousReleaseId: "r-2",
  lastDeploymentFinishedAt: "2026-09-02T12:59:00Z",
};

const driftedApp = {
  ...healthyApp,
  observedAt: "2026-09-02T12:30:00Z",
  currentReleaseId: "r-4",
};

const failedDeploymentApp = {
  ...healthyApp,
  observedAt: "2026-09-02T13:00:00Z",
  deploymentStatus: "FAILED",
  lastDeploymentFinishedAt: "2026-09-02T12:59:00Z",
};

const pendingDeploymentApp = {
  ...healthyApp,
  observedAt: "2026-09-02T13:00:00Z",
  deploymentStatus: "IN_PROGRESS",
};

const healthyDocker = {
  runtimeAvailable: true,
  observedAt: "2026-09-02T12:00:00Z",
  source: "docker-health-file",
  containers: { total: 2, running: 2, unhealthy: 0, restarting: 0, stopped: 0, unknown: 0 },
};

const ALLOWLIST = { gateway: { applicationId: "app-1", applicationName: "Gateway" } };

/** Application evidence adapter returning a scripted sequence of snapshots (VPS Pro pattern). */
function scriptedAppAdapter(snapshots: Array<Record<string, unknown> | null>) {
  let index = 0;
  return {
    name: "app-scripted",
    calls: 0,
    collect(): Record<string, unknown> | null {
      const evidence = snapshots[Math.min(index, snapshots.length - 1)];
      index += 1;
      this.calls += 1;
      return evidence;
    },
  };
}

/** Deterministic SafeChangeAdapter fake: records calls, performs no real mutation (VPS Pro pattern). */
function fakeSafeChangeAdapter(outcome: { accepted: boolean; ref?: string | null; message?: string } = { accepted: true }) {
  const calls: Array<{ resolved: ResolvedApplicationTarget; correlationKey: string }> = [];
  return {
    name: "fake-safe-change",
    calls,
    async redeploy(resolved: ResolvedApplicationTarget, correlationKey: string) {
      calls.push({ resolved, correlationKey });
      return outcome.accepted
        ? { accepted: true, ref: outcome.ref ?? null, message: outcome.message ?? "fake accepted" }
        : { accepted: false, ref: null, message: outcome.message ?? "fake upstream failure" };
    },
  };
}

interface Overrides {
  appSnapshots?: Array<Record<string, unknown> | null>;
  appAdapter?: ReturnType<typeof scriptedAppAdapter>;
  safeChangeAdapter?: ReturnType<typeof fakeSafeChangeAdapter> | null;
  changeTargets?: Record<string, { applicationId: string; applicationName: string }>;
}

function makeCtx(o: Overrides = {}): ProContext {
  return {
    systemHealthAdapter: { name: "sys-fake", collect: () => healthyHost },
    applicationDeploymentAdapter: o.appAdapter ?? scriptedAppAdapter(o.appSnapshots ?? [healthyApp]),
    dockerHealthAdapter: { name: "docker-fake", collect: () => healthyDocker },
    logEvidenceAdapter: null,
    changeTargets: o.changeTargets ?? ALLOWLIST,
    safeChangeAdapter: o.safeChangeAdapter ?? fakeSafeChangeAdapter(),
  } as unknown as ProContext;
}

function deps(ctx: ProContext): VpsAdapterDeps {
  return { ctx };
}

const intent = (target = "gateway"): VpsIntent => ({ target, action: "redeploy" });

beforeEach(() => {
  // Metadata-only audit logs from the frozen domain stay silent in tests.
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GC-04 — VPS conformance adapter", () => {
  it("TEST 1 — ELIGIBILITY BLOCK: alvo/ação inelegível → NOT_EXECUTED, zero mutation", async () => {
    const mutation = fakeSafeChangeAdapter();
    const unknownTarget = await executeGuardianIntent(
      { target: "not-configured", action: "redeploy" },
      createVpsAdapter(deps(makeCtx({ safeChangeAdapter: mutation, changeTargets: {} }))),
    );
    expect(unknownTarget).toMatchObject({
      outcome: "NOT_EXECUTED",
      stage: "ELIGIBILITY",
      refusal: "BLOCKED",
      effect: { dispatched: false, state: "NONE_PROVEN" },
    });
    if (unknownTarget.outcome === "NOT_EXECUTED") {
      expect(unknownTarget.reasons).toContain("TARGET_CONFIGURED");
    }

    const hostileAction = await executeGuardianIntent(
      { target: "gateway", action: "destroy" as unknown as "redeploy" },
      createVpsAdapter(deps(makeCtx({ safeChangeAdapter: mutation }))),
    );
    expect(hostileAction).toMatchObject({
      outcome: "NOT_EXECUTED",
      stage: "ELIGIBILITY",
      refusal: "BLOCKED",
      effect: { dispatched: false, state: "NONE_PROVEN" },
    });
    expect(mutation.calls.length).toBe(0); // apply nunca alcançado
  });

  it("TEST 2 — BIND SUCCESS: proposta BOUND opaca, zero efeito persistente", () => {
    const mutation = fakeSafeChangeAdapter();
    const read = scriptedAppAdapter([healthyApp]);
    const bound = createVpsAdapter(deps(makeCtx({ appAdapter: read, safeChangeAdapter: mutation }))).bind({
      target: "gateway",
      action: "redeploy",
    });
    expect("status" in bound && bound.status === "BOUND").toBe(true);
    if ("status" in bound) {
      expect(bound.proposal.target).toBe("gateway");
      expect(bound.proposal.proposalFingerprint).toMatch(/^[0-9a-f]{64}$/);
      // Opaque plain data: no behavior leaks through the proposal boundary.
      expect(Object.values(bound.proposal).every((value) => typeof value !== "function")).toBe(true);
    }
    expect(read.calls).toBe(1); // read-only observation only
    expect(mutation.calls.length).toBe(0); // no persistent effect
  });

  it("TEST 3 — STALE/DRIFT: bind observa A, estado vira B antes do apply → NOT_EXECUTED/COMPATIBILITY, mutation primitive não chamada, nunca SUCCESS", async () => {
    const mutation = fakeSafeChangeAdapter();
    const result = await executeGuardianIntent(
      { target: "gateway", action: "redeploy" },
      createVpsAdapter(deps(makeCtx({ appSnapshots: [healthyApp, driftedApp], safeChangeAdapter: mutation }))),
    );
    expect(result).toMatchObject({
      outcome: "NOT_EXECUTED",
      stage: "COMPATIBILITY",
      refusal: "BLOCKED",
      effect: { dispatched: true, state: "NONE_PROVEN" },
    });
    expect(result.outcome).not.toBe("SUCCESS_PROVEN");
    if (result.outcome === "NOT_EXECUTED") {
      expect(result.reasons).toContain("VPS04_SNAPSHOT_CHANGED");
    }
    expect(mutation.calls.length).toBe(0); // a decisão stale nunca alcançou a primitive
  });

  it("TEST 4 — CONTROLLED EFFECT: somente a primitive certificada esperada é chamada, com alvo operator-resolved", async () => {
    const mutation = fakeSafeChangeAdapter();
    const result = await executeGuardianIntent(
      { target: "gateway", action: "redeploy" },
      createVpsAdapter(deps(makeCtx({ appSnapshots: [healthyApp, healthyApp, newReleaseApp], safeChangeAdapter: mutation }))),
    );
    expect(result).toMatchObject({ outcome: "SUCCESS_PROVEN" });
    expect(mutation.calls.length).toBe(1);
    // Operator-resolved target from the allowlist — never caller-supplied data.
    expect(mutation.calls[0]?.resolved).toEqual({ applicationId: "app-1", applicationName: "Gateway" });
    expect(mutation.calls[0]?.correlationKey).toMatch(/^[0-9a-f]{64}$/);
    // The closed mutation allowlist: one tool, one capability, no shell surface.
    expect(CHANGE_MUTATION_TOOL).toBe("application-redeploy");
    const adapter = createVpsAdapter(deps(makeCtx()));
    expect(Object.keys(adapter).sort()).toEqual(["apply", "bind"]);
  });

  it("TEST 5 — VERIFIED SUCCESS: mutation + post-validation comprovam nova release → SUCCESS_PROVEN, OCCURRED, evidence preservada", async () => {
    const mutation = fakeSafeChangeAdapter({ accepted: true, ref: "fake-deploy-77" });
    const result = await executeGuardianIntent(
      { target: "gateway", action: "redeploy" },
      createVpsAdapter(deps(makeCtx({ appSnapshots: [healthyApp, healthyApp, newReleaseApp], safeChangeAdapter: mutation }))),
    );
    expect(result).toMatchObject({ outcome: "SUCCESS_PROVEN", effect: { dispatched: true, state: "OCCURRED" } });
    if (result.outcome === "SUCCESS_PROVEN") {
      const evidence = result.evidence as {
        postValidation?: { status?: string; currentReleaseId?: string | null };
        mutation?: { occurred?: boolean | null; ref?: string | null };
      };
      expect(evidence.postValidation?.status).toBe("VERIFIED");
      expect(evidence.postValidation?.currentReleaseId).toBe("r-3");
      expect(evidence.mutation).toMatchObject({ occurred: true, ref: "fake-deploy-77" });
    }
  });

  it("TEST 6 — BACKEND ACCEPTANCE ≠ SUCCESS: aceito sem pós-condição provada → nunca SUCCESS_PROVEN (INDETERMINATE)", async () => {
    const mutation = fakeSafeChangeAdapter();
    // Post read still shows SUCCEEDED but with NO new release/finish: unprovable.
    const result = await executeGuardianIntent(
      { target: "gateway", action: "redeploy" },
      createVpsAdapter(deps(makeCtx({ appSnapshots: [healthyApp, healthyApp, healthyApp], safeChangeAdapter: mutation }))),
    );
    expect(result).toMatchObject({ outcome: "INDETERMINATE", effect: { dispatched: true, state: "UNDETERMINED" } });
    expect(result.outcome).not.toBe("SUCCESS_PROVEN");
    if (result.outcome === "INDETERMINATE") {
      expect(result.reasons).toContain("VPS04_UNKNOWN_REQUIRES_HUMAN_REVIEW");
    }
    expect(mutation.calls.length).toBe(1);
  });

  it("TEST 7 — POST-VALIDATION FAILURE: pós-condição comprovadamente não alcançada → FAILURE_PROVEN (e PENDING → INDETERMINATE)", async () => {
    const mutation = fakeSafeChangeAdapter();
    const failed = await executeGuardianIntent(
      { target: "gateway", action: "redeploy" },
      createVpsAdapter(deps(makeCtx({ appSnapshots: [healthyApp, healthyApp, failedDeploymentApp], safeChangeAdapter: mutation }))),
    );
    expect(failed).toMatchObject({ outcome: "FAILURE_PROVEN", effect: { dispatched: true, state: "OCCURRED" } });
    if (failed.outcome === "FAILURE_PROVEN") {
      const evidence = failed.evidence as { postValidation?: { status?: string } };
      expect(evidence.postValidation?.status).toBe("FAILED");
    }

    const mutation2 = fakeSafeChangeAdapter();
    const pending = await executeGuardianIntent(
      { target: "gateway", action: "redeploy" },
      createVpsAdapter(deps(makeCtx({ appSnapshots: [healthyApp, healthyApp, pendingDeploymentApp], safeChangeAdapter: mutation2 }))),
    );
    expect(pending).toMatchObject({ outcome: "INDETERMINATE", effect: { dispatched: true, state: "UNDETERMINED" } });
    expect(pending.outcome).not.toBe("SUCCESS_PROVEN");
    expect(mutation2.calls.length).toBe(1); // no retry on pending
  });

  it("TEST 8 — UNKNOWN: estado operacional não estabelecível (bind e apply) → nunca inventa elegibilidade nem sucesso", async () => {
    const mutationBind = fakeSafeChangeAdapter();
    const bindResult = await executeGuardianIntent(
      { target: "gateway", action: "redeploy" },
      createVpsAdapter(deps(makeCtx({ appSnapshots: [{ ...healthyApp, deploymentStatus: null }], safeChangeAdapter: mutationBind }))),
    );
    expect(bindResult).toMatchObject({
      outcome: "NOT_EXECUTED",
      stage: "OBSERVATION",
      refusal: "UNDETERMINED",
      effect: { dispatched: false, state: "NONE_PROVEN" },
    });
    if (bindResult.outcome === "NOT_EXECUTED") {
      expect(bindResult.reasons).toContain("DEPLOYMENT_STATE_KNOWN");
    }
    expect(mutationBind.calls.length).toBe(0);

    const mutationApply = fakeSafeChangeAdapter();
    const applyResult = await executeGuardianIntent(
      { target: "gateway", action: "redeploy" },
      createVpsAdapter(deps(makeCtx({ appSnapshots: [healthyApp, { ...healthyApp, deploymentStatus: null }], safeChangeAdapter: mutationApply }))),
    );
    expect(applyResult).toMatchObject({
      outcome: "NOT_EXECUTED",
      stage: "COMPATIBILITY",
      refusal: "UNDETERMINED",
      effect: { dispatched: true, state: "NONE_PROVEN" },
    });
    expect(mutationApply.calls.length).toBe(0); // zero mutation
  });

  it("TEST 9 — AUTHORITY STRUCTURAL: API pública data-only; campos hostis do caller são estruturalmente ignorados", async () => {
    // Data-only intent: exactly the two logical fields.
    const intentKeys: Record<keyof VpsIntent, true> = { action: true, target: true };
    expect(Object.keys(intentKeys).sort()).toEqual(["action", "target"]);
    // Adapter deps are the operator-owned composition context only — no credential/endpoint/shell/retry policy.
    const depKeys: Record<keyof VpsAdapterDeps, true> = { ctx: true };
    expect(Object.keys(depKeys).sort()).toEqual(["ctx"]);
    expect(executeGuardianIntent.length).toBe(2);

    // Runtime: hostile extra fields (credential, endpoint, applicationId, tool, retries) are ignored.
    const mutation = fakeSafeChangeAdapter();
    const hostile = {
      target: "gateway",
      action: "redeploy",
      dokployToken: "fake-credential-value",
      endpoint: "https://evil.example",
      applicationId: "app-EVIL",
      toolName: "arbitrary-shell",
      retries: 5,
    } as unknown as VpsIntent;
    const result = await executeGuardianIntent(
      hostile,
      createVpsAdapter(deps(makeCtx({ appSnapshots: [healthyApp, healthyApp, newReleaseApp], safeChangeAdapter: mutation }))),
    );
    expect(result).toMatchObject({ outcome: "SUCCESS_PROVEN" });
    expect(mutation.calls[0]?.resolved).toEqual({ applicationId: "app-1", applicationName: "Gateway" });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("fake-credential-value");
    expect(serialized).not.toContain("app-EVIL");
    expect(serialized).not.toContain("arbitrary-shell");
  });

  it("TEST 10 — CORE DOES NOT RETRY: apply indeterminado → executeGuardianIntent invoca apply exatamente uma vez", async () => {
    const mutation = fakeSafeChangeAdapter({ accepted: false, message: "FAKE_UPSTREAM_FAILURE" });
    const base = createVpsAdapter(deps(makeCtx({ appSnapshots: [healthyApp, healthyApp], safeChangeAdapter: mutation })));
    let applyInvocations = 0;
    const counting: DomainAdapter<VpsIntent, VpsProposal> = {
      bind: (intent) => base.bind(intent),
      apply: (proposal) => {
        applyInvocations += 1;
        return base.apply(proposal);
      },
    };
    const result = await executeGuardianIntent({ target: "gateway", action: "redeploy" }, counting);
    expect(result).toMatchObject({ outcome: "INDETERMINATE", effect: { dispatched: true, state: "UNDETERMINED" } });
    expect(applyInvocations).toBe(1); // Core never re-calls apply
    expect(mutation.calls.length).toBe(1); // and the domain never re-attempted the mutation
  });
});
