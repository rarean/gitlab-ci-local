#!/usr/bin/env bun
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import * as fs from "node:fs/promises";
import {createHash} from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import {StdioServerTransport} from "@modelcontextprotocol/sdk/server/stdio.js";
import {z} from "zod";

/**
 * Mirrors Utils.safeDockerString from src/utils.ts: the CLI writes job logs to
 * `output/<safeJobName>.log`, where every character outside [A-Za-z0-9_-] is
 * base64url-encoded and overlong names are hash-truncated to NAME_MAX. The
 * wrapper keeps its own copy so it stays free of src/ imports.
 */
function safeJobName (jobName: string): string {
    const maxFilenameLength = 255 - 17; // NAME_MAX (bytes) minus the jobId wrapper
    const encoded = jobName.replace(/[^\w-]+/g, (match) => Buffer.from(match, "utf8").toString("base64url"));
    if (encoded.length <= maxFilenameLength) return encoded;
    const hash = createHash("sha256").update(jobName).digest("hex").substring(0, 16);
    const prefix = encoded.substring(0, maxFilenameLength - 1 - hash.length);
    return `${prefix}-${hash}`;
}

const execFileAsync = promisify(execFile);

// The wrapper is a dumb adapter: every tool shells out to the CLI and never
// imports from the core src/ tree. GITLAB_CI_LOCAL_BIN points at the executable
// when it is not on PATH (e.g. a checkout run through bun). Deliberately not
// GCL_BIN: the CLI reads GCL_* as options (yargs .env("GCL")), so a GCL_-
// prefixed name here would inject an "Unknown argument" into every child.
const CLI_BIN = process.env.GITLAB_CI_LOCAL_BIN ?? "gitlab-ci-local";
const DEFAULT_STATE_DIR = ".gitlab-ci-local";

type CliResult = {stdout: string; stderr: string; exitCode: number | null};

async function runCli (args: string[], cwd: string): Promise<CliResult> {
    const env = {...process.env};
    delete env.GITLAB_CI_LOCAL_BIN;
    try {
        const {stdout, stderr} = await execFileAsync(CLI_BIN, args, {cwd, maxBuffer: 64 * 1024 * 1024, env});
        return {stdout, stderr, exitCode: 0};
    } catch (e: any) {
        // Non-zero exits carry the interesting output too (execFile throws on
        // them). Spawn failures (e.code is a string like "ENOENT") have empty
        // stdio — surface the message instead of an empty error.
        const spawnFailure = typeof e.code === "string";
        return {
            stdout: e.stdout ?? "",
            stderr: e.stderr || (spawnFailure ? (e.message ?? String(e)) : ""),
            exitCode: typeof e.code === "number" ? e.code : null,
        };
    }
}

function textContent (payload: unknown, isError = false) {
    return {content: [{type: "text" as const, text: JSON.stringify(payload, null, 2)}], ...(isError ? {isError: true} : {})};
}

async function main () {
    const server = new McpServer({name: "gitlab-ci-local", version: "0.1.0"});

    server.registerTool("list_jobs", {
        title: "List pipeline jobs",
        description: "Enumerates the pipeline's jobs (name, stage, when, needs) via `gitlab-ci-local --list-json`. Call this first; never guess job names.",
        inputSchema: {
            cwd: z.string().describe("Project directory containing .gitlab-ci.yml"),
        },
    }, async ({cwd}) => {
        const result = await runCli(["--list-json"], cwd);
        if (result.exitCode !== 0) return textContent({error: result.stderr || result.stdout, exitCode: result.exitCode}, true);
        return textContent(JSON.parse(result.stdout));
    });

    server.registerTool("run_jobs", {
        title: "Run a job selection",
        description: "Runs jobs (named selection or a whole stage) and returns the --report-json payload: per-job status, exit codes, durationMs and logPath. Non-zero CLI exit codes do not throw — the report carries the failure detail.",
        inputSchema: {
            cwd: z.string().describe("Project directory containing .gitlab-ci.yml"),
            jobs: z.array(z.string()).optional().describe("Job names to run (see list_jobs)"),
            needs: z.boolean().optional().describe("Also run everything the selected jobs need"),
            onlyNeeds: z.boolean().optional().describe("Run only the dependencies, not the selected jobs themselves"),
            stage: z.string().optional().describe("Run this whole stage instead of named jobs"),
            variables: z.array(z.string()).optional().describe("Job variables, as KEY=value entries"),
            cache: z.boolean().optional().describe("Enable job memoization for this run"),
            stateDir: z.string().optional().describe(`State dir override for concurrent agents (default ${DEFAULT_STATE_DIR})`),
        },
    }, async ({cwd, jobs, needs, onlyNeeds, stage, variables, cache, stateDir}) => {
        const reportDir = await fs.mkdtemp(path.join(os.tmpdir(), "gcl-mcp-report-"));
        const reportPath = path.join(reportDir, "report.json");
        // No --cwd here: the CLI requires it to be relative, so the child's
        // process cwd (runCli) carries the location instead.
        const args = ["--report-json", reportPath];
        if (stateDir) args.push("--state-dir", stateDir);
        if (needs) args.push("--needs");
        if (onlyNeeds) args.push("--only-needs");
        if (stage) args.push("--stage", stage);
        for (const variable of variables ?? []) args.push("--variable", variable);
        if (cache) args.push("--cache");
        args.push(...(jobs ?? []));

        try {
            const result = await runCli(args, cwd);
            let report: any = null;
            try {
                report = JSON.parse(await fs.readFile(reportPath, "utf8"));
            } catch {
                // No report file — surface the CLI's own error output instead.
            }
            if (report == null) return textContent({error: result.stderr || result.stdout, exitCode: result.exitCode}, true);
            return textContent({...report, cliExitCode: result.exitCode});
        } finally {
            await fs.rm(reportDir, {recursive: true, force: true});
        }
    });

    server.registerTool("get_log", {
        title: "Read a job log",
        description: "Reads a job's full output log (the report's logPath), optionally only the last N lines.",
        inputSchema: {
            cwd: z.string().describe("Project directory the pipeline ran in"),
            job: z.string().describe("Job name as it appears in the report"),
            tailLines: z.number().int().positive().optional().describe("Only return the last N lines"),
            stateDir: z.string().optional().describe(`State dir used for the run (default ${DEFAULT_STATE_DIR})`),
        },
    }, async ({cwd, job, tailLines, stateDir}) => {
        const logPath = path.join(cwd, stateDir ?? DEFAULT_STATE_DIR, "output", `${safeJobName(job)}.log`);
        try {
            const content = await fs.readFile(logPath, "utf8");
            const lines = tailLines == null ? content : content.split("\n").slice(-tailLines).join("\n");
            return textContent({logPath, content: lines});
        } catch {
            return textContent({error: `No log at ${logPath}. Jobs write logs after they start; pass the job name exactly as the report shows it.`}, true);
        }
    });

    server.registerTool("clear_cache", {
        title: "Clear the job memoization cache",
        description: "Deletes the state dir cache folder (gitlab-ci-local --clear-cache) and exits.",
        inputSchema: {
            cwd: z.string().describe("Project directory"),
            stateDir: z.string().optional().describe(`State dir override (default ${DEFAULT_STATE_DIR})`),
        },
    }, async ({cwd, stateDir}) => {
        const args = ["--clear-cache"];
        if (stateDir) args.push("--state-dir", stateDir);
        const result = await runCli(args, cwd);
        if (result.exitCode !== 0) return textContent({exitCode: result.exitCode, output: result.stdout || result.stderr}, true);
        return textContent({exitCode: result.exitCode, output: result.stdout || result.stderr});
    });

    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main().catch((e) => {
    process.stderr.write(`gitlab-ci-local-mcp-server failed to start: ${e.stack ?? e}\n`);
    process.exit(1);
});
