import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AUTHORIZED_ROOT } from "../../memoryos-filesystem-guardian-proof/src/safeFileChange";
import { executeGuardianIntent } from "../src/guardianCore";
import {
  createFilesystemAdapter,
  type FilesystemIntent,
} from "../src/filesystemAdapter";

/**
 * GC-02 conformance tests. Fixtures live ONLY inside the FS-00 mechanism's own
 * confined root (its module constant — the adapter must not offer another root),
 * are created and fully removed by these tests, and no tracked file of the frozen
 * FS-00 proof is touched. The Core repository probe file is created under test/.
 */
const adapter = createFilesystemAdapter();
const created: string[] = [];

function fixture(name: string, content: string): string {
  mkdirSync(AUTHORIZED_ROOT, { recursive: true });
  const p = join(AUTHORIZED_ROOT, name);
  writeFileSync(p, content, "utf8");
  created.push(p);
  return p;
}

function cleanup(): void {
  for (const p of created.splice(0)) {
    try {
      chmodSync(p, 0o666);
    } catch {
      /* already writable or gone */
    }
    rmSync(p, { force: true });
  }
  rmSync(join(AUTHORIZED_ROOT, "dir-target"), { recursive: true, force: true });
  rmSync(join(AUTHORIZED_ROOT, "..", "outside.txt"), { force: true });
  rmSync(join(import.meta.dirname, "gc02-probe.txt"), { force: true });
}

afterEach(cleanup);

describe("GC-02 — filesystem conformance adapter", () => {
  it("TEST 1 — happy path X→Y through the Core: SUCCESS_PROVEN, file becomes Y, effect OCCURRED", async () => {
    fixture("x2y.txt", "X");
    const result = await executeGuardianIntent(
      { path: "x2y.txt", newContent: "Y" } satisfies FilesystemIntent,
      adapter,
    );
    expect(result).toEqual({
      outcome: "SUCCESS_PROVEN",
      effect: { dispatched: true, state: "OCCURRED" },
      evidence: { domainStatus: "APPLIED", reasons: expect.anything() },
    });
    expect(readFileSync(join(AUTHORIZED_ROOT, "x2y.txt"), "utf8")).toBe("Y");
  });

  it("TEST 2 — stale state: external X→Z between bind and apply is NEVER overwritten by Y", async () => {
    const target = fixture("stale.txt", "X");
    // Full Core loop, with an external actor mutating between bind and apply.
    const racingAdapter = {
      bind(intent: FilesystemIntent) {
        const bound = adapter.bind(intent);
        if ("status" in bound) writeFileSync(target, "Z", "utf8"); // actor writes Z
        return bound;
      },
      apply: (proposal: Parameters<typeof adapter.apply>[0]) => adapter.apply(proposal),
    };
    const result = await executeGuardianIntent(
      { path: "stale.txt", newContent: "Y" },
      racingAdapter,
    );
    expect(result).toMatchObject({
      outcome: "NOT_EXECUTED",
      stage: "COMPATIBILITY",
      refusal: "BLOCKED",
      effect: { dispatched: true, state: "NONE_PROVEN" },
    });
    expect(result.outcome).not.toBe("SUCCESS_PROVEN");
    expect(readFileSync(target, "utf8")).toBe("Z"); // Z survives byte-identical
  });

  it("TEST 3 — path traversal blocked before any effect; no external file created", async () => {
    const result = await executeGuardianIntent(
      { path: "../outside.txt", newContent: "Y" },
      adapter,
    );
    expect(result).toMatchObject({
      outcome: "NOT_EXECUTED",
      stage: "ELIGIBILITY",
      refusal: "BLOCKED",
      effect: { dispatched: false, state: "NONE_PROVEN" },
    });
    expect(existsSync(join(AUTHORIZED_ROOT, "..", "outside.txt"))).toBe(false);
  });

  it("TEST 4 — absolute path blocked; target file byte-identical afterwards", async () => {
    const probe = join(import.meta.dirname, "gc02-probe.txt");
    writeFileSync(probe, "SAFE", "utf8");
    const result = await executeGuardianIntent({ path: probe, newContent: "EVIL" }, adapter);
    expect(result).toMatchObject({
      outcome: "NOT_EXECUTED",
      stage: "ELIGIBILITY",
      refusal: "BLOCKED",
      effect: { dispatched: false, state: "NONE_PROVEN" },
    });
    expect(readFileSync(probe, "utf8")).toBe("SAFE");
  });

  it("TEST 5 — nonexistent target blocked with zero mutation", async () => {
    const result = await executeGuardianIntent(
      { path: "missing.txt", newContent: "Y" },
      adapter,
    );
    expect(result).toMatchObject({
      outcome: "NOT_EXECUTED",
      stage: "ELIGIBILITY",
      refusal: "BLOCKED",
      effect: { dispatched: false, state: "NONE_PROVEN" },
    });
    expect(existsSync(join(AUTHORIZED_ROOT, "missing.txt"))).toBe(false);
  });

  it("TEST 6 — directory target blocked with zero mutation", async () => {
    mkdirSync(join(AUTHORIZED_ROOT, "dir-target"), { recursive: true });
    const result = await executeGuardianIntent(
      { path: "dir-target", newContent: "Y" },
      adapter,
    );
    expect(result).toMatchObject({
      outcome: "NOT_EXECUTED",
      stage: "ELIGIBILITY",
      refusal: "BLOCKED",
      effect: { dispatched: false, state: "NONE_PROVEN" },
    });
  });

  it("TEST 7 — observation/execute unreadable: honest NOT_EXECUTED, zero mutation, never SUCCESS", async () => {
    // NOTE: on this platform (Windows) chmod 0o444 does NOT block the read phase,
    // so a pure observation-phase UNKNOWN is not cleanly simulable without fs
    // injection (TEST_NOT_APPLICABLE for stage=OBSERVATION/UNDETERMINED; that
    // mapping exists in bind). What IS exercised honestly: the domain becomes
    // unreadable/unwritable before execute -> UNKNOWN with no write attempt ->
    // NOT_EXECUTED/COMPATIBILITY/UNDETERMINED, zero mutation, never SUCCESS.
    const target = fixture("locked-obs.txt", "X");
    chmodSync(target, 0o444);
    const result = await executeGuardianIntent(
      { path: "locked-obs.txt", newContent: "Y" },
      adapter,
    );
    expect(result).toMatchObject({
      outcome: "NOT_EXECUTED",
      stage: "COMPATIBILITY",
      refusal: "UNDETERMINED",
      effect: { dispatched: true, state: "NONE_PROVEN" },
    });
    expect(result.outcome).not.toBe("SUCCESS_PROVEN");
    expect(readFileSync(target, "utf8")).toBe("X");
  });

  it("TEST 8 — domain UNKNOWN after bind never becomes SUCCESS; file unchanged, zero mutation", async () => {
    const target = fixture("locked-exec.txt", "X");
    const bound = adapter.bind({ path: "locked-exec.txt", newContent: "Y" });
    if (!("status" in bound)) throw new Error("expected BOUND");
    chmodSync(target, 0o444); // execute can no longer open the file for writing
    const result = await adapter.apply(bound.proposal);
    expect(["NOT_EXECUTED", "INDETERMINATE"]).toContain(result.outcome);
    expect(result.outcome).not.toBe("SUCCESS_PROVEN");
    expect(readFileSync(target, "utf8")).toBe("X"); // zero mutation
  });
});
