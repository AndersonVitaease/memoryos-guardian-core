/**
 * GC-04 — VPS conformance adapter.
 *
 * Thin mapping of ONE certified operation of the frozen VPS Guardian Pro
 * (memoryos-vps-guardian-pro) onto Guardian Core v0.1:
 *
 *   engineering.vps.change.safe  (single action: application.redeploy)
 *
 * The certified VPS mechanisms are imported read-only from the frozen repo;
 * NO security logic is reimplemented and no second reconcile/fingerprint/
 * allowlist exists:
 *
 *   bind  = certified read-only PLAN (planVpsChangeSafe): operator allowlist
 *           resolution + fresh evidence prechecks + deterministic fingerprint.
 *   apply = certified governed EXECUTE (runVpsChangeSafe with execute:true):
 *           approval gate -> FRESH re-assessment (TOCTOU) with the SAME
 *           checks + fingerprint comparison (SNAPSHOT_CHANGED = zero
 *           mutation) -> exactly ONE mutation attempt through the
 *           operator-configured SafeChangeAdapter (single capability
 *           application-redeploy; no retry) -> mandatory post-validation
 *           adjudicated by the domain (VERIFIED | FAILED | PENDING |
 *           UNKNOWN_REQUIRES_HUMAN_REVIEW).
 *
 * The VPS domain has NO native CAS (unlike the GitHub SHA precondition); its
 * certified compensation — fresh reconcile + state comparison + controlled
 * mutation + post-validation — is reused verbatim. Nothing artificial is
 * added and the Core never learns this difference.
 *
 * Authority: the intent is data-only ({target, action:"redeploy"}). The
 * logical target resolves ONLY against the operator-configured allowlist
 * inside the frozen domain; credentials, Dokploy endpoint, server identity,
 * shell, tool name, retry policy and raw payloads never cross the Core
 * public API. Human approval is external policy, NOT a Core concept: apply
 * consumes only the externally authorized governed operation, bound to the
 * exact observed state through the fingerprint forged by bind (opaque
 * proposal detail). The Core knows no VPS/Dokploy, no fingerprint, no CAS.
 */

import {
  CHANGE_SAFE_ACTION,
  planVpsChangeSafe,
  runVpsChangeSafe,
} from "../../memoryos-vps-guardian-pro/src/change/changeSafe";
import type { ProContext } from "../../memoryos-vps-guardian-pro/src/proContext";
import type { DomainAdapter, GuardianResult } from "./guardianCore";

/** Data-only intent: logical target key + the single permitted action. */
export interface VpsIntent {
  readonly target: string;
  readonly action: "redeploy";
}

/** Opaque BoundProposal. The fingerprint rides inside as a domain representation detail. */
export interface VpsProposal {
  readonly target: string;
  /** Certified PLAN fingerprint of the exact observed state. Core never inspects it. */
  readonly proposalFingerprint: string;
}

/** Operator-owned composition context (allowlist, evidence adapters, mutation capability). */
export interface VpsAdapterDeps {
  readonly ctx: ProContext;
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

function indeterminate(reasons: readonly string[]): GuardianResult {
  return {
    outcome: "INDETERMINATE",
    effect: { dispatched: true, state: "UNDETERMINED" },
    reasons: [...reasons],
  };
}

/** Machine-readable precheck labels (check names only, never long summaries). */
function precheckLabels(
  plan: { readonly prechecks: ReadonlyArray<{ readonly check: string; readonly status: string }> },
  statuses: readonly string[],
): string[] {
  return plan.prechecks.filter((check) => statuses.includes(check.status)).map((check) => check.check);
}

export function createVpsAdapter(deps: VpsAdapterDeps): DomainAdapter<VpsIntent, VpsProposal> {
  return {
    bind(intent) {
      // Fail-closed action gate: only the single certified action is expressible.
      if (intent.action !== "redeploy") {
        return notExecuted("ELIGIBILITY", "BLOCKED", false, "VPS04_ACTION_NOT_PERMITTED", []);
      }
      // Certified read-only PLAN: eligibility + observation, zero mutation.
      const plan = planVpsChangeSafe(
        { action: CHANGE_SAFE_ACTION, target: intent.target },
        deps.ctx,
      );
      if (plan.status === "PLAN_READY") {
        if (typeof plan.proposalFingerprint !== "string") {
          return notExecuted("OBSERVATION", "UNDETERMINED", false, "VPS04_FINGERPRINT_UNAVAILABLE", []);
        }
        return {
          status: "BOUND",
          proposal: { target: intent.target, proposalFingerprint: plan.proposalFingerprint },
        };
      }
      if (plan.status === "UNKNOWN") {
        // Required operational state not establishable: never invented eligibility.
        return notExecuted(
          "OBSERVATION",
          "UNDETERMINED",
          false,
          "VPS04_UNKNOWN",
          precheckLabels(plan, ["UNKNOWN"]),
        );
      }
      return notExecuted("ELIGIBILITY", "BLOCKED", false, "VPS04_BLOCKED", precheckLabels(plan, ["BLOCK"]));
    },

    async apply(proposal) {
      // Certified governed execution: approval gate (adapter-fixed, external
      // policy) -> fresh re-assessment + fingerprint comparison (drift/stale
      // refusal, zero mutation) -> ONE application-redeploy attempt (no
      // retry) -> independent post-validation adjudication.
      const exec = await runVpsChangeSafe(
        {
          action: CHANGE_SAFE_ACTION,
          target: proposal.target,
          execute: true,
          approval: { approved: true, proposalFingerprint: proposal.proposalFingerprint },
        },
        deps.ctx,
      );
      if (!("executed" in exec)) {
        return indeterminate(["VPS04_UNEXPECTED_PLAN_RESULT"]);
      }

      switch (exec.status) {
        case "VERIFIED":
          // Fresh evidence PROVED a new deployment completed successfully.
          return {
            outcome: "SUCCESS_PROVEN",
            effect: { dispatched: true, state: "OCCURRED" },
            evidence: {
              domainStatus: "VERIFIED",
              postValidation: exec.postValidation,
              mutation: { occurred: exec.mutation?.occurred ?? null, ref: exec.mutation?.ref ?? null },
              reason: exec.reason,
            },
          };
        case "FAILED":
          if (exec.mutation?.occurred === true) {
            // Post-validation PROVED the postcondition was not reached.
            return {
              outcome: "FAILURE_PROVEN",
              effect: { dispatched: true, state: "OCCURRED" },
              evidence: { domainStatus: "FAILED", postValidation: exec.postValidation },
              reasons: [exec.reason ?? "VPS04_POST_VALIDATION_FAILED"],
            };
          }
          // Mutation occurrence unproven: never a claimed failure.
          return indeterminate(["VPS04_UNPROVEN_MUTATION_OUTCOME", exec.reason ?? ""]);
        case "SNAPSHOT_CHANGED":
          // State moved between bind and apply: stale decision refused, zero mutation.
          return notExecuted("COMPATIBILITY", "BLOCKED", true, "VPS04_SNAPSHOT_CHANGED", [exec.reason ?? ""]);
        case "BLOCKED":
          // Fresh prechecks blocked after bind (drift in gating state): zero mutation.
          return notExecuted("COMPATIBILITY", "BLOCKED", true, "VPS04_BLOCKED", [exec.reason ?? ""]);
        case "UNKNOWN":
          // Required evidence unestablishable before any mutation: zero mutation.
          return notExecuted("COMPATIBILITY", "UNDETERMINED", true, "VPS04_UNKNOWN", [exec.reason ?? ""]);
        case "APPROVAL_REQUIRED":
          // Structurally unreachable (execute/approval are adapter-fixed); zero-mutation fallback.
          return notExecuted("COMPATIBILITY", "UNDETERMINED", true, "VPS04_APPROVAL_REQUIRED", [exec.reason ?? ""]);
        case "MUTATION_UPSTREAM_ERROR":
          // Attempt happened, completion unconfirmed (possible transport ambiguity): never success, never zero-mutation, never retried.
          return indeterminate(["VPS04_MUTATION_UPSTREAM_ERROR", exec.reason ?? ""]);
        case "PENDING":
          // Accepted and still in flight: outcome not yet provable, never success.
          return indeterminate(["VPS04_PENDING", exec.reason ?? ""]);
        case "UNKNOWN_REQUIRES_HUMAN_REVIEW":
          // Post-mutation outcome unprovable: never success, never retried.
          return indeterminate(["VPS04_UNKNOWN_REQUIRES_HUMAN_REVIEW", exec.reason ?? ""]);
        default:
          return indeterminate(["VPS04_UNEXPECTED_DOMAIN_RESULT"]);
      }
    },
  };
}
