import chalk from "chalk-template";
import fs from "fs-extra";
import * as crypto from "node:crypto";
import * as path from "node:path";
import * as dotenv from "dotenv";
import {Argv} from "./argv.js";
import {WriteStreams} from "./write-streams.js";
import {Utils} from "./utils.js";
import {withFileLock} from "./pid-file-lock.js";
import {VOLATILE_VARIABLES} from "./volatile-vars.js";
import type {Job} from "./job.js";

// Bump when the fingerprint document changes shape, so stale entries are
// never mistaken for hits.
const FINGERPRINT_VERSION = 1;

interface FileIndexEntry {
    hash: string;
    mtimeMs: number;
    size: number;
}

export interface JobCacheEntry {
    fingerprint: string;
    status: "success";
    finishedAt: string;
    durationMs: number | null;
    coveragePercent: string | null;
    afterScriptsExitCode: number;
    artifacts: string[];
    dotenv: {[key: string]: string};
    services: string[];
    dependencies: string[];
}

/**
 * Sorts object keys recursively, so the fingerprint document is canonical
 * regardless of property insertion order. Array order is preserved — script
 * line order genuinely matters.
 */
function canonical (value: any): any {
    if (Array.isArray(value)) return value.map(canonical);
    if (value !== null && typeof value === "object") {
        const sorted: any = {};
        for (const key of Object.keys(value).sort()) {
            if (value[key] === undefined) continue;
            sorted[key] = canonical(value[key]);
        }
        return sorted;
    }
    return value;
}

function filterVolatile (variables: {[key: string]: string}): {[key: string]: string} {
    const filtered: {[key: string]: string} = {};
    for (const [key, value] of Object.entries(variables)) {
        if (VOLATILE_VARIABLES.has(key)) continue;
        filtered[key] = value;
    }
    return filtered;
}

function sha256 (content: string): string {
    return crypto.createHash("sha256").update(content).digest("hex");
}

/** Streams a file through sha256, so large files don't need to fit in memory. */
async function hashFile (absPath: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash("sha256");
        fs.createReadStream(absPath)
            .on("data", (data) => hash.update(data))
            .on("error", reject)
            .on("end", () => resolve(hash.digest("hex")));
    });
}

/**
 * Hashes a file, re-reading once if the file changed mid-hash (stat mismatch).
 * Throws when the file keeps changing or disappears — callers fail soft and
 * treat the run as a cache miss instead of aborting.
 */
async function hashFileStable (absPath: string): Promise<{hash: string; mtimeMs: number; size: number}> {
    for (let attempt = 0; ; attempt++) {
        const before = await fs.stat(absPath);
        const hash = await hashFile(absPath);
        const after = await fs.stat(absPath);
        if (before.mtimeMs === after.mtimeMs && before.size === after.size) {
            return {hash, mtimeMs: after.mtimeMs, size: after.size};
        }
        if (attempt > 0) throw new Error(`File kept changing while hashing: ${absPath}`);
    }
}

/**
 * Hashes the contents of the given project-relative files, using a
 * path → {hash, mtimeMs, size} side-index stored in `<indexDir>/file-index.json`
 * to skip re-hashing files whose mtime and size are unchanged. Deleted entries
 * are pruned. The aggregate hash covers `path\0contentHash` pairs, sorted.
 *
 * Exported for unit tests; JobCache.init calls this with git-tracked files.
 */
export async function hashTrackedFiles (cwd: string, indexDir: string, files: string[]): Promise<string> {
    const indexPath = `${indexDir}/file-index.json`;
    let index: {[path: string]: FileIndexEntry} = {};
    try {
        index = await fs.readJson(indexPath);
    } catch {
        // Missing or corrupt index — start fresh.
    }

    const newIndex: {[path: string]: FileIndexEntry} = {};
    const pairs: string[] = [];
    for (const relPath of files) {
        const cached = index[relPath];
        let entry: FileIndexEntry;
        try {
            const absPath = `${cwd}/${relPath}`;
            const stat = await fs.stat(absPath);
            if (stat.isDirectory()) {
                // Directories (e.g. submodules) have no own content; their tracked
                // presence is still fingerprinted via the path below.
                entry = {hash: "<dir>", mtimeMs: 0, size: 0};
            } else if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
                entry = {hash: cached.hash, mtimeMs: cached.mtimeMs, size: cached.size};
            } else {
                entry = await hashFileStable(absPath);
            }
        } catch (e: any) {
            throw new Error(`Failed to hash tracked file ${relPath}: ${e.message}`, {cause: e});
        }
        newIndex[relPath] = entry;
        pairs.push(`${relPath}\0${entry.hash}`);
    }
    pairs.sort();

    // Best-effort persist; a torn/missing index only costs re-hashing next run.
    try {
        await fs.outputJson(indexPath, newIndex);
    } catch {
        // Ignore write failures.
    }

    return sha256(pairs.join("\n"));
}

/**
 * Content-addressed job memoization: skips re-executing jobs whose inputs are
 * unchanged since a previous successful run, restoring their artifacts.
 *
 * Entries live under `<cwd>/<stateDir>/cache/`:
 * - `jobs/<safeJobName>/<fingerprint>.json` — the run result entry
 * - `artifacts/<fingerprint>/`             — the exported artifact files
 *
 * This is deliberately a *job-level* cache; the GitLab `cache:` keyword is a
 * separate mechanism and keeps working as-is.
 */
export class JobCache {

    private readonly argv: Argv;
    private readonly writeStreams: WriteStreams;
    private jobs: ReadonlyArray<Job> = [];
    private memo: Map<string, string> = new Map();
    private trackedFilesHash: string | null = null;
    private warned = false;

    static async init (argv: Argv, writeStreams: WriteStreams): Promise<JobCache> {
        const cache = new JobCache(argv, writeStreams);
        try {
            const files = (await Utils.getTrackedFiles(argv.cwd)).filter((f) => f !== "").sort();
            cache.trackedFilesHash = await hashTrackedFiles(argv.cwd, cache.cacheDir, files);
        } catch (e: any) {
            // Fail soft: an unhashable worktree disables caching for this run.
            cache.warn(chalk`Job memoization disabled for this run: {yellow ${e.message ?? e}}\n`);
            cache.trackedFilesHash = null;
        }
        return cache;
    }

    private constructor (argv: Argv, writeStreams: WriteStreams) {
        this.argv = argv;
        this.writeStreams = writeStreams;
    }

    private get cacheDir (): string {
        return `${this.argv.cwd}/${this.argv.stateDir}/cache`;
    }

    private get jobsCacheDir (): string {
        return `${this.cacheDir}/jobs`;
    }

    private get artifactsCacheDir (): string {
        return `${this.cacheDir}/artifacts`;
    }

    get enabled (): boolean {
        return this.trackedFilesHash !== null;
    }

    /** Called by Parser once all jobs (and their producers) are known. */
    bindJobs (jobs: ReadonlyArray<Job>) {
        this.jobs = jobs;
    }

    private warn (message: string) {
        if (this.warned) return;
        this.warned = true;
        this.writeStreams.stderr(message);
    }

    private entryPath (jobName: string, fingerprint: string): string {
        return `${this.jobsCacheDir}/${Utils.safeDockerString(jobName)}/${fingerprint}.json`;
    }

    /**
     * Returns the job's fingerprint, or null when caching is unavailable
     * (unhashable worktree, unresolvable dependency). Memoized per job name.
     */
    fingerprint (job: Job): string | null {
        if (!this.enabled) return null;
        try {
            return this.fingerprintCached(job, new Set());
        } catch (e: any) {
            this.warn(chalk`{blueBright ${job.name}} cannot be memoized: {yellow ${e.message ?? e}}\n`);
            return null;
        }
    }

    private fingerprintCached (job: Job, inProgress: Set<string>): string {
        const memoized = this.memo.get(job.name);
        if (memoized !== undefined) return memoized;
        if (inProgress.has(job.name)) throw new Error(`circular dependency while fingerprinting ${job.name}`);
        inProgress.add(job.name);
        const fingerprint = sha256(JSON.stringify(canonical(this.fingerprintDoc(job, inProgress))));
        inProgress.delete(job.name);
        this.memo.set(job.name, fingerprint);
        return fingerprint;
    }

    private fingerprintDoc (job: Job, inProgress: Set<string>): any {
        const argv = this.argv;
        const expanded = Utils.expandVariables(job.rawVariables);
        return {
            v: FINGERPRINT_VERSION,
            job: {name: job.name, baseName: job.baseName, stage: job.stage},
            scripts: {
                before: job.beforeScripts,
                script: job.scripts ?? null,
                after: job.afterScripts,
            },
            image: {
                name: job.imageName(expanded),
                entrypoint: job.imageEntrypoint,
                user: job.imageUser(expanded),
                platform: job.imagePlatform(expanded),
            },
            services: job.services.map((service) => ({
                name: service.name,
                alias: service.alias,
                entrypoint: service.entrypoint,
                command: service.command,
                variables: filterVolatile(service.variables),
            })),
            variables: filterVolatile(expanded),
            options: {
                privileged: argv.privileged,
                ulimit: argv.ulimit,
                umask: argv.umask,
                shellIsolation: argv.shellIsolation,
                network: [...argv.network].sort(),
                containerExecutable: argv.containerExecutable,
                gpus: argv.gpus,
                userns: argv.userns,
                shmSize: argv.shmSize,
                device: [...argv.device].sort(),
                extraHost: [...argv.extraHost].sort(),
                volume: [...argv.volume].sort(),
                caFile: argv.caFile,
                containerMacAddress: argv.containerMacAddress,
                containerEmulate: argv.containerEmulate,
            },
            // The GitLab `cache:` keyword feeds external content into the job,
            // so its configuration takes part in invalidation.
            cache: job.cache.map((c) => ({policy: c.policy, when: c.when, key: c.key, paths: [...c.paths].sort()})),
            artifacts: job.artifacts == null ? null : {
                paths: [...job.artifacts.paths ?? []].sort(),
                exclude: [...job.artifacts.exclude ?? []].sort(),
                reports: {dotenv: job.artifacts.reports?.dotenv ?? null},
            },
            artifactsToSource: job.artifactsToSource,
            inputs: {trackedFiles: this.trackedFilesHash},
            produces: (job.producers ?? []).map((producer) => ({name: producer.name, dotenv: producer.dotenv})),
            // Chained producer fingerprints: an upstream change transitively
            // invalidates every consumer. Tradeoff: producer artifacts are
            // identified by the producer's fingerprint, not by artifact bytes —
            // non-script producer inputs (e.g. an image update that changes tool
            // output) invalidate consumers only via the producer's own fingerprint.
            dependencies: this.dependencyFingerprints(job, inProgress),
        };
    }

    /** Fingerprint of every producer, including explicit artifact-less deps. */
    private dependencyFingerprints (job: Job, inProgress: Set<string>): string[] {
        const names = new Set<string>();
        for (const producer of job.producers ?? []) {
            names.add(producer.name);
        }

        // `dependencies:` targets and `needs:` targets whose producer exports no
        // artifacts are not returned by Producers.init, but they still order the
        // job and may matter for cache coherence — chain them conservatively.
        const explicit = new Set<string>();
        for (const need of job.needs ?? []) {
            if (need.project || need.pipeline) continue;
            explicit.add(need.job);
        }
        for (const dependency of job.dependencies ?? []) {
            explicit.add(dependency);
        }
        const coveredByProducers = new Set<string>();
        for (const name of names) {
            coveredByProducers.add(name);
            const found = this.jobs.find((j) => j.name === name);
            if (found) coveredByProducers.add(found.baseName);
        }
        for (const dependency of explicit) {
            if (!coveredByProducers.has(dependency)) names.add(dependency);
        }

        const fingerprints = new Set<string>();
        for (const name of names) {
            for (const target of this.jobs) {
                if (target.name !== name && target.baseName !== name) continue;
                fingerprints.add(this.fingerprintCached(target, inProgress));
            }
        }
        return [...fingerprints].sort();
    }

    /**
     * Returns the cached entry for the job, or null on miss. Corrupt entries
     * and missing artifact directories degrade to a miss with a warning.
     */
    lookup (job: Job): JobCacheEntry | null {
        const fingerprint = this.fingerprint(job);
        if (fingerprint === null) return null;

        let entry: JobCacheEntry;
        try {
            entry = fs.readJsonSync(this.entryPath(job.name, fingerprint));
        } catch {
            return null; // Absent or unreadable — an ordinary miss.
        }
        if (entry?.status !== "success" || entry.fingerprint !== fingerprint) {
            this.warn(chalk`{blueBright ${job.name}} has a corrupt memoization entry, ignoring it\n`);
            return null;
        }
        if ((entry.artifacts?.length ?? 0) > 0 && !fs.pathExistsSync(`${this.artifactsCacheDir}/${fingerprint}`)) {
            this.warn(chalk`{blueBright ${job.name}} has memoization artifacts missing on disk, ignoring the entry\n`);
            return null;
        }
        return entry;
    }

    /** Copies the cached artifacts to where a live run would have exported them. */
    async restoreArtifacts (job: Job, entry: JobCacheEntry): Promise<void> {
        const destination = `${this.argv.cwd}/${this.argv.stateDir}/artifacts/${job.safeJobName}`;
        await fs.remove(destination);
        if (entry.artifacts.length === 0) return;
        await fs.copy(`${this.artifactsCacheDir}/${entry.fingerprint}`, destination);
    }

    /**
     * Persists the job's result and artifacts. Best-effort: any failure logs a
     * warning and never fails the job. Callers must only store successful jobs.
     */
    async store (job: Job): Promise<void> {
        try {
            const fingerprint = this.fingerprint(job);
            if (fingerprint === null) return;

            const artifactsDir = `${this.argv.cwd}/${this.argv.stateDir}/artifacts/${job.safeJobName}`;
            const durationHrtime = job.durationHrtime;
            const artifactFiles = await JobCache.listFiles(artifactsDir);
            const entry: JobCacheEntry = {
                fingerprint,
                status: "success",
                finishedAt: new Date().toISOString(),
                durationMs: durationHrtime ? Math.round(durationHrtime[0] * 1000 + durationHrtime[1] / 1e6) : null,
                coveragePercent: job.coveragePercent,
                afterScriptsExitCode: job.afterScriptsExitCode,
                artifacts: artifactFiles.map((file) => path.relative(artifactsDir, file)).sort(),
                dotenv: await JobCache.readDotenvReports(artifactFiles),
                services: job.services.map((service) => service.name),
                dependencies: this.dependencyFingerprints(job, new Set()),
            };

            if (entry.artifacts.length > 0) {
                const destination = `${this.artifactsCacheDir}/${fingerprint}`;
                const temporary = `${this.artifactsCacheDir}/.tmp-${fingerprint}-${process.pid}`;
                await fs.rm(temporary, {recursive: true, force: true});
                await fs.copy(artifactsDir, temporary);
                await fs.rm(destination, {recursive: true, force: true});
                await fs.move(temporary, destination);
            }

            const entryPath = this.entryPath(job.name, fingerprint);
            await withFileLock(`${this.jobsCacheDir}/${Utils.safeDockerString(job.name)}.lock`, async () => {
                const temporaryPath = `${entryPath}.tmp.${process.pid}`;
                await fs.outputJson(temporaryPath, entry, {spaces: 2});
                await fs.move(temporaryPath, entryPath, {overwrite: true});
            });
        } catch (e: any) {
            this.warn(chalk`{blueBright ${job.name}} could not be written to the memoization cache: {yellow ${e.message ?? e}}\n`);
        }
    }

    /** Lists files under `dir` as absolute paths; empty when the dir is absent. */
    private static async listFiles (dir: string): Promise<string[]> {
        const files: string[] = [];
        const walk = async (current: string): Promise<void> => {
            let entries: fs.Dirent[];
            try {
                entries = await fs.readdir(current, {withFileTypes: true});
            } catch {
                return;
            }
            for (const entry of entries) {
                const entryPath = `${current}/${entry.name}`;
                if (entry.isDirectory()) await walk(entryPath);
                else if (entry.isFile()) files.push(entryPath);
            }
        };
        await walk(dir);
        return files.sort();
    }

    private static async readDotenvReports (artifactFiles: string[]): Promise<{[key: string]: string}> {
        const variables: {[key: string]: string} = {};
        for (const file of artifactFiles) {
            if (!file.includes("/.gitlab-ci-reports/dotenv/")) continue;
            const parsed = dotenv.parse(await fs.readFile(file));
            Object.assign(variables, parsed);
        }
        return variables;
    }
}
