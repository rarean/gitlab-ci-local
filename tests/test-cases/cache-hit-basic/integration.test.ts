import fs from "fs-extra";
import {WriteStreamsMock} from "../../../src/write-streams.js";
import {handler} from "../../../src/handler.js";
import {initSpawnSpy} from "../../mocks/utils.mock.js";
import {WhenStatics} from "../../mocks/when-statics.js";

beforeAll(() => {
    initSpawnSpy(WhenStatics.all);
});

const cwd = "tests/test-cases/cache-hit-basic";
const stateDir = ".gitlab-ci-local-cache-hit-basic";

function readReport (stateDirName: string) {
    return JSON.parse(fs.readFileSync(`${cwd}/${stateDirName}/report.json`, "utf8"));
}

test("cache-hit-basic <first run executes, second run restores>", async () => {
    fs.rmSync(`${cwd}/${stateDir}`, {recursive: true, force: true});
    const first = new WriteStreamsMock();
    await handler({cwd, stateDir, cache: true, shellIsolation: true, reportJson: `${cwd}/${stateDir}/report.json`}, first);

    expect(first.stdoutLines.join("\n")).toContain("build-executed");
    expect(first.stdoutLines.join("\n")).not.toContain("restored from cache");

    const firstReport = readReport(stateDir);
    expect(firstReport.status).toBe("success");
    for (const job of firstReport.jobs) {
        expect(job.cached).toBe(false);
    }

    const second = new WriteStreamsMock();
    await handler({cwd, stateDir, cache: true, shellIsolation: true, reportJson: `${cwd}/${stateDir}/report.json`}, second);

    const secondOut = second.stdoutLines.join("\n");
    expect(secondOut.match(/restored from cache/g)).toHaveLength(2);
    expect(secondOut).not.toContain("build-executed");
    expect(secondOut).not.toContain("copied to docker volumes");

    const secondReport = readReport(stateDir);
    expect(secondReport.status).toBe("success");
    for (const job of secondReport.jobs) {
        expect(job.cached).toBe(true);
        expect(job.status).toBe("success");
        expect(job.started).toBe(true);
        expect(job.prescriptsExitCode).toBe(0);
        expect(fs.existsSync(`${cwd}/${job.logPath}`)).toBe(true);
    }

    // The producer's artifacts are restored where consumers and users expect them
    expect(fs.existsSync(`${cwd}/${stateDir}/artifacts/build/built.txt`)).toBe(true);
});

test("cache-hit-basic <clear-cache removes the cache dir and exits>", async () => {
    fs.rmSync(`${cwd}/${stateDir}-clear`, {recursive: true, force: true});
    const before = new WriteStreamsMock();
    await handler({cwd, stateDir: `${stateDir}-clear`, cache: true, shellIsolation: true}, before);
    expect(fs.pathExistsSync(`${cwd}/${stateDir}-clear/cache`)).toBe(true);

    const writeStreams = new WriteStreamsMock();
    await handler({cwd, stateDir: `${stateDir}-clear`, clearCache: true}, writeStreams);

    expect(fs.pathExistsSync(`${cwd}/${stateDir}-clear/cache`)).toBe(false);
    expect(writeStreams.stdoutLines.join("\n")).toContain("cleared");
});
