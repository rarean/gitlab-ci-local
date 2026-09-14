import fs from "fs-extra";
import * as os from "node:os";
import * as path from "node:path";

// Temp dirs created for --isolated runs this process still owns.
const isolatedStateDirs = new Set<string>();

/**
 * Creates the fresh state dir used by an `--isolated` invocation. With no
 * user `--state-dir` it lives under the OS temp dir; when one is given it is
 * created next to it, so both end up on the same volume as the project.
 */
export async function createIsolatedStateDir (cwd: string, userStateDir: string | null): Promise<string> {
    const prefix = userStateDir ?
        `${cwd}/${userStateDir.replace(/\/$/, "")}-isolated-` :
        `${path.join(os.tmpdir(), "gitlab-ci-local-")}`;
    await fs.mkdirp(path.dirname(prefix));
    const dir = await fs.mkdtemp(prefix);
    isolatedStateDirs.add(dir);
    return dir;
}

/**
 * Removes every isolated state dir owned by this process. Idempotent and safe
 * to call from both the normal exit path and signal handlers — concurrent
 * callers race on an already-cleared set.
 */
export async function cleanupIsolatedStateDirs (): Promise<void> {
    const dirs = [...isolatedStateDirs];
    isolatedStateDirs.clear();
    await Promise.all(dirs.map((dir) => fs.rm(dir, {recursive: true, force: true})));
}
