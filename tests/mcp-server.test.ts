import {spawn} from "node:child_process";
import fs from "fs-extra";
import * as os from "node:os";
import * as path from "node:path";

// Smoke test for contrib/mcp-server: spawns the server over stdio, performs
// the MCP handshake by hand (no SDK dependency in the root project), and
// round-trips list_jobs through a GITLAB_CI_LOCAL_BIN shim that runs this
// checkout. Skipped while the contrib package's dependencies are not
// installed.
const repoRoot = path.resolve(import.meta.dirname, "..");
const contribInstalled = fs.pathExistsSync(`${repoRoot}/contrib/mcp-server/node_modules/@modelcontextprotocol/sdk`);

describe.skipIf(!contribInstalled)("mcp-server <stdio smoke test>", () => {

    test("handshake + tools/list + list_jobs round-trip", async () => {
        // Shim so the wrapper drives this checkout instead of a PATH install.
        const shimDir = await fs.mkdtemp(path.join(os.tmpdir(), "gcl-mcp-shim-"));
        const shim = path.join(shimDir, "gitlab-ci-local");
        await fs.writeFile(shim, `#!/bin/sh\nexec bun ${repoRoot}/src/index.ts "$@"\n`);
        await fs.chmod(shim, 0o755);

        const server = spawn("bun", [`${repoRoot}/contrib/mcp-server/src/index.ts`], {
            env: {...process.env, GITLAB_CI_LOCAL_BIN: shim},
            stdio: ["pipe", "pipe", "pipe"],
        });
        let stderr = "";
        server.stderr!.on("data", (data) => stderr += data.toString());

        const send = (message: any) => server.stdin!.write(`${JSON.stringify(message)}\n`);
        const nextMessage = (() => {
            let buffer = "";
            const pending: ((message: any) => void)[] = [];
            const lines: string[] = [];
            server.stdout!.on("data", (data) => {
                buffer += data.toString();
                let index: number;
                while ((index = buffer.indexOf("\n")) >= 0) {
                    lines.push(buffer.substring(0, index));
                    buffer = buffer.substring(index + 1);
                    const waiter = pending.shift();
                    if (waiter) waiter(JSON.parse(lines.pop()!));
                }
            });
            return () => new Promise<any>((resolve) => {
                const already = lines.shift();
                if (already) return resolve(JSON.parse(already));
                pending.push(resolve);
            });
        })();

        try {
            const initialize = nextMessage();
            send({jsonrpc: "2.0", id: 1, method: "initialize", params: {protocolVersion: "2025-06-18", capabilities: {}, clientInfo: {name: "smoke-test", version: "0.0.0"}}});
            const initResponse = await Promise.race([initialize, new Promise((_, reject) => setTimeout(() => reject(new Error(`initialize timed out${stderr ? `: ${stderr}` : ""}`)), 20_000))]);
            expect(initResponse.id).toBe(1);
            expect(initResponse.result.serverInfo.name).toBe("gitlab-ci-local");
            send({jsonrpc: "2.0", method: "notifications/initialized"});

            const listTools = nextMessage();
            send({jsonrpc: "2.0", id: 2, method: "tools/list"});
            const toolsResponse = await listTools;
            expect(toolsResponse.result.tools.map((tool: any) => tool.name)).toEqual(
                expect.arrayContaining(["list_jobs", "run_jobs", "get_log", "clear_cache"]),
            );

            const callListJobs = nextMessage();
            send({jsonrpc: "2.0", id: 3, method: "tools/call", params: {name: "list_jobs", arguments: {cwd: path.join(repoRoot, "tests/test-cases/mcp-smoke")}}});
            const callResponse = await callListJobs;
            expect(callResponse.result.isError).not.toBe(true);
            const payload = JSON.parse(callResponse.result.content[0].text);
            expect(payload).toEqual(expect.arrayContaining([
                expect.objectContaining({name: "smoke-job", stage: "test"}),
            ]));

            // run_jobs executes the shell fixture and returns the parsed report.
            const callRunJobs = nextMessage();
            send({jsonrpc: "2.0", id: 4, method: "tools/call", params: {name: "run_jobs", arguments: {cwd: path.join(repoRoot, "tests/test-cases/mcp-smoke"), jobs: ["smoke-job"], stateDir: ".gitlab-ci-local-mcp-smoke"}}});
            const runResponse = await callRunJobs;
            expect(runResponse.result.isError).not.toBe(true);
            const report = JSON.parse(runResponse.result.content[0].text);
            expect(report.cliExitCode).toBe(0);
            expect(report.status).toBe("success");
            expect(report.jobs[0]).toMatchObject({name: "smoke-job", status: "success", started: true});

            // get_log reads back what the report points at.
            const callGetLog = nextMessage();
            send({jsonrpc: "2.0", id: 5, method: "tools/call", params: {name: "get_log", arguments: {cwd: path.join(repoRoot, "tests/test-cases/mcp-smoke"), job: "smoke-job", stateDir: ".gitlab-ci-local-mcp-smoke"}}});
            const logResponse = await callGetLog;
            expect(logResponse.result.isError).not.toBe(true);
            const logPayload = JSON.parse(logResponse.result.content[0].text);
            expect(logPayload.content).toContain("smoke");
        } finally {
            server.kill();
            await fs.rm(shimDir, {recursive: true, force: true});
        }
    }, 45_000);
});
