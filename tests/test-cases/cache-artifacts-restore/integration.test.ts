import fs from "fs-extra";
import {WriteStreamsMock} from "../../../src/write-streams.js";
import {handler} from "../../../src/handler.js";
import {initSpawnSpy} from "../../mocks/utils.mock.js";
import {WhenStatics} from "../../mocks/when-statics.js";

beforeAll(() => {
    initSpawnSpy(WhenStatics.all);
    fs.rmSync(`${cwd}/${stateDir}`, {recursive: true, force: true});
});

afterAll(() => {
    // Same trick as cache-dotenv: the consumer lives in an (untracked)
    // .gitlab-ci-local.yml, so rewriting it invalidates only the consumer.
    fs.rmSync(localYmlPath, {force: true});
});

const cwd = "tests/test-cases/cache-artifacts-restore";
const stateDir = ".gitlab-ci-local-cache-artifacts-restore";
const localYmlPath = `${cwd}/.gitlab-ci-local.yml`;

const consumerV1 = `
consume:
  stage: deploy
  needs: [build]
  script:
    - echo "checksum-marker $(cksum < out.bin)"
`;
const consumerV2 = `
consume:
  stage: deploy
  needs: [build]
  script:
    - echo "checksum-marker $(cksum < out.bin)"
    - echo "consume-reran"
`;

function checksumOf (out: string[]): string {
    for (const line of out) {
        const match = /checksum-marker (\d+ \d+)/.exec(line);
        if (match) return match[1];
    }
    throw new Error("no checksum-marker output found");
}

test("cache-artifacts-restore <restored producer artifacts are byte-identical>", async () => {
    fs.outputFileSync(localYmlPath, consumerV1);

    const first = new WriteStreamsMock();
    await handler({cwd, stateDir, cache: true, shellIsolation: true}, first);
    const firstChecksum = checksumOf(first.stdoutLines);
    const firstBytes = fs.readFileSync(`${cwd}/${stateDir}/artifacts/build/out.bin`);

    fs.outputFileSync(localYmlPath, consumerV2);

    const second = new WriteStreamsMock();
    await handler({cwd, stateDir, cache: true, shellIsolation: true}, second);

    const secondOut = second.stdoutLines.join("\n");
    expect(secondOut).toContain("restored from cache");
    expect(secondOut).toContain("consume-reran");

    expect(checksumOf(second.stdoutLines)).toBe(firstChecksum);
    expect(fs.readFileSync(`${cwd}/${stateDir}/artifacts/build/out.bin`)).toEqual(firstBytes);
});
