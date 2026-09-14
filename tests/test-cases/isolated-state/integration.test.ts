import fs from "fs-extra";
import * as os from "node:os";
import {WriteStreamsMock} from "../../../src/write-streams.js";
import {handler} from "../../../src/handler.js";
import {initSpawnSpy} from "../../mocks/utils.mock.js";
import {WhenStatics} from "../../mocks/when-statics.js";

beforeAll(() => {
    initSpawnSpy(WhenStatics.all);
});

const cwd = "tests/test-cases/isolated-state";

// Isolated temp dirs matching this prefix under the OS temp dir must not
// survive a handler call.
const tmpPrefix = "gitlab-ci-local-";

function listIsolatedTempDirs (): string[] {
    return fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith(tmpPrefix)).sort();
}

function listIsolatedSiblings (): string[] {
    return fs.readdirSync(cwd).filter((name) => name.startsWith(".gitlab-ci-local-isolated-state-isolated-")).sort();
}

test("isolated-state <fresh state per invocation, no residue>", async () => {
    const tmpBefore = listIsolatedTempDirs();
    const siblingsBefore = listIsolatedSiblings();
    // Report paths live under a gitignored name so test reruns never dirty
    // the tree (tests/test-cases/.gitignore covers .gitlab-ci-local*).
    const reportPath = `${cwd}/.gitlab-ci-local-isolated-reports/report.json`;
    fs.rmSync(reportPath, {force: true});

    const first = new WriteStreamsMock();
    await handler({cwd, isolated: true, reportJson: reportPath}, first);
    expect(first.stdoutLines.join("\n")).toContain("isolated build ran");
    const firstReport = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    expect(firstReport.status).toBe("success");

    // A fresh temp state dir means the pipelineIid starts from scratch on
    // every isolated invocation (a normal state dir would now report 1).
    expect(firstReport.pipelineIid).toBe(0);

    const second = new WriteStreamsMock();
    await handler({cwd, isolated: true, reportJson: reportPath}, second);
    expect(second.stdoutLines.join("\n")).toContain("isolated build ran");
    const secondReport = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    expect(secondReport.pipelineIid).toBe(0);

    expect(listIsolatedTempDirs()).toEqual(tmpBefore);
    expect(listIsolatedSiblings()).toEqual(siblingsBefore);
});

test("isolated-state <user --state-dir becomes the temp dir prefix>", async () => {
    const before = listIsolatedSiblings();
    const writeStreams = new WriteStreamsMock();
    await handler({cwd, stateDir: ".gitlab-ci-local-isolated-state", isolated: true}, writeStreams);
    expect(writeStreams.stdoutLines.join("\n")).toContain("isolated build ran");
    expect(listIsolatedSiblings()).toEqual(before);
    // The user's state dir itself is never touched by an isolated run.
    expect(fs.existsSync(`${cwd}/.gitlab-ci-local-isolated-state/state.yml`)).toBe(false);
});

test("isolated-state <failing run leaves no temp dir behind>", async () => {
    const tmpBefore = listIsolatedTempDirs();
    const reportPath = `${cwd}/.gitlab-ci-local-isolated-reports/failing-report.json`;
    fs.rmSync(reportPath, {force: true});

    const writeStreams = new WriteStreamsMock();
    await handler({cwd, file: "failing.gitlab-ci.yml", isolated: true, reportJson: reportPath}, writeStreams);

    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    expect(report.status).toBe("failed");
    expect(listIsolatedTempDirs()).toEqual(tmpBefore);
});
