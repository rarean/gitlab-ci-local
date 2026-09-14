import {isPinnedImageReference} from "../src/determinism.js";

test("deterministic-image-check <digest-pinned references>", () => {
    expect(isPinnedImageReference("docker.io/library/alpine@sha256:" + "a".repeat(64))).toBe(true);
    expect(isPinnedImageReference("alpine:3.20@sha256:" + "0".repeat(64))).toBe(true);
    expect(isPinnedImageReference("registry.example.com/group/app@sha256:" + "f".repeat(64))).toBe(true);
    expect(isPinnedImageReference("app@sha512:" + "a".repeat(128))).toBe(true);
});

test("deterministic-image-check <floating references are unpinned>", () => {
    // A plain tag can be re-pushed — only digests are immutable.
    expect(isPinnedImageReference("docker.io/library/alpine:3.20")).toBe(false);
    expect(isPinnedImageReference("alpine")).toBe(false);
    expect(isPinnedImageReference("alpine:latest")).toBe(false);
    expect(isPinnedImageReference("docker.io/sumina46/wait-for-it:latest")).toBe(false);
});

test("deterministic-image-check <malformed digests are unpinned>", () => {
    expect(isPinnedImageReference("alpine@sha256:" + "a".repeat(63))).toBe(false);
    expect(isPinnedImageReference("alpine@sha256:not-hex")).toBe(false);
    expect(isPinnedImageReference("alpine@md5:" + "a".repeat(32))).toBe(false);
});

test("deterministic-image-check <variable expansion decides, and happens before validation>", () => {
    // The classifier runs on the *expanded* reference; these are the forms
    // job.imageName() produces for image: $PINNED and image: $FLOATING.
    const expandedToDigest = "alpine@sha256:" + "b".repeat(64);
    const expandedToLatest = "alpine:latest";
    expect(isPinnedImageReference(expandedToDigest)).toBe(true);
    expect(isPinnedImageReference(expandedToLatest)).toBe(false);
});
