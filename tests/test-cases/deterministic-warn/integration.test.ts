import {WriteStreamsMock} from "../../../src/write-streams.js";
import {handler} from "../../../src/handler.js";
import {initSpawnSpy} from "../../mocks/utils.mock.js";
import {WhenStatics} from "../../mocks/when-statics.js";

beforeAll(() => {
    initSpawnSpy(WhenStatics.all);
});

const cwd = "tests/test-cases/deterministic-warn";
const stateDir = ".gitlab-ci-local-deterministic-warn";

test("deterministic-warn <one warning per unique reference, run completes>", async () => {
    const writeStreams = new WriteStreamsMock();
    await handler({cwd, stateDir, deterministic: true}, writeStreams);

    // Four jobs, three unique image refs (alpine:latest is used twice and must
    // only warn once) plus the effective helper and wait images.
    const warnings = writeStreams.stderrLines.filter((line) => line.includes("not digest-pinned"));
    expect(warnings).toHaveLength(5);
    expect(warnings.filter((line) => line.includes("alpine:latest"))).toHaveLength(1);
    expect(warnings.filter((line) => line.includes("alpine:3.20"))).toHaveLength(1);
    expect(warnings.filter((line) => line.includes("gitlab-ci-local-util:latest"))).toHaveLength(1);
    expect(warnings.filter((line) => line.includes("wait-for-it:latest"))).toHaveLength(1);
    expect(warnings.filter((line) => line.includes("postgres:16"))).toHaveLength(1);

    // Manual jobs only — the pipeline must complete without starting anything.
    expect(writeStreams.stdoutLines.join("\n")).not.toContain("starting");
    expect(writeStreams.stderrLines.join("\n")).toContain("pipeline finished");
});
