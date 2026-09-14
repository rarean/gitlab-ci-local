import assert, {AssertionError} from "node:assert";
import chalk from "chalk-template";
import {Parser} from "./parser.js";
import {Utils} from "./utils.js";
import {WriteStreams} from "./write-streams.js";

export type DeterministicMode = "warn" | "strict";

// A digest is 64 hex chars for sha256, 128 for sha512 — no other algorithms
// are in use by container registries today.
const DIGEST_SHA256 = /@sha256:[0-9a-f]{64}$/i;
const DIGEST_SHA512 = /@sha512:[0-9a-f]{128}$/i;

/**
 * A reference is pinned iff it carries an immutable digest (`image@sha256:...`).
 * Everything else floats: a plain tag (`alpine:3.20`) can be re-pushed, and no
 * tag at all (or the literal `latest`) is floating by definition.
 */
export function isPinnedImageReference (ref: string): boolean {
    if (DIGEST_SHA256.test(ref)) return true;
    if (DIGEST_SHA512.test(ref)) return true;
    return false;
}

/**
 * Collects every unpinned image/service reference the invocation would use,
 * deduplicated. Job images are validated in their *expanded* form, so a
 * variable that resolves to a digest pins the reference. Imageless jobs
 * (shell executor) contribute nothing — the check is vacuously satisfied.
 */
export function collectUnpinnedReferences (parser: Parser): string[] {
    const refs = new Set<string>();

    let anyContainerJob = false;
    let anyServicesJob = false;
    for (const job of parser.jobs) {
        const expanded = Utils.expandVariables(job.rawVariables);
        const imageName = job.imageName(expanded);
        if (imageName) {
            anyContainerJob = true;
            refs.add(imageName);
        }
        for (const service of job.services) {
            anyServicesJob = true;
            refs.add(Utils.expandText(service.name, expanded));
        }
    }

    // The helper/wait images are only pulled when at least one job actually
    // uses a container or a service — validate the effective values only.
    if (anyContainerJob) refs.add(parser.argv.helperImage);
    if (anyServicesJob) refs.add(parser.argv.waitImage);

    return [...refs].filter((ref) => !isPinnedImageReference(ref)).sort();
}

export function validateDeterminism (parser: Parser, writeStreams: WriteStreams): void {
    const mode = parser.argv.deterministic;
    if (mode == null) return;

    const unpinned = collectUnpinnedReferences(parser);
    if (unpinned.length === 0) return;

    if (mode === "warn") {
        for (const ref of unpinned) {
            writeStreams.stderr(chalk`{black.bgYellowBright  WARN } deterministic: image reference is not digest-pinned ({yellow ${ref}})\n`);
        }
        return;
    }

    assert(mode === "strict");
    throw new AssertionError({
        message: `Deterministic mode (strict) found unpinned image references — pin them with a digest (image@sha256:...):\n${unpinned.map((ref) => `  - ${ref}`).join("\n")}`,
    });
}
