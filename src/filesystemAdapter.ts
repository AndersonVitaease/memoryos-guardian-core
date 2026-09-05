/**
 * GC-02 — Filesystem conformance adapter (thin mapping, no security logic duplicated).
 * Translates the Guardian Core contract onto the certified FS-00 mechanism:
 * memoryos-filesystem-guardian-proof/src/safeFileChange.ts (read-only import;
 * that repo is frozen evidence and is not modified).
 *
 * Authority stays with the domain: AUTHORIZED_ROOT is the FS-00 module's own internal
 * constant. This adapter accepts no root, fs primitives, callbacks, shell, URLs or
 * credentials — it only forwards a data-only intent and its own opaque proposal.
 * STATE-BOUND EXECUTION is enforced by FS-00 itself: expectedCurrentContent is compared
 * against the real file on the same open descriptor before any write (stale X→Y over Z
 * is refused with zero mutation). No second CAS is implemented here.
 */
import { safeFileChange } from "../../memoryos-filesystem-guardian-proof/src/safeFileChange";
import type { BindOutcome, DomainAdapter, GuardianResult } from "./guardianCore";

/** Data-only intent. No root, no fs primitives, no callbacks, no credentials. */
export interface FilesystemIntent {
  path: string;
  newContent: string;
}

/**
 * Opaque proposal forged by bind: the declared change fused with the observed state
 * (observedContent is the carrier of the FS-00 binding — expectedCurrentContent).
 * The Core never inspects it; only apply consumes it.
 */
export interface FilesystemProposal {
  target: string;
  observedContent: string;
  newContent: string;
}

function notExecuted(
  stage: "ELIGIBILITY" | "OBSERVATION" | "COMPATIBILITY",
  refusal: "BLOCKED" | "UNDETERMINED",
  label: string,
  reasons: readonly string[],
): Extract<GuardianResult, { outcome: "NOT_EXECUTED" }> {
  return {
    outcome: "NOT_EXECUTED",
    stage,
    refusal,
    effect: { dispatched: false, state: "NONE_PROVEN" },
    reasons: [label, ...reasons],
  };
}

/**
 * Operator-built adapter (zero configuration arguments — power is closed inside
 * the FS-00 module). bind = FS-00 plan/observation (read-only); apply = FS-00
 * execute (the only potentially mutating boundary, with real CAS + read-back).
 */
export function createFilesystemAdapter(): DomainAdapter<FilesystemIntent, FilesystemProposal> {
  return {
    bind(intent) {
      const plan = safeFileChange({ path: intent.path, execute: false });
      if (plan.status === "PLAN_READY" && typeof plan.observedContent === "string") {
        return {
          status: "BOUND",
          proposal: {
            target: intent.path,
            observedContent: plan.observedContent,
            newContent: intent.newContent,
          },
        };
      }
      if (plan.status === "UNKNOWN") {
        return notExecuted("OBSERVATION", "UNDETERMINED", "FS00_UNKNOWN", plan.reasons);
      }
      return notExecuted("ELIGIBILITY", "BLOCKED", `FS00_${plan.status}`, plan.reasons);
    },

    apply(proposal) {
      const exec = safeFileChange({
        path: proposal.target,
        expectedCurrentContent: proposal.observedContent,
        newContent: proposal.newContent,
        execute: true,
      });
      switch (exec.status) {
        case "APPLIED":
          return {
            outcome: "SUCCESS_PROVEN",
            effect: { dispatched: true, state: "OCCURRED" },
            evidence: { domainStatus: "APPLIED", reasons: exec.reasons },
          };
        case "STOPPED_CONCURRENT_CHANGE":
        case "BLOCKED":
          return {
            outcome: "NOT_EXECUTED",
            stage: "COMPATIBILITY",
            refusal: "BLOCKED",
            effect: { dispatched: true, state: "NONE_PROVEN" },
            reasons: [`FS00_${exec.status}`, ...exec.reasons],
          };
        case "FAILED":
          return {
            outcome: "FAILURE_PROVEN",
            effect: { dispatched: true, state: "OCCURRED" },
            evidence: { domainStatus: "FAILED", reasons: exec.reasons },
            reasons: exec.reasons,
          };
        case "UNKNOWN":
          if (exec.writeAttempted === true || exec.mutationPerformed === true) {
            return {
              outcome: "INDETERMINATE",
              effect: { dispatched: true, state: "UNDETERMINED" },
              reasons: ["FS00_UNKNOWN", ...exec.reasons],
            };
          }
          return {
            outcome: "NOT_EXECUTED",
            stage: "COMPATIBILITY",
            refusal: "UNDETERMINED",
            effect: { dispatched: true, state: "NONE_PROVEN" },
            reasons: ["FS00_UNKNOWN", ...exec.reasons],
          };
        default:
          return {
            outcome: "INDETERMINATE",
            effect: { dispatched: true, state: "UNDETERMINED" },
            reasons: ["FS00_UNEXPECTED_DOMAIN_RESULT"],
          };
      }
    },
  };
}
