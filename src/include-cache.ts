import * as crypto from "node:crypto";
import fs from "fs-extra";
import axios from "axios";
import {Utils} from "./utils.js";

export interface CachedInclude {
    url: string;
    fetchedAt: string;
    etag: string | null;
    content: string;
}

export interface FetchedInclude {
    notModified: boolean;
    content: string;
    etag: string | null;
}

/**
 * Content cache for remote (`include:remote` / `include:template`) includes.
 *
 * Policy lives here so `ParserIncludes.downloadIncludeRemote` stays a thin
 * consumer:
 * - In `--deterministic` mode a cached entry is served without any network
 *   access — includes are pinned to first-fetch for the lifetime of the state
 *   dir, which is the point of the mode.
 * - Outside it, the cache only accelerates the refetch path (`--fetch-includes`)
 *   with conditional revalidation (`If-None-Match` → 304 reuses the body); when
 *   no refetch would happen today, none happens here either.
 */
export class IncludeCache {

    private static entryPath (cwd: string, stateDir: string, url: string): string {
        const hash = crypto.createHash("sha256").update(url).digest("hex");
        return `${cwd}/${stateDir}/include-cache/${hash}.json`;
    }

    static async read (cwd: string, stateDir: string, url: string): Promise<CachedInclude | null> {
        try {
            const entry = await fs.readJson(this.entryPath(cwd, stateDir, url));
            if (entry?.url !== url || typeof entry?.content !== "string") return null;
            return entry;
        } catch {
            // Absent or corrupt — an ordinary cache miss.
            return null;
        }
    }

    static async write (cwd: string, stateDir: string, url: string, content: string, etag: string | null): Promise<void> {
        const entry: CachedInclude = {url, fetchedAt: new Date().toISOString(), etag, content};
        await fs.outputJson(this.entryPath(cwd, stateDir, url), entry);
    }

    /**
     * GETs the url with the same proxy/User-Agent handling as the original
     * fetch. When `etag` is given the request is conditional; a 304 answer is
     * reported as `notModified` and carries no body.
     */
    static async fetch (url: string, etag: string | null = null): Promise<FetchedInclude> {
        const res = await axios.get(url, {
            headers: {
                "User-Agent": "gitlab-ci-local",
                ...(etag ? {"If-None-Match": etag} : {}),
            },
            validateStatus: (status) => (status >= 200 && status < 300) || status === 304,
            ...Utils.getAxiosProxyConfig(),
        });
        const responseEtag = res.headers?.etag ?? null;
        if (res.status === 304) return {notModified: true, content: "", etag: responseEtag};
        // Include files are YAML/text; keep non-string bodies as-is like the
        // pre-cache fetch did.
        const content = typeof res.data === "string" ? res.data : res.data.toString();
        return {notModified: false, content, etag: responseEtag};
    }
}
