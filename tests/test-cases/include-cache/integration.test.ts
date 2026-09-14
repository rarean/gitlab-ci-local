import fs from "fs-extra";
import axios from "axios";
import AxiosMockAdapter from "axios-mock-adapter";
import {WriteStreamsMock} from "../../../src/write-streams.js";
import {handler} from "../../../src/handler.js";
import {initSpawnSpy} from "../../mocks/utils.mock.js";
import {WhenStatics} from "../../mocks/when-statics.js";

beforeAll(() => {
    initSpawnSpy(WhenStatics.all);
});

const cwd = "tests/test-cases/include-cache";
const url = "https://gitlab.com/firecow/gitlab-ci-local-includes/-/raw/master/include-cache-remote.yml";
const etag = "\"include-cache-v1\"";

beforeEach(() => {
    fs.rmSync(`${cwd}/.gitlab-ci-local-include-cache-det`, {recursive: true, force: true});
    fs.rmSync(`${cwd}/.gitlab-ci-local-include-cache-plain`, {recursive: true, force: true});
});

test("include-cache <deterministic mode serves from cache after first fetch>", async () => {
    const mock = new AxiosMockAdapter(axios);
    let hits = 0;
    mock.onGet(url).reply(() => {
        hits++;
        return [200, "cache-remote-job:\n  stage: test\n  script: echo \"Remote include content\"\n", {etag}];
    });

    try {
        const first = new WriteStreamsMock();
        await handler({cwd, stateDir: ".gitlab-ci-local-include-cache-det", deterministic: true, job: ["cache-remote-job"]}, first);
        expect(hits).toBe(1);
        expect(first.stderrLines.join("\n")).toContain("downloaded");
        expect(first.stdoutLines.join("\n")).toContain("Remote include content");

        // Second invocation must not touch the network at all — any request
        // would hit the mock (and it would fail the run's own expectations).
        const second = new WriteStreamsMock();
        await handler({cwd, stateDir: ".gitlab-ci-local-include-cache-det", deterministic: true, job: ["cache-remote-job"]}, second);
        expect(hits).toBe(1);
        expect(second.stderrLines.join("\n")).toContain("served from include cache");
        expect(second.stdoutLines.join("\n")).toContain("Remote include content");
    } finally {
        mock.restore();
    }
});

test("include-cache <plain mode keeps today's behavior and revalidates on refetch>", async () => {
    const mock = new AxiosMockAdapter(axios);
    let hits = 0;
    mock.onGet(url).reply((config) => {
        hits++;
        const headers = config.headers as any;
        const noneMatch = headers?.["If-None-Match"] ?? headers?.get?.("If-None-Match");
        if (noneMatch === etag) return [304, undefined, {etag}];
        return [200, "cache-remote-job:\n  stage: test\n  script: echo \"Remote include content\"\n", {etag}];
    });

    try {
        const first = new WriteStreamsMock();
        await handler({cwd, stateDir: ".gitlab-ci-local-include-cache-plain", job: ["cache-remote-job"]}, first);
        expect(hits).toBe(1);
        expect(first.stdoutLines.join("\n")).toContain("Remote include content");

        // Without --fetch-includes the on-disk include is reused — no request.
        const second = new WriteStreamsMock();
        await handler({cwd, stateDir: ".gitlab-ci-local-include-cache-plain", job: ["cache-remote-job"]}, second);
        expect(hits).toBe(1);

        // The refetch path revalidates: the stored etag turns it into a 304.
        const third = new WriteStreamsMock();
        await handler({cwd, stateDir: ".gitlab-ci-local-include-cache-plain", fetchIncludes: true, job: ["cache-remote-job"]}, third);
        expect(hits).toBe(2);
        expect(third.stderrLines.join("\n")).toContain("not modified");
        expect(third.stdoutLines.join("\n")).toContain("Remote include content");
    } finally {
        mock.restore();
    }
});
