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
    // The consumer is defined in an (untracked) .gitlab-ci-local.yml so that
    // rewriting it invalidates only the consumer's fingerprint — the tracked
    // files hash, and therefore the producer's fingerprint, stays unchanged.
    fs.rmSync(localYmlPath, {force: true});
});

const cwd = "tests/test-cases/cache-dotenv";
const stateDir = ".gitlab-ci-local-cache-dotenv";
const localYmlPath = `${cwd}/.gitlab-ci-local.yml`;

const consumerV1 = `
deploy:
  stage: deploy
  needs: [build]
  script:
    - if [ "$BUILD_VERSION" = "CacheMe" ]; then echo "dotenv-value-ok"; else echo "dotenv-value-missing"; exit 1; fi
`;
const consumerV2 = `
deploy:
  stage: deploy
  needs: [build]
  script:
    - if [ "$BUILD_VERSION" = "CacheMe" ]; then echo "dotenv-value-ok"; else echo "dotenv-value-missing"; exit 1; fi
    - echo "redeploy-ran"
`;

test("cache-dotenv <cached producer replays dotenv into re-run consumer>", async () => {
    fs.outputFileSync(localYmlPath, consumerV1);

    const first = new WriteStreamsMock();
    await handler({cwd, stateDir, cache: true, shellIsolation: true}, first);

    const firstOut = first.stdoutLines.join("\n");
    expect(firstOut).toContain("dotenv-value-ok");
    expect(firstOut).not.toContain("restored from cache");

    fs.outputFileSync(localYmlPath, consumerV2);

    const second = new WriteStreamsMock();
    await handler({cwd, stateDir, cache: true, shellIsolation: true}, second);

    const secondOut = second.stdoutLines.join("\n");
    // Producer restored, consumer re-ran and saw the restored dotenv value.
    // `redeploy-ran` only prints when the `if` passed — `set -e` stops the
    // script in the else branch, so its echoed command text is not proof.
    expect(secondOut).toContain("restored from cache");
    expect(secondOut).toContain("redeploy-ran");
});
