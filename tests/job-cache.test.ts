import fs from "fs-extra";
import {WriteStreamsMock} from "../src/write-streams.js";
import {Argv} from "../src/argv.js";
import {Parser} from "../src/parser.js";
import {JobCache, hashTrackedFiles} from "../src/job-cache.js";
import {VOLATILE_VARIABLES} from "../src/volatile-vars.js";
import {Utils} from "../src/utils.js";
import {initSpawnSpy} from "./mocks/utils.mock.js";
import {WhenStatics} from "./mocks/when-statics.js";

beforeAll(() => {
    initSpawnSpy(WhenStatics.all);
    // Parser writes state files into the fixture state dir; keep git status clean
    fs.outputFileSync(`${cwd}/${stateDir}/.gitignore`, "*\n!.gitignore\n");
});

const cwd = "tests/test-cases/cache-fingerprints";
const stateDir = ".gitlab-ci-local-cache-unit";

async function setup (opts: {file?: string; variable?: string[]} = {}) {
    const writeStreams = new WriteStreamsMock();
    const argv = await Argv.build({
        cwd,
        stateDir,
        file: opts.file,
        variable: opts.variable ?? [],
    }, writeStreams);
    const jobCache = await JobCache.init(argv, writeStreams);
    const parser = await Parser.create(argv, writeStreams, 1, [], true, jobCache);
    return {jobCache, jobs: parser.jobs};
}

test("job-cache <fingerprint is stable across job instances and invocations>", async () => {
    const first = await setup();
    const second = await setup();

    const buildA = first.jobs.find((j) => j.name === "fp-build")!;
    const buildB = second.jobs.find((j) => j.name === "fp-build")!;
    // Different Job instances get different CI_JOB_ID/CI_JOB_STARTED_AT values;
    // volatile variables must not change the fingerprint.
    expect(buildA.jobId).not.toBe(buildB.jobId);
    expect(second.jobCache.fingerprint(buildB)).toBe(first.jobCache.fingerprint(buildA));
});

test("job-cache <reordering script lines changes the fingerprint>", async () => {
    const orderA = await setup({file: "fingerprint-order-a.yml"});
    const orderB = await setup({file: "fingerprint-order-b.yml"});

    const fpA = orderA.jobCache.fingerprint(orderA.jobs[0]);
    const fpB = orderB.jobCache.fingerprint(orderB.jobs[0]);
    expect(fpA).not.toBe(fpB);
});

test("job-cache <user variable change invalidates, volatile override does not>", async () => {
    const plain = await setup();
    const buildPlain = plain.jobs.find((j) => j.name === "fp-build")!;

    const userChanged = await setup({variable: ["USER_VAR=other"]});
    const buildUserChanged = userChanged.jobs.find((j) => j.name === "fp-build")!;
    expect(userChanged.jobCache.fingerprint(buildUserChanged)).not.toBe(plain.jobCache.fingerprint(buildPlain));

    const volatileChanged = await setup({variable: ["CI_JOB_ID=424242", "CI_PIPELINE_ID=999999"]});
    const buildVolatileChanged = volatileChanged.jobs.find((j) => j.name === "fp-build")!;
    expect(volatileChanged.jobCache.fingerprint(buildVolatileChanged)).toBe(plain.jobCache.fingerprint(buildPlain));
});

test("job-cache <producer change transitively invalidates consumers>", async () => {
    const base = await setup();
    const variant = await setup({file: "fingerprint-build-variant.yml"});

    const deployBase = base.jobs.find((j) => j.name === "fp-deploy")!;
    const deployVariant = variant.jobs.find((j) => j.name === "fp-deploy")!;
    // The consumer's own definition is identical in both files; only the
    // producer's script changed, which must still invalidate the consumer.
    expect(variant.jobCache.fingerprint(deployVariant)).not.toBe(base.jobCache.fingerprint(deployBase));
});

test("job-cache <every variable is volatile or explicitly hashed>", async () => {
    // Guards against new predefined variables silently becoming fingerprint
    // inputs: any variable not classified here makes runs needlessly cache-miss.
    const hashedAllowlist = new Set([
        "CI",
        "GITLAB_CI",
        "GITLAB_USER_LOGIN",
        "GITLAB_USER_EMAIL",
        "GITLAB_USER_NAME",
        "GITLAB_USER_ID",
        "CI_COMMIT_SHORT_SHA",
        "CI_COMMIT_SHA",
        "CI_COMMIT_REF_PROTECTED",
        "CI_COMMIT_BRANCH",
        "CI_COMMIT_REF_NAME",
        "CI_COMMIT_REF_SLUG",
        "CI_COMMIT_TITLE",
        "CI_COMMIT_MESSAGE",
        "CI_COMMIT_DESCRIPTION",
        "CI_DEFAULT_BRANCH",
        "CI_PIPELINE_SOURCE",
        "CI_PROJECT_NAME",
        "CI_PROJECT_TITLE",
        "CI_PROJECT_PATH",
        "CI_PROJECT_PATH_SLUG",
        "CI_PROJECT_ROOT_NAMESPACE",
        "CI_PROJECT_NAMESPACE",
        "CI_PROJECT_VISIBILITY",
        "CI_PROJECT_ID",
        "CI_PROJECT_URL",
        "CI_SERVER_FQDN",
        "CI_SERVER_HOST",
        "CI_SERVER_PORT",
        "CI_SERVER_SHELL_SSH_PORT",
        "CI_SERVER_URL",
        "CI_SERVER_PROTOCOL",
        "CI_API_V4_URL",
        "CI_TEMPLATE_REGISTRY_HOST",
        "FF_DISABLE_UMASK_FOR_DOCKER_EXECUTOR",
        "CI_DEPENDENCY_PROXY_DIRECT_GROUP_IMAGE_PREFIX",
        "CI_DEPENDENCY_PROXY_GROUP_IMAGE_PREFIX",
        "CI_DEPENDENCY_PROXY_SERVER",
        "CI_DEPENDENCY_PROXY_USER",
        "CI_REGISTRY",
        "CI_REGISTRY_IMAGE",
        "CI_NODE_TOTAL",
        "CI_ENVIRONMENT_NAME",
        "CI_ENVIRONMENT_SLUG",
        "CI_ENVIRONMENT_URL",
        "CI_ENVIRONMENT_TIER",
        "CI_ENVIRONMENT_ACTION",
        "USER_VAR", // fixture project variable
    ]);

    const {jobs} = await setup();
    for (const job of jobs) {
        const expanded = Utils.expandVariables(job.rawVariables);
        for (const name of Object.keys(expanded)) {
            expect(VOLATILE_VARIABLES.has(name) || hashedAllowlist.has(name)).toBe(true);
        }
    }
});

test("job-cache <file index skips unchanged files, rehashes changed and prunes deleted>", async () => {
    const indexDir = `${cwd}/${stateDir}/file-index-test`;
    const filesDir = `${cwd}/${stateDir}/index-files`;
    fs.rmSync(indexDir, {recursive: true, force: true});
    fs.rmSync(filesDir, {recursive: true, force: true});
    fs.outputFileSync(`${filesDir}/a.txt`, "alpha");
    fs.outputFileSync(`${filesDir}/b.txt`, "beta");
    const relA = ".gitlab-ci-local-cache-unit/index-files/a.txt";
    const relB = ".gitlab-ci-local-cache-unit/index-files/b.txt";

    const hash1 = await hashTrackedFiles(cwd, indexDir, [relA, relB]);
    let index = fs.readJsonSync(`${indexDir}/file-index.json`);
    expect(Object.keys(index).sort()).toEqual([relA, relB].sort());

    // Index is trusted when mtime+size match: poison the stored hash and see it used
    index[relA].hash = "poisoned";
    fs.outputJsonSync(`${indexDir}/file-index.json`, index);
    const hash2 = await hashTrackedFiles(cwd, indexDir, [relA, relB]);
    expect(hash2).not.toBe(hash1);
    expect(fs.readJsonSync(`${indexDir}/file-index.json`)[relA].hash).toBe("poisoned");

    // Same content, bumped mtime: rehashed, aggregate hash unchanged
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(`${cwd}/${relA}`, future, future);
    const hash3 = await hashTrackedFiles(cwd, indexDir, [relA, relB]);
    expect(hash3).toBe(hash1);
    expect(fs.readJsonSync(`${indexDir}/file-index.json`)[relA].hash).not.toBe("poisoned");

    // Changed content: aggregate hash changes
    fs.outputFileSync(`${filesDir}/b.txt`, "beta-gamma");
    const hash4 = await hashTrackedFiles(cwd, indexDir, [relA, relB]);
    expect(hash4).not.toBe(hash1);

    // Deleted from the file list: pruned from the index
    await hashTrackedFiles(cwd, indexDir, [relA]);
    index = fs.readJsonSync(`${indexDir}/file-index.json`);
    expect(Object.keys(index)).toEqual([relA]);
});
