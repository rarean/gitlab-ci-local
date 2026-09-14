import fs from "fs-extra";
import {WriteStreamsMock} from "../../../src/write-streams.js";
import {handler} from "../../../src/handler.js";
import {initSpawnSpy} from "../../mocks/utils.mock.js";
import {WhenStatics} from "../../mocks/when-statics.js";

beforeAll(() => {
    initSpawnSpy(WhenStatics.all);
});

const cwd = "tests/test-cases/deterministic-strict";
const stateDir = ".gitlab-ci-local-deterministic-strict";
const ymlPath = `${cwd}/.gitlab-ci.yml`;
const originalYml = fs.readFileSync(ymlPath, "utf8");

afterAll(() => {
    // The fixed-digest assertions rewrite the tracked .gitlab-ci.yml.
    fs.outputFileSync(ymlPath, originalYml);
});

test("deterministic-strict <fails before any container starts, listing every reference>", async () => {
    const writeStreams = new WriteStreamsMock();
    await expect(handler({cwd, stateDir, deterministic: "strict"}, writeStreams)).rejects.toThrow(
        /gitlab-ci-local-util:latest.*alpine:3\.20.*alpine:latest.*wait-for-it:latest.*postgres:16/s,
    );
    expect(writeStreams.stdoutLines.length).toBe(0);
});

test("deterministic-strict <digest-pinned pipeline passes>", async () => {
    const pinned = (ref: string) => `${ref}@sha256:${"a".repeat(64)}`;
    fs.outputFileSync(ymlPath, [
        "manual-latest:",
        "  stage: test",
        `  image: ${pinned("docker.io/library/alpine")}`,
        "  when: manual",
        "  script: echo \"never runs\"",
        "",
        "manual-tag:",
        "  stage: test",
        `  image: ${pinned("docker.io/library/alpine")}`,
        "  when: manual",
        "  script: echo \"never runs\"",
        "",
        "manual-service:",
        "  stage: test",
        `  image: ${pinned("docker.io/library/alpine")}`,
        "  services:",
        `    - name: ${pinned("postgres")}`,
        "  when: manual",
        "  script: echo \"never runs\"",
        "",
    ].join("\n"));

    const writeStreams = new WriteStreamsMock();
    await handler({
        cwd,
        stateDir,
        deterministic: "strict",
        helperImage: pinned("docker.io/firecow/gitlab-ci-local-util"),
        waitImage: pinned("docker.io/sumina46/wait-for-it"),
    }, writeStreams);

    expect(writeStreams.stderrLines.join("\n")).toContain("pipeline finished");
    expect(writeStreams.stderrLines.filter((line) => line.includes("not digest-pinned"))).toHaveLength(0);
});
