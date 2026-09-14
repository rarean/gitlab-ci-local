import fs from "fs-extra";
import {WriteStreamsMock} from "../../../src/write-streams.js";
import {handler} from "../../../src/handler.js";
import {initSpawnSpy} from "../../mocks/utils.mock.js";
import {WhenStatics} from "../../mocks/when-statics.js";

beforeAll(() => {
    initSpawnSpy(WhenStatics.all);
    fs.rmSync(`${cwd}/${stateDir}`, {recursive: true, force: true});
});

const cwd = "tests/test-cases/cache-invalidation-script";
const stateDir = ".gitlab-ci-local-cache-invalidation-script";
const ymlPath = `${cwd}/.gitlab-ci.yml`;
const originalYml = fs.readFileSync(ymlPath, "utf8");

afterAll(() => {
    // The test rewrites the tracked .gitlab-ci.yml; always restore the original.
    fs.outputFileSync(ymlPath, originalYml);
});

test("cache-invalidation-script <changed script line re-runs the job>", async () => {
    const first = new WriteStreamsMock();
    await handler({cwd, stateDir, cache: true, shellIsolation: true}, first);
    expect(first.stdoutLines.join("\n")).toContain("script-v1");

    fs.outputFileSync(ymlPath, "build:\n  stage: test\n  script:\n    - echo \"script-v2\"\n");

    const second = new WriteStreamsMock();
    await handler({cwd, stateDir, cache: true, shellIsolation: true}, second);

    const secondOut = second.stdoutLines.join("\n");
    expect(secondOut).toContain("script-v2");
    expect(secondOut).not.toContain("script-v1");
    expect(secondOut).not.toContain("restored from cache");
});
