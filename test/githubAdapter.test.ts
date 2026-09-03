/**
 * GC-03 — Conformance tests: GitHub adapter over Guardian Core v0.1.
 *
 * All HTTP-free and zero real GitHub mutations: the read/write doubles reuse
 * the certified GH-00 test pattern (scripted PullRequestAdapter + recording
 * PullRequestMergeAdapter). No DI beyond what GH-00 itself already requires.
 */
import { describe, expect, it } from "vitest";

import type {
  PullRequestAdapter,
  PullRequestEvidence,
  PullRequestQuery,
} from "../../memoryos-github-guardian-proof/src/githubAdapter";
import type {
  MergeBackendOutcome,
  PullRequestMergeAdapter,
} from "../../memoryos-github-guardian-proof/src/githubPullRequestMergeAdapter";
import { createGithubAdapter } from "../src/githubAdapter";
import type { GithubAdapterDeps, GithubIntent, GithubProposal } from "../src/githubAdapter";
import { executeGuardianIntent, type DomainAdapter } from "../src/guardianCore";

const REPO = "AndersonVitaease/memoryos-github-guardian-proof";
const OTHER_REPO = "AndersonVitaease/not-allowlisted";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function evidence(overrides: Partial<PullRequestEvidence> = {}): PullRequestEvidence {
  return {
    repository: REPO,
    pullRequestNumber: 1,
    state: "OPEN",
    baseBranch: "main",
    headBranch: "gc03/conformance",
    headSha: SHA_A,
    mergeableState: "MERGEABLE",
    checks: [],
    ...overrides,
  };
}

/** Read-only evidence adapter with scripted responses per call (GH-00 pattern). */
class ScriptedReadAdapter implements PullRequestAdapter {
  readonly calls: PullRequestQuery[] = [];
  constructor(private readonly script: Array<PullRequestEvidence | null>) {}
  async getPullRequestEvidence(query: PullRequestQuery): Promise<PullRequestEvidence | null> {
    this.calls.push({ ...query });
    const next = this.script.shift();
    return next ?? null;
  }
}

/** Records every merge attempt; zero retry is observable through its length (GH-00 pattern). */
class RecordingMergeAdapter implements PullRequestMergeAdapter {
  readonly calls: Array<{ repository: string; pullRequestNumber: number; expectedHeadSha: string }> = [];
  constructor(private readonly result: MergeBackendOutcome) {}
  async mergePullRequest(request: {
    repository: string;
    pullRequestNumber: number;
    expectedHeadSha: string;
  }): Promise<MergeBackendOutcome> {
    this.calls.push({ ...request });
    return { ...this.result };
  }
}

const ACCEPTED: MergeBackendOutcome = { result: "ACCEPTED", reason: "MERGE_BACKEND_ACCEPTED", backendStatus: 200 };
const SHA_MISMATCH_409: MergeBackendOutcome = { result: "REJECTED", reason: "MERGE_REJECTED_PRECONDITION_SHA_OR_STATE", backendStatus: 409 };
const NETWORK_AMBIGUOUS: MergeBackendOutcome = { result: "AMBIGUOUS", reason: "MERGE_BACKEND_AMBIGUOUS_NETWORK", backendStatus: null };

function intent(repository: string = REPO, pullNumber = 1): GithubIntent {
  return { repository, pullNumber };
}

describe("GC-03 — GitHub conformance adapter", () => {
  it("TEST 1 — ELIGIBILITY BLOCK: repo/PR inelegível → NOT_EXECUTED, zero mutation, apply nunca alcançado", async () => {
    const merge = new RecordingMergeAdapter(ACCEPTED);
    const read = new ScriptedReadAdapter([]);
    const notAllowed = await executeGuardianIntent(
      intent(OTHER_REPO),
      createGithubAdapter({ adapter: read, mergeAdapter: merge }),
    );
    expect(notAllowed).toMatchObject({
      outcome: "NOT_EXECUTED",
      stage: "ELIGIBILITY",
      refusal: "BLOCKED",
      effect: { dispatched: false, state: "NONE_PROVEN" },
    });
    if (notAllowed.outcome === "NOT_EXECUTED") {
      expect(notAllowed.reasons).toContain("REPOSITORY_NOT_ALLOWED");
    }

    const missing = new ScriptedReadAdapter([null]); // PR definitivamente inexistente
    const merge2 = new RecordingMergeAdapter(ACCEPTED);
    const notFound = await executeGuardianIntent(
      intent(),
      createGithubAdapter({ adapter: missing, mergeAdapter: merge2 }),
    );
    expect(notFound).toMatchObject({
      outcome: "NOT_EXECUTED",
      stage: "ELIGIBILITY",
      refusal: "BLOCKED",
      effect: { dispatched: false, state: "NONE_PROVEN" },
    });
    if (notFound.outcome === "NOT_EXECUTED") {
      expect(notFound.reasons).toContain("PULL_REQUEST_NOT_FOUND");
    }
    expect(merge.calls.length).toBe(0);
    expect(merge2.calls.length).toBe(0);
  });

  it("TEST 2 — BIND SUCCESS: proposta BOUND produzida, opaca ao Core, nenhum efeito persistente", async () => {
    const read = new ScriptedReadAdapter([evidence()]);
    const merge = new RecordingMergeAdapter(ACCEPTED);
    const bound = await createGithubAdapter({ adapter: read, mergeAdapter: merge }).bind(intent());
    expect("status" in bound && bound.status === "BOUND").toBe(true);
    if ("status" in bound) {
      expect(bound.proposal.repository).toBe(REPO);
      expect(bound.proposal.pullNumber).toBe(1);
      expect(bound.proposal.proposalFingerprint).toMatch(/^[0-9a-f]{64}$/);
      // Opaque plain data: no behavior leaks through the proposal boundary.
      expect(Object.values(bound.proposal).every((value) => typeof value !== "function")).toBe(true);
    }
    expect(read.calls.length).toBe(1); // read-only observation only
    expect(merge.calls.length).toBe(0); // no persistent effect
  });

  it("TEST 3 — STALE STATE: bind observa A, estado vira B antes do apply → NOT_EXECUTED/COMPATIBILITY, zero mutation, nunca SUCCESS", async () => {
    const merge = new RecordingMergeAdapter(ACCEPTED);
    const read = new ScriptedReadAdapter([
      evidence({ headSha: SHA_A }), // bind observa A
      evidence({ headSha: SHA_B }), // o mundo mudou para B antes do apply
    ]);
    const result = await executeGuardianIntent(
      intent(),
      createGithubAdapter({ adapter: read, mergeAdapter: merge }),
    );
    expect(result).toMatchObject({
      outcome: "NOT_EXECUTED",
      stage: "COMPATIBILITY",
      refusal: "BLOCKED",
      effect: { dispatched: true, state: "NONE_PROVEN" },
    });
    expect(result.outcome).not.toBe("SUCCESS_PROVEN");
    if (result.outcome === "NOT_EXECUTED") {
      expect(result.reasons).toContain("SNAPSHOT_FINGERPRINT_MISMATCH");
    }
    expect(merge.calls.length).toBe(0); // a decisão stale nunca alcançou o backend
  });

  it("TEST 4 — NATIVE SHA PRECONDITION: SHA da mutation vem da evidência fresca; SHA/credenciais do caller são ignoradas; 409 → zero mutation", async () => {
    // (a) caller-supplied SHA/token/URL are structurally ignored
    const mergeA = new RecordingMergeAdapter(ACCEPTED);
    const readA = new ScriptedReadAdapter([
      evidence({ headSha: SHA_A }), // bind
      evidence({ headSha: SHA_A }), // fresh revalidation
      evidence({ state: "MERGED", headSha: SHA_B }), // independent post-validation
    ]);
    const hostile = intent() as GithubIntent & Record<string, unknown>;
    hostile.expectedHeadSha = SHA_B;
    hostile.authorization = "Bearer stolen-token";
    hostile.apiUrl = "https://evil.example";
    const resultA = await executeGuardianIntent(
      hostile,
      createGithubAdapter({ adapter: readA, mergeAdapter: mergeA }),
    );
    expect(resultA).toMatchObject({ outcome: "SUCCESS_PROVEN" });
    expect(mergeA.calls.length).toBe(1);
    expect(mergeA.calls[0]?.expectedHeadSha).toBe(SHA_A); // only fresh domain-owned evidence
    const serialized = JSON.stringify(resultA);
    expect(serialized).not.toContain("stolen-token");
    expect(serialized).not.toContain("evil.example");

    // (b) 409 native SHA-precondition refusal → NOT_EXECUTED/COMPATIBILITY, zero mutation
    const mergeB = new RecordingMergeAdapter(SHA_MISMATCH_409);
    const readB = new ScriptedReadAdapter([
      evidence({ headSha: SHA_A }), // bind
      evidence({ headSha: SHA_A }), // fresh revalidation still A; backend refuses on 409
    ]);
    const resultB = await executeGuardianIntent(
      intent(),
      createGithubAdapter({ adapter: readB, mergeAdapter: mergeB }),
    );
    expect(resultB).toMatchObject({
      outcome: "NOT_EXECUTED",
      stage: "COMPATIBILITY",
      refusal: "BLOCKED",
      effect: { dispatched: true, state: "NONE_PROVEN" },
    });
    expect(mergeB.calls.length).toBe(1); // exactly one attempt, no retry
  });

  it("TEST 5 — SUCCESS VERIFIED: aceito + post-validation prova MERGED → SUCCESS_PROVEN com evidência preservada", async () => {
    const merge = new RecordingMergeAdapter(ACCEPTED);
    const read = new ScriptedReadAdapter([
      evidence(), // bind
      evidence(), // fresh revalidation
      evidence({ state: "MERGED", headSha: SHA_B }), // independent proof
    ]);
    const result = await executeGuardianIntent(
      intent(),
      createGithubAdapter({ adapter: read, mergeAdapter: merge }),
    );
    expect(result).toMatchObject({ outcome: "SUCCESS_PROVEN", effect: { dispatched: true, state: "OCCURRED" } });
    if (result.outcome === "SUCCESS_PROVEN") {
      expect((result.evidence as { postValidation?: { state?: string } }).postValidation?.state).toBe("MERGED");
      expect(merge.calls[0]?.expectedHeadSha).toBe(SHA_A);
    }
  });

  it("TEST 6 — BACKEND ACCEPTED ≠ SUCCESS: aceito sem postcondition provada → nunca SUCCESS_PROVEN", async () => {
    const merge = new RecordingMergeAdapter(ACCEPTED);
    const read = new ScriptedReadAdapter([
      evidence(), // bind
      evidence(), // fresh revalidation
      evidence({ state: "OPEN" }), // independent read: still OPEN → not proven
    ]);
    const result = await executeGuardianIntent(
      intent(),
      createGithubAdapter({ adapter: read, mergeAdapter: merge }),
    );
    expect(result).toMatchObject({ outcome: "INDETERMINATE", effect: { dispatched: true, state: "UNDETERMINED" } });
    expect(result.outcome).not.toBe("SUCCESS_PROVEN");
    if (result.outcome === "INDETERMINATE") {
      expect(result.reasons).toContain("POST_VALIDATION_NOT_PROVEN");
    }
    expect(merge.calls.length).toBe(1);
  });

  it("TEST 7 — AMBIGUOUS: ambiguidade após possível mutation → INDETERMINATE, occurrence UNDETERMINED, sem retry", async () => {
    const merge = new RecordingMergeAdapter(NETWORK_AMBIGUOUS);
    const read = new ScriptedReadAdapter([
      evidence(), // bind
      evidence(), // post-validation read: inconclusive/OPEN → not proven
    ]);
    const result = await executeGuardianIntent(
      intent(),
      createGithubAdapter({ adapter: read, mergeAdapter: merge }),
    );
    expect(result).toMatchObject({ outcome: "INDETERMINATE", effect: { dispatched: true, state: "UNDETERMINED" } });
    expect(merge.calls.length).toBe(1); // exactly one attempt — never retried
    if (result.outcome === "INDETERMINATE") {
      expect(result.reasons).toContain("MERGE_BACKEND_AMBIGUOUS_NETWORK");
    }
  });

  it("TEST 8 — MERGEABILITY UNKNOWN: não inventa elegibilidade nem sucesso (bind e apply)", async () => {
    // bind phase: mergeability transitória → observação inconclusiva
    const mergeBind = new RecordingMergeAdapter(ACCEPTED);
    const readBind = new ScriptedReadAdapter([evidence({ mergeableState: "UNKNOWN" })]);
    const bindResult = await executeGuardianIntent(
      intent(),
      createGithubAdapter({ adapter: readBind, mergeAdapter: mergeBind }),
    );
    expect(bindResult).toMatchObject({
      outcome: "NOT_EXECUTED",
      stage: "OBSERVATION",
      refusal: "UNDETERMINED",
      effect: { dispatched: false, state: "NONE_PROVEN" },
    });
    expect(mergeBind.calls.length).toBe(0);

    // apply phase: frescor perdido na revalidação → compatibilidade inconclusiva
    const mergeApply = new RecordingMergeAdapter(ACCEPTED);
    const readApply = new ScriptedReadAdapter([
      evidence(), // bind OK
      evidence({ mergeableState: "UNKNOWN" }), // revalidation inconclusive
    ]);
    const applyResult = await executeGuardianIntent(
      intent(),
      createGithubAdapter({ adapter: readApply, mergeAdapter: mergeApply }),
    );
    expect(applyResult).toMatchObject({
      outcome: "NOT_EXECUTED",
      stage: "COMPATIBILITY",
      refusal: "UNDETERMINED",
      effect: { dispatched: true, state: "NONE_PROVEN" },
    });
    expect(mergeApply.calls.length).toBe(0); // zero mutation
  });

  it("TEST 9 — AUTHORITY STRUCTURAL: API pública não aceita token/URL/method/SHA/payload/credencial", () => {
    // Data-only intent: exactly the two logical fields.
    const intentKeys: Record<keyof GithubIntent, true> = { repository: true, pullNumber: true };
    expect(Object.keys(intentKeys).sort()).toEqual(["pullNumber", "repository"]);
    // Adapter deps are operator-owned behavior channels only — no token/URL/method/SHA.
    const depKeys: Record<keyof GithubAdapterDeps, true> = { adapter: true, config: true, mergeAdapter: true };
    expect(Object.keys(depKeys).sort()).toEqual(["adapter", "config", "mergeAdapter"]);
    // Adapter surface is exactly bind+apply; Core surface is exactly (intent, adapter).
    const adapter = createGithubAdapter({ adapter: new ScriptedReadAdapter([]), mergeAdapter: new RecordingMergeAdapter(ACCEPTED) });
    expect(Object.keys(adapter).sort()).toEqual(["apply", "bind"]);
    expect(executeGuardianIntent.length).toBe(2);
  });

  it("TEST 10 — NO GENERIC RETRY: indeterminado → Core nunca chama apply novamente; merge único", async () => {
    const merge = new RecordingMergeAdapter(NETWORK_AMBIGUOUS);
    const read = new ScriptedReadAdapter([evidence(), evidence()]);
    const base = createGithubAdapter({ adapter: read, mergeAdapter: merge });
    let applyInvocations = 0;
    const counting: DomainAdapter<GithubIntent, GithubProposal> = {
      bind: (i) => base.bind(i),
      apply: (p) => {
        applyInvocations += 1;
        return base.apply(p);
      },
    };
    const result = await executeGuardianIntent(intent(), counting);
    expect(result).toMatchObject({ outcome: "INDETERMINATE", effect: { dispatched: true, state: "UNDETERMINED" } });
    expect(applyInvocations).toBe(1); // Core never re-calls apply
    expect(merge.calls.length).toBe(1); // and the domain never re-attempted the merge
  });
});
