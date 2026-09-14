import fs from "fs-extra";
import {WriteStreamsMock} from "../../../src/write-streams.js";
import {handler} from "../../../src/handler.js";
import {initSpawnSpy} from "../../mocks/utils.mock.js";
import {WhenStatics} from "../../mocks/when-statics.js";

beforeAll(() => {
    initSpawnSpy(WhenStatics.all);
    fs.rmSync(`${cwd}/${stateDir}`, {recursive: true, force: true});
});

const cwd = "tests/test-cases/cache-failure-not-cached";
const stateDir = ".gitlab-ci-local-cache-failure-not-cached";

test("cache-failure-not-cached <failing job re-runs every time>", async () => {
    for (let i = 0; i < 2; i++) {
        const writeStreams = new WriteStreamsMock();
        await handler({cwd, stateDir, cache: true, shellIsolation: true}, writeStreams);

        const out = writeStreams.stdoutLines.join("\n");
        expect(out).toContain("failing-executed");
        expect(out).not.toContain("restored from cache");
    }
});
