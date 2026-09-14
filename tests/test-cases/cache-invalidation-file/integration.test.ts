import fs from "fs-extra";
import {WriteStreamsMock} from "../../../src/write-streams.js";
import {handler} from "../../../src/handler.js";
import {initSpawnSpy} from "../../mocks/utils.mock.js";
import {WhenStatics} from "../../mocks/when-statics.js";

beforeAll(() => {
    initSpawnSpy(WhenStatics.all);
    fs.rmSync(`${cwd}/${stateDir}`, {recursive: true, force: true});
});

const cwd = "tests/test-cases/cache-invalidation-file";
const stateDir = ".gitlab-ci-local-cache-invalidation-file";
const inputPath = `${cwd}/input.txt`;
const originalInput = fs.readFileSync(inputPath, "utf8");

afterAll(() => {
    // The test edits a tracked file; always restore the original content.
    fs.outputFileSync(inputPath, originalInput);
});

test("cache-invalidation-file <changed tracked file re-runs the job>", async () => {
    const first = new WriteStreamsMock();
    await handler({cwd, stateDir, cache: true, shellIsolation: true}, first);
    expect(first.stdoutLines.join("\n")).toContain("original-input");

    fs.outputFileSync(inputPath, "modified-input\n");

    const second = new WriteStreamsMock();
    await handler({cwd, stateDir, cache: true, shellIsolation: true}, second);

    const secondOut = second.stdoutLines.join("\n");
    expect(secondOut).toContain("modified-input");
    expect(secondOut).not.toContain("original-input");
    expect(secondOut).not.toContain("restored from cache");
});
