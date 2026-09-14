import * as yaml from "js-yaml";
import chalk from "chalk-template";
import path from "node:path";
import fs from "fs-extra";
import yargs from "yargs";
import {Commander} from "./commander.js";
import {Parser} from "./parser.js";
import * as state from "./state.js";
import prettyHrtime from "pretty-hrtime";
import {WriteStreams} from "./write-streams.js";
import {cleanupJobResources, Job} from "./job.js";
import {Utils} from "./utils.js";
import {Argv} from "./argv.js";
import {JobCache} from "./job-cache.js";
import {validateDeterminism} from "./determinism.js";
import {createIsolatedStateDir, cleanupIsolatedStateDirs} from "./isolated.js";
import {buildReport, registerReportWriter, writeReport} from "./report.js";
import assert from "node:assert";

const generateGitIgnore = (cwd: string, stateDir: string) => {
    const gitIgnoreFilePath = `${cwd}/${stateDir}/.gitignore`;
    const gitIgnoreContent = "*\n!.gitignore\n";
    if (!fs.existsSync(gitIgnoreFilePath)) {
        fs.outputFileSync(gitIgnoreFilePath, gitIgnoreContent);
    }
};

export async function handler (args: any, writeStreams: WriteStreams, jobs: Job[] = [], childPipelineDepth = 0) {
    assert(childPipelineDepth <= 2, "Parent and child pipelines have a maximum depth of two levels of child pipelines.");
    const argv = await Argv.build({...args, childPipelineDepth: childPipelineDepth}, writeStreams);

    // Isolated runs get a fresh temporary state dir, removed on every exit path.
    // Only the top-level invocation creates it — child pipelines inherit the
    // overridden stateDir through the argv map.
    if (argv.isolated && childPipelineDepth === 0) {
        const userStateDir: string | undefined = argv.map.get("stateDir");
        const tempDir = await createIsolatedStateDir(argv.cwd, userStateDir ?? null);
        argv.map.set("stateDir", path.relative(argv.cwd, tempDir));
    }

    const cwd = argv.cwd;
    const stateDir = argv.stateDir;
    const file = argv.file;
    // Only the top-level invocation writes the --report-json file, child pipelines must not overwrite it.
    const reportJsonPath = childPipelineDepth === 0 ? argv.reportJson : null;
    let parser: Parser;

    // A signal-cancelled run never reaches the normal report write; hand the
    // cancellation path (cleanupAndExit in src/index.ts) a writer that captures
    // whatever job states exist at that moment.
    const registerCancelReport = () => {
        if (reportJsonPath === null) return;
        registerReportWriter(() => writeReport(reportJsonPath, buildReport({pipelineIid: parser.pipelineIid, jobs, cwd, stateDir})));
    };

    try {
        if (argv.completion) {
            yargs(process.argv.slice(2)).scriptName("gitlab-ci-local").showCompletionScript();
            return [];
        }

        if (argv.clearCache) {
            await fs.rm(`${cwd}/${stateDir}/cache`, {recursive: true, force: true});
            writeStreams.stdout(chalk`{greenBright cleared} ${path.resolve(cwd, stateDir)}/cache\n`);
            return await cleanupJobResources(jobs);
        }

        assert(fs.existsSync(`${cwd}/${file}`), `${path.resolve(cwd)}/${file} could not be found`);

        if (argv.preview) {
            const pipelineIid = await state.getPipelineIid(cwd, stateDir);
            parser = await Parser.create(argv, writeStreams, pipelineIid, jobs, false);
            validateDeterminism(parser, writeStreams);
            const gitlabData = parser.gitlabData;
            for (const jobName of Object.keys(gitlabData)) {
                if (jobName === "stages") {
                    continue;
                }
                if (jobName.startsWith(".") || ["include", "after_script", "before_script", "default"].includes(jobName)) {
                    // Remove since these are redundant info which is already "extended" in the jobs
                    delete gitlabData[jobName];
                }
            }
            writeStreams.stdout(`---\n${yaml.dump(gitlabData, {lineWidth: 160})}`);
        } else if (argv.list || argv.listAll) {
            const pipelineIid = await state.getPipelineIid(cwd, stateDir);
            parser = await Parser.create(argv, writeStreams, pipelineIid, jobs);
            validateDeterminism(parser, writeStreams);
            Commander.runList(parser, writeStreams, argv.listAll);
        } else if (argv.validateDependencyChain) {
            const pipelineIid = await state.getPipelineIid(cwd, stateDir);
            parser = await Parser.create(argv, writeStreams, pipelineIid, jobs);
            validateDeterminism(parser, writeStreams);
            Commander.validateDependencyChain(parser);
            writeStreams.stdout(chalk`{green ✓ All job dependencies are valid}\n`);
        } else if (argv.listJson) {
            const pipelineIid = await state.getPipelineIid(cwd, stateDir);
            parser = await Parser.create(argv, writeStreams, pipelineIid, jobs);
            validateDeterminism(parser, writeStreams);
            Commander.runJson(parser, writeStreams);
        } else if (argv.listCsv || argv.listCsvAll) {
            const pipelineIid = await state.getPipelineIid(cwd, stateDir);
            parser = await Parser.create(argv, writeStreams, pipelineIid, jobs);
            validateDeterminism(parser, writeStreams);
            Commander.runCsv(parser, writeStreams, argv.listCsvAll);
        } else if (argv.job.length > 0) {
            assert(argv.stage === null, "You cannot use --stage when starting individual jobs");
            if (argv.registry) {
                await Utils.startDockerRegistry(argv);
            }
            generateGitIgnore(cwd, stateDir);
            const time = process.hrtime();
            let pipelineIid: number;
            if (argv.needs || argv.onlyNeeds) {
                pipelineIid = await state.incrementPipelineIid(cwd, stateDir);
            } else {
                pipelineIid = await state.getPipelineIid(cwd, stateDir);
            }
            const jobCache = argv.cache ? await JobCache.init(argv, writeStreams) : null;
            parser = await Parser.create(argv, writeStreams, pipelineIid, jobs, true, jobCache);
            validateDeterminism(parser, writeStreams);
            registerCancelReport();
            await Utils.rsyncTrackedFiles(cwd, stateDir, path.resolve(cwd, argv.ignoresFile), ".docker");
            await Commander.runJobs(argv, parser, writeStreams, reportJsonPath);
            registerReportWriter(null);
            if (argv.needs || argv.onlyNeeds) {
                writeStreams.stderr(chalk`{grey pipeline finished} in {grey ${prettyHrtime(process.hrtime(time))}}\n`);
            }
        } else if (argv.stage) {
            if (argv.registry) {
                await Utils.startDockerRegistry(argv);
            }
            generateGitIgnore(cwd, stateDir);
            const time = process.hrtime();
            const pipelineIid = await state.getPipelineIid(cwd, stateDir);
            const jobCache = argv.cache ? await JobCache.init(argv, writeStreams) : null;
            parser = await Parser.create(argv, writeStreams, pipelineIid, jobs, true, jobCache);
            validateDeterminism(parser, writeStreams);
            registerCancelReport();
            await Utils.rsyncTrackedFiles(cwd, stateDir, path.resolve(cwd, argv.ignoresFile), ".docker");
            await Commander.runJobsInStage(argv, parser, writeStreams, reportJsonPath);
            registerReportWriter(null);
            writeStreams.stderr(chalk`{grey pipeline finished} in {grey ${prettyHrtime(process.hrtime(time))}}\n`);
        } else {
            if (argv.registry) {
                await Utils.startDockerRegistry(argv);
            }
            generateGitIgnore(cwd, stateDir);
            const time = process.hrtime();
            const pipelineIid = await state.incrementPipelineIid(cwd, stateDir);
            const jobCache = argv.cache ? await JobCache.init(argv, writeStreams) : null;
            parser = await Parser.create(argv, writeStreams, pipelineIid, jobs, true, jobCache);
            validateDeterminism(parser, writeStreams);
            registerCancelReport();
            await Utils.rsyncTrackedFiles(cwd, stateDir, path.resolve(cwd, argv.ignoresFile), ".docker");
            await Commander.runPipeline(argv, parser, writeStreams, reportJsonPath);
            registerReportWriter(null);
            if (childPipelineDepth == 0) writeStreams.stderr(chalk`{grey pipeline finished} in {grey ${prettyHrtime(process.hrtime(time))}}\n`);
        }
        writeStreams.flush();

        if (argv.registry) {
            await Utils.stopDockerRegistry(argv.containerExecutable);
        }
        return await cleanupJobResources(jobs);
    } finally {
        // Child pipelines never own the temp dir — the top-level invocation
        // removes it once every job (including children) has settled.
        if (argv.isolated && childPipelineDepth === 0) {
            await cleanupIsolatedStateDirs();
        }
    }
}
