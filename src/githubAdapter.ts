/**
 * GC-03 — GitHub conformance adapter.
 *
 * Thin mapping of the frozen GH-00 proof (memoryos-github-guardian-proof)
 * onto Guardian Core v0.1. The certified GH-00 mechanisms are imported
 * read-only from the proof repository; NO security logic is reimplemented:
 *
 *   bind  = GH-00 certified read-only PLAN
 *           (repo allowlist + PR prechecks + deterministic snapshot + fingerprint)
 *   apply = GH-00 certified governed execution
 *           (approval gates -> fresh revalidation -> fingerprint comparison ->
 *            native SHA precondition, ONE merge attempt, no retry ->
 *            independent post-validation adjudication)
 *
 * Authority: the intent is data-only ({repository, pullNumber}). Token, API
 * URL, HTTP method, merge SHA, fingerprint and payload never cross the Core
 * public API — they stay closed inside the operator-owned domain channels.
 * Human approval is external policy, NOT a Core concept: apply consumes only
 * the externally authorized governed operation, bound to the exact observed
 * state through the fingerprint forged by bind (opaque proposal detail).
 *
 * Core knowledge of GitHub/SHA/fingerprint: none. DomainAdapter = bind+apply.
 */

import type { PullRequestAdapter } from "../../memoryos-github-guardian-proof/src/githubAdapter";
import type { PullRequestMergeAdapter } from "../../memoryos-github-guardian-proof/src/githubPullRequestMergeAdapter";
import { executeApprovedPullRequestMerge } from "../../memoryos-github-guardian-proof/src/executeApprovedPullRequestMerge";
import {
  planPullRequestMerge,
  type OperatorConfig,
} from "../../memoryos-github-guardian-proof/src/planPullRequestMerge";
import type { DomainAdapter, GuardianResult } from "./guardianCore";

/** Data-only intent: logical target only. No token, URL, method, SHA or payload. */
export interface GithubIntent {
  readonly repository: string;
  readonly pullNumber: number;
}

/** Opaque BoundProposal. Fingerprint rides inside as a domain representation detail. */
export interface GithubProposal {
  readonly repository: string;
  readonly pullNumber: number;
  /** GH-00 certified PLAN fingerprint of the exact observed state. Core never inspects it. */
  readonly proposalFingerprint: string;
}

/** Operator-owned behavior channels. Credentials live only inside the domain adapters. */
export interface GithubAdapterDeps {
  /** Read channel (fresh evidence, revalidation, post-validation). */
  readonly adapter: PullRequestAdapter;
  /** The single controlled write channel (one attempt, no retry, token/URL closed inside). */
  readonly mergeAdapter: PullRequestMergeAdapter;
  /** Operator authority configuration (allowlists) — never caller-controlled. */
  readonly config?: OperatorConfig;
}

type NotExecuted = Extract<GuardianResult, { outcome: "NOT_EXECUTED" }>;

function notExecuted(
  stage: NotExecuted["stage"],
  refusal: NotExecuted["refusal"],
  dispatched: boolean,
  label: string,
  reasons: readonly string[],
): NotExecuted {
  return {
    outcome: "NOT_EXECUTED",
    stage,
    refusal,
    effect: { dispatched, state: "NONE_PROVEN" },
    reasons: [label, ...reasons],
  };
}

export function createGithubAdapter(
  deps: GithubAdapterDeps,
): DomainAdapter<GithubIntent, GithubProposal> {
  return {
    async bind(intent) {
      // Certified read-only PLAN: eligibility + observation, zero mutation.
      const plan = await planPullRequestMerge(
        { repository: intent.repository, pullRequestNumber: intent.pullNumber },
        { adapter: deps.adapter, config: deps.config },
      );
      if (plan.status === "PLAN_READY") {
        if (typeof plan.proposalFingerprint !== "string") {
          return notExecuted(
            "OBSERVATION",
            "UNDETERMINED",
            false,
            "GH00_SNAPSHOT_FINGERPRINT_UNAVAILABLE",
            plan.reasons,
          );
        }
        return {
          status: "BOUND",
          proposal: {
            repository: intent.repository,
            pullNumber: intent.pullNumber,
            proposalFingerprint: plan.proposalFingerprint,
          },
        };
      }
      if (plan.status === "UNKNOWN") {
        // Inconclusive observation (mergeability/checks/state indeterminate):
        // never invented eligibility, never a decision.
        return notExecuted("OBSERVATION", "UNDETERMINED", false, "GH00_UNKNOWN", plan.reasons);
      }
      return notExecuted("ELIGIBILITY", "BLOCKED", false, "GH00_BLOCKED", plan.reasons);
    },

    async apply(proposal) {
      // Certified governed execution: approval gates -> fresh revalidation ->
      // fingerprint comparison -> native SHA precondition merge (SHA derived
      // ONLY from fresh validated evidence inside GH-00; the caller can never
      // choose it) -> ONE merge attempt, no retry -> independent post-validation.
      const exec = await executeApprovedPullRequestMerge(
        {
          repository: proposal.repository,
          pullRequestNumber: proposal.pullNumber,
          execute: true,
          approval: { approved: true, proposalFingerprint: proposal.proposalFingerprint },
        },
        { adapter: deps.adapter, mergeAdapter: deps.mergeAdapter, config: deps.config },
      );

      switch (exec.status) {
        case "VERIFIED":
          // Independent post-validation PROVED the merge.
          return {
            outcome: "SUCCESS_PROVEN",
            effect: { dispatched: true, state: "OCCURRED" },
            evidence: { domainStatus: "VERIFIED", postValidation: exec.evidence, reasons: exec.reasons },
          };
        case "SNAPSHOT_CHANGED":
          // State moved between bind and apply: stale decision refused, zero mutation.
          return notExecuted("COMPATIBILITY", "BLOCKED", true, "GH00_SNAPSHOT_CHANGED", exec.reasons);
        case "FAILED":
          if (exec.reasons.includes("MERGE_REJECTED_PRECONDITION_SHA_OR_STATE")) {
            // Native SHA precondition refusal: certified zero-mutation outcome.
            return notExecuted("COMPATIBILITY", "BLOCKED", true, "GH00_SHA_PRECONDITION_REFUSED", exec.reasons);
          }
          // Definitive backend refusal: proved-not-merged with sufficient evidence.
          return {
            outcome: "FAILURE_PROVEN",
            effect: { dispatched: true, state: "NONE_PROVEN" },
            evidence: { domainStatus: "FAILED", reasons: exec.reasons },
            reasons: [...exec.reasons],
          };
        case "BLOCKED":
          // Fresh revalidation refused (eligibility lost since bind): zero mutation.
          return notExecuted("COMPATIBILITY", "BLOCKED", true, "GH00_BLOCKED", exec.reasons);
        case "UNKNOWN":
          // Fresh revalidation inconclusive before any mutation: zero mutation.
          return notExecuted("COMPATIBILITY", "UNDETERMINED", true, "GH00_UNKNOWN", exec.reasons);
        case "APPROVAL_REQUIRED":
          // Structurally unreachable (execute/approval are adapter-fixed); zero-mutation fallback.
          return notExecuted("COMPATIBILITY", "UNDETERMINED", true, "GH00_APPROVAL_REQUIRED", exec.reasons);
        case "UNKNOWN_REQUIRES_HUMAN_REVIEW":
          // Possible mutation with unprovable outcome: never success, never retried.
          return {
            outcome: "INDETERMINATE",
            effect: { dispatched: true, state: "UNDETERMINED" },
            reasons: ["GH00_UNKNOWN_REQUIRES_HUMAN_REVIEW", ...exec.reasons],
          };
        default:
          return {
            outcome: "INDETERMINATE",
            effect: { dispatched: true, state: "UNDETERMINED" },
            reasons: ["GH00_UNEXPECTED_DOMAIN_RESULT", ...exec.reasons],
          };
      }
    },
  };
}
