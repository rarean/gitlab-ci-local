import fs from "fs-extra";
import {WriteStreamsMock} from "../../../src/write-streams.js";
import {handler} from "../../../src/handler.js";
import {initSpawnSpy} from "../../mocks/utils.mock.js";
import {WhenStatics} from "../../mocks/when-statics.js";

beforeAll(() => {
    initSpawnSpy(WhenStatics.all);
    fs.rmSync(`${cwd}/${stateDir}`, {recursive: true, force: true});
});

const cwd = "tests/test-cases/cache-no-cache-flag";
const stateDir = ".gitlab-ci-local-cache-no-cache-flag";

function entryStats () {
    const jobsDir = `${cwd}/${stateDir}/cache/jobs`;
    if (!fs.pathExistsSync(jobsDir)) return {count: 0, mtimeMs: null as number | null};
    const entries = fs.readdirSync(jobsDir).flatMap((job) => fs.readdirSync(`${jobsDir}/${job}`)).filter((f) => f.endsWith(".json"));
    if (entries.length === 0) return {count: 0, mtimeMs: null as number | null};
    const entryPath = `${jobsDir}/${fs.readdirSync(jobsDir)[0]}/${entries[0]}`;
    return {count: entries.length, mtimeMs: fs.statSync(entryPath).mtimeMs};
}

test("cache-no-cache-flag <no reads and no writes>", async () => {
    const first = new WriteStreamsMock();
    await handler({cwd, stateDir, cache: true, shellIsolation: true}, first);
    expect(first.stdoutLines.join("\n")).toContain("no-cache-executed");
    expect(entryStats().count).toBe(1);

    // Run again without --cache: the existing entry is neither used nor rewritten
    const before = entryStats();
    const second = new WriteStreamsMock();
    await handler({cwd, stateDir, shellIsolation: true}, second);

    const secondOut = second.stdoutLines.join("\n");
    expect(secondOut).toContain("no-cache-executed");
    expect(secondOut).not.toContain("restored from cache");
    expect(entryStats().count).toBe(before.count);
    expect(entryStats().mtimeMs).toBe(before.mtimeMs);

    // And with --cache the entry from the first run produces a hit
    const third = new WriteStreamsMock();
    await handler({cwd, stateDir, cache: true, shellIsolation: true}, third);
    expect(third.stdoutLines.join("\n")).toContain("restored from cache");
    expect(entryStats().count).toBe(1);
});
