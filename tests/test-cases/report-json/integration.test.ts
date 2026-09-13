import fs from "fs-extra";
import path from "node:path";
import {WriteStreamsMock} from "../../../src/write-streams.js";
import {handler} from "../../../src/handler.js";
import {Executor} from "../../../src/executor.js";
import {Job} from "../../../src/job.js";
import {initSpawnSpy} from "../../mocks/utils.mock.js";
import {WhenStatics} from "../../mocks/when-statics.js";

beforeAll(() => {
    initSpawnSpy(WhenStatics.all);
});

const cwd = "tests/test-cases/report-json";

test("report-json <full pipeline>", async () => {
    const writeStreams = new WriteStreamsMock();
    const stateDir = ".gitlab-ci-local-report-json-pipeline";
    const reportPath = `${cwd}/${stateDir}/report.json`; // relative to invocation cwd (repo root)
    await handler({
        cwd,
        stateDir,
        reportJson: reportPath,
        shellIsolation: true,
    }, writeStreams);

    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    expect(report.schemaVersion).toBe(1);
    expect(report.status).toBe("failed");
    expect(typeof report.pipelineIid).toBe("number");
    expect(report.jobs).toHaveLength(8);

    const statuses: Record<string, string> = {};
    for (const job of report.jobs) {
        statuses[job.name] = job.status;
    }
    expect(statuses).toEqual({
        "success-job": "success",
        "allowed-fail-job": "failed_allowed",
        "exit-codes-allowed-job": "failed_allowed",
        "after-fail-job": "success_with_warnings",
        "fail-job": "failed",
        "dotenv-job": "skipped",
        "manual-job": "manual",
        "never-job": "disabled",
    });

    for (const job of report.jobs) {
        expect(job.cached).toBe(false);
        expect(fs.existsSync(`${reportPath}.tmp`)).toBe(false);
        if (job.started) {
            expect(job.durationMs).toBeGreaterThanOrEqual(0);
            expect(fs.existsSync(path.resolve(cwd, job.logPath))).toBe(true);
        } else {
            expect(job.durationMs).toBeNull();
            expect(job.logPath).toBeNull();
        }
    }

    const successJob = report.jobs.find((j: any) => j.name === "success-job");
    expect(successJob.services).toEqual([]);
    expect(successJob.artifacts).toEqual([]);
});

test("report-json <stage test>", async () => {
    const writeStreams = new WriteStreamsMock();
    const stateDir = ".gitlab-ci-local-report-json-stage";
    const reportPath = `${cwd}/${stateDir}/report.json`; // relative to invocation cwd (repo root)
    await handler({
        cwd,
        stage: "test",
        stateDir,
        reportJson: reportPath,
        shellIsolation: true,
    }, writeStreams);

    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    expect(report.status).toBe("failed");
    const statuses: Record<string, string> = {};
    for (const job of report.jobs) {
        statuses[job.name] = job.status;
    }
    expect(statuses).toEqual({
        "success-job": "success",
        "allowed-fail-job": "failed_allowed",
        "exit-codes-allowed-job": "failed_allowed",
        "after-fail-job": "success_with_warnings",
        "fail-job": "failed",
    });
});

test("report-json <named job, exit codes unchanged>", async () => {
    const writeStreams = new WriteStreamsMock();
    const stateDir = ".gitlab-ci-local-report-json-job";
    const reportPath = `${cwd}/${stateDir}/report.json`; // relative to invocation cwd (repo root)
    const jobs: Job[] = [];
    await handler({
        cwd,
        job: ["success-job"],
        stateDir,
        reportJson: reportPath,
        shellIsolation: true,
    }, writeStreams, jobs);

    expect(Executor.getFailed(jobs)).toHaveLength(0);

    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    expect(report.status).toBe("success");
    const statuses: Record<string, string> = {};
    for (const job of report.jobs) {
        statuses[job.name] = job.status;
    }
    expect(statuses).toEqual({
        "success-job": "success",
        "allowed-fail-job": "skipped",
        "exit-codes-allowed-job": "skipped",
        "after-fail-job": "skipped",
        "fail-job": "skipped",
        "dotenv-job": "skipped",
        "manual-job": "manual",
        "never-job": "disabled",
    });
});

test("report-json <named failing job marks run failed>", async () => {
    const writeStreams = new WriteStreamsMock();
    const stateDir = ".gitlab-ci-local-report-json-failing-job";
    const reportPath = `${cwd}/${stateDir}/report.json`; // relative to invocation cwd (repo root)
    const jobs: Job[] = [];
    await handler({
        cwd,
        job: ["fail-job"],
        stateDir,
        reportJson: reportPath,
        shellIsolation: true,
    }, writeStreams, jobs);

    expect(Executor.getFailed(jobs)).toHaveLength(1);

    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    expect(report.status).toBe("failed");
    const failJob = report.jobs.find((j: any) => j.name === "fail-job");
    expect(failJob.status).toBe("failed");
    expect(failJob.prescriptsExitCode).toBe(1);
    expect(fs.existsSync(path.resolve(cwd, failJob.logPath))).toBe(true);
});
