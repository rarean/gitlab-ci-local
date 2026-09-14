import {spawn, execSync} from "node:child_process";
import fs from "fs-extra";
import * as path from "node:path";

// A SIGINT-cancelled docker-executor run must leave no orphaned containers,
// volumes, or networks behind. Requires a docker daemon; skipped otherwise,
// so it is exercised in CI and skipped in docker-less development
// environments.
const dockerAvailable = (() => {
    try {
        execSync("docker info --format {{.ServerVersion}}", {stdio: "ignore"});
        return true;
    } catch {
        return false;
    }
})();

const cwd = "tests/test-cases/signal-containers";
const stateDir = ".gitlab-ci-local-signal-containers";
const repoRoot = path.resolve(import.meta.dirname, "../../..");

function dockerList (kind: "ps" | "volume" | "network", nameFilter: string): string[] {
    const flag = kind === "ps" ? "ps -aq" : kind === "volume" ? "volume ls -q" : "network ls -q";
    const out = execSync(`docker ${flag} --filter name=${nameFilter}`, {encoding: "utf8"});
    return out.split("\n").filter((line) => line !== "");
}

describe.skipIf(!dockerAvailable)("signal-containers <SIGINT cleans up docker resources>", () => {

    test("no gcl-prefixed containers, volumes, or networks survive", async () => {
        fs.rmSync(`${cwd}/${stateDir}`, {recursive: true, force: true});

        const child = spawn("bun", [
            `${repoRoot}/src/index.ts`,
            "--cwd", cwd,
            "--state-dir", stateDir,
            "container-sleep-job",
        ], {stdio: ["ignore", "pipe", "pipe"]});

        // Wait until the job script is running inside the container.
        const started = new Promise<void>((resolve) => {
            let out = "";
            child.stdout.on("data", (data) => {
                out += data.toString();
                if (out.includes("in container")) resolve();
            });
        });
        await Promise.race([started, new Promise((r) => setTimeout(r, 120_000))]);

        child.kill("SIGINT");
        const exitCode = await new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));

        expect(exitCode).toBe(130);
        // Give the async cleanup its exit-code-beats-us window, then sweep.
        await new Promise((r) => setTimeout(r, 3_000));
        expect(dockerList("ps", "gcl-")).toEqual([]);
        expect(dockerList("volume", "gcl-")).toEqual([]);
        expect(dockerList("network", "gitlab-ci-local-")).toEqual([]);
    }, 180_000);
});
