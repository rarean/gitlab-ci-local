import {spawn} from "node:child_process";
import fs from "fs-extra";
import * as path from "node:path";

// Spawns the real CLI as a subprocess (no spawn mocking): a cancelled run
// must still write a --report-json with the job states that existed at
// cancellation time.
const cwd = "tests/test-cases/report-cancel";
const stateDir = ".gitlab-ci-local-report-cancel";
const repoRoot = path.resolve(import.meta.dirname, "../../..");

test("report-cancel <SIGINT still writes the report>", async () => {
    fs.rmSync(`${cwd}/${stateDir}`, {recursive: true, force: true});
    const reportPath = `${cwd}/${stateDir}/report.json`;

    const child = spawn("bun", [
        `${repoRoot}/src/index.ts`,
        "--cwd", cwd,
        "--state-dir", stateDir,
        "--report-json", reportPath,
        "sleep-job",
    ], {stdio: ["ignore", "pipe", "pipe"]});

    // Wait until the job is actually running before cancelling. The orphaned
    // `sleep` child exits on its own shortly after.
    const started = new Promise<void>((resolve) => {
        let out = "";
        child.stdout.on("data", (data) => {
            out += data.toString();
            if (out.includes("starting")) resolve();
        });
    });
    await Promise.race([started, new Promise((r) => setTimeout(r, 15_000))]);

    child.kill("SIGINT");
    const exitCode = await new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));

    expect(exitCode).toBe(130);
    expect(fs.pathExistsSync(reportPath)).toBe(true);
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    expect(report.jobs).toHaveLength(1);
    expect(report.jobs[0].name).toBe("sleep-job");
    expect(report.jobs[0].started).toBe(true);
}, 30_000);
