import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as cache from '@actions/cache';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, execSync } from 'child_process';
import type { ChildProcess } from 'child_process';
import type { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { Storage as GoogleCloudStorage } from '@google-cloud/storage';
import { parseDeleteOldCachesMode } from './delete-old-caches.js';

type GcpCompression = 'zstd' | 'gzip';

interface StreamGcsRestoreOptions {
    inStream: Readable;
    useZstd: boolean;
    cwd: string;
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function isZstdAvailable(): boolean {
    try {
        execSync('zstd --version', { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

function parseGcpCompressionInput(inputVal: string): GcpCompression {
    if (!inputVal || inputVal.trim() === '') {
        return 'zstd';
    }
    const val = inputVal.trim().toLowerCase();
    if (val === 'zstd' || val === 'gzip') {
        return val;
    }
    throw new Error(`Invalid compression value for input 'gcp-compression': '${inputVal}'. Expected 'zstd' or 'gzip'.`);
}

// Resolves once the child process has exited with status 0.
function exited(proc: ChildProcess, name: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        proc.on('error', reject);
        proc.on('close', (code, signal) => {
            if (code === 0) resolve();
            else reject(new Error(`${name} failed with ${signal ? `signal ${signal}` : `exit code ${code}`}`));
        });
    });
}

// Streams a Google Cloud Storage archive through the decompressor and tar into cwd.
// Settles only once the download and both processes have all finished, in whatever
// order: tar exits 0 on an archive cut at a member boundary, so its exit alone does
// not show that the whole archive arrived.
async function streamGcsRestore({ inStream, useZstd, cwd }: StreamGcsRestoreOptions): Promise<void> {
    const decompressCmd = useZstd ? 'zstd' : 'gzip';
    const decompressProc = spawn(decompressCmd, ['-d', '-c'], { stdio: ['pipe', 'pipe', 'inherit'] });
    const tarProc = spawn('tar', ['-xf', '-'], { cwd, stdio: ['pipe', 'inherit', 'inherit'] });

    let firstError: unknown;
    const fail = (error: unknown): void => {
        if (firstError === undefined) {
            firstError = error;
            inStream.destroy();
            decompressProc.kill();
            tarProc.kill();
        }
    };
    await Promise.all([
        pipeline(inStream, decompressProc.stdin),
        pipeline(decompressProc.stdout, tarProc.stdin),
        exited(decompressProc, decompressCmd),
        exited(tarProc, 'tar extraction'),
    ].map(p => p.catch(fail)));
    if (firstError !== undefined) throw firstError;
}

function lstatOrUndefined(p: string): fs.Stats | undefined {
    try {
        return fs.lstatSync(p);
    } catch {
        return undefined;
    }
}

// Renames src to dst, copying instead when they are on different filesystems
// (e.g. a cache path that is a symlink to another disk).
function renameOrCopy(src: string, dst: string): void {
    try {
        fs.renameSync(src, dst);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
        fs.cpSync(src, dst, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
        fs.rmSync(src, { recursive: true, force: true });
    }
}

// Moves what a restore unpacked under src to dst, merging into directories that
// already exist there and replacing files that do.
function moveInto(src: string, dst: string): void {
    const dstStat = lstatOrUndefined(dst);
    if (dstStat === undefined) {
        renameOrCopy(src, dst);
    } else if (dstStat.isDirectory() && fs.lstatSync(src).isDirectory()) {
        for (const name of fs.readdirSync(src)) {
            moveInto(path.join(src, name), path.join(dst, name));
        }
        fs.rmdirSync(src);
    } else {
        fs.rmSync(dst, { recursive: true, force: true });
        renameOrCopy(src, dst);
    }
}

// A cache path that is a symlink to a directory (e.g. artifacts kept on a larger
// disk) is restored into its target rather than replaced.
function followDirSymlink(p: string): string {
    if (lstatOrUndefined(p)?.isSymbolicLink() && fs.statSync(p, { throwIfNoEntry: false })?.isDirectory()) {
        return fs.realpathSync(p);
    }
    return p;
}

const STAGING_PREFIX = '.restore-';
const STALE_STAGING_MS = 6 * 60 * 60 * 1000;

// Removes staging directories left behind by restores that were killed before they
// could clean up (e.g. a cancelled job). Only old ones: several runners can share a
// depot, and a recent one may belong to a restore still in progress. A staging
// directory's own mtime only changes when tar creates its first entry.
function removeStaleStagingDirs(depotPath: string): void {
    let names: string[];
    try {
        names = fs.readdirSync(depotPath);
    } catch {
        return;
    }
    const cutoff = Date.now() - STALE_STAGING_MS;
    for (const name of names) {
        if (!name.startsWith(STAGING_PREFIX)) continue;
        const dir = path.join(depotPath, name);
        try {
            const stat = fs.lstatSync(dir);
            if (!stat.isDirectory() || stat.mtimeMs > cutoff) continue;
            fs.rmSync(dir, { recursive: true, force: true });
            core.info(`Removed stale restore staging directory ${dir}`);
        } catch (error) {
            core.debug(`Could not remove stale restore staging directory ${dir}: ${getErrorMessage(error)}`);
        }
    }
}

async function run() {
    try {
        // Get inputs
        const cacheName = core.getInput('cache-name');
        const includeMatrix = core.getInput('include-matrix') === 'true';
        const depot = core.getInput('depot');
        const cacheArtifacts = core.getInput('cache-artifacts') === 'true';
        const cachePackages = core.getInput('cache-packages') === 'true';
        const cacheRegistries = core.getInput('cache-registries') === 'true';
        const cacheCompiled = core.getInput('cache-compiled') === 'true';
        const cacheScratchspaces = core.getInput('cache-scratchspaces') === 'true';
        const cacheLogs = core.getInput('cache-logs') === 'true';
        const cacheObjcache = core.getInput('cache-objcache') === 'true';
        const deleteOldCachesMode = parseDeleteOldCachesMode(core.getInput('delete-old-caches'));
        const token = core.getInput('token');
        const saveAlways = core.getInput('save-always') === 'true';
        const gcpBucket = core.getInput('gcp-bucket');
        const gcpCompression = parseGcpCompressionInput(core.getInput('gcp-compression'));
        const keyPrefix = core.getInput('key-prefix');

        if (gcpBucket && gcpCompression === 'zstd' && !isZstdAvailable()) {
            throw new Error("zstd is not available on this runner. Please install zstd or set `gcp-compression: 'gzip'` to use gzip compression.");
        }

        // Determine depot path
        let depotPath;
        if (depot) {
            depotPath = depot;
        } else if (process.env.JULIA_DEPOT_PATH) {
            const delimiter = process.platform === 'win32' ? ';' : ':';
            depotPath = process.env.JULIA_DEPOT_PATH.split(delimiter)[0];
        } else {
            depotPath = '~/.julia';
        }

        // Expand ~ to home directory
        if (depotPath.startsWith('~')) {
            depotPath = depotPath.replace('~', os.homedir());
        }

        // On Windows, replace backslashes with forward slashes
        if (process.platform === 'win32') {
            depotPath = depotPath.replace(/\\/g, '/');
        }

        core.info(`Using depot path: ${depotPath}`);
        core.setOutput('depot', depotPath);

        // Build cache paths
        const cachePaths = [];
        const artifactsPath = `${depotPath}/artifacts`;
        const packagesPath = `${depotPath}/packages`;
        const registriesPath = `${depotPath}/registries`;
        const compiledPath = `${depotPath}/compiled`;
        const scratchspacesPath = `${depotPath}/scratchspaces`;
        const logsPath = `${depotPath}/logs`;
        const objcachePath = `${depotPath}/cache`;

        if (cacheArtifacts) cachePaths.push(artifactsPath);
        if (cachePackages) cachePaths.push(packagesPath);
        if (cacheRegistries) {
            if (fs.existsSync(registriesPath)) {
                core.warning('Julia depot registries already exist. Skipping restoring of cached registries to avoid potential merge conflicts when updating. Please ensure that `julia-actions/cache` precedes any workflow steps which add registries.');
            } else {
                cachePaths.push(registriesPath);
            }
        }
        if (cacheCompiled) cachePaths.push(compiledPath);
        if (cacheScratchspaces) cachePaths.push(scratchspacesPath);
        if (cacheLogs) cachePaths.push(logsPath);
        if (cacheObjcache) cachePaths.push(objcachePath);

        // Exclude stale pidfiles – they are auto-cleaned but should not be cached.
        // Each pattern targets only the specific depth where Julia/Pkg places them.
        // Both .pid and .pidfile extensions are matched for forward-compatibility.
        // Note: @actions/glob does not support brace expansion, so each
        // extension needs its own entry.
        cachePaths.push(`!${depotPath}/artifacts/*.pid`);                     // Pkg artifact locks
        cachePaths.push(`!${depotPath}/artifacts/*.pidfile`);
        cachePaths.push(`!${depotPath}/compiled/v*.*/*.pid`);                 // Julia base precompile locks (UUID-less packages)
        cachePaths.push(`!${depotPath}/compiled/v*.*/*.pidfile`);
        cachePaths.push(`!${depotPath}/compiled/v*.*/*/*.pid`);               // Julia base precompile locks (registry packages)
        cachePaths.push(`!${depotPath}/compiled/v*.*/*/*.pidfile`);
        cachePaths.push(`!${depotPath}/packages/*/*.pid`);                    // Pkg package source locks
        cachePaths.push(`!${depotPath}/packages/*/*.pidfile`);
        cachePaths.push(`!${depotPath}/registries/*/.pid`);                   // Pkg registry locks
        cachePaths.push(`!${depotPath}/registries/*/.pidfile`);
        cachePaths.push(`!${depotPath}/logs/*.pid`);                          // Pkg usage file locks
        cachePaths.push(`!${depotPath}/logs/*.pidfile`);
        // LMDB reader-lock tables are per-machine state and recreated on open.
        cachePaths.push(`!${depotPath}/cache/v*.*/*/lock.mdb`);              // Julia objcache LMDB lock files

        core.setOutput('cache-paths', cachePaths.join('\n'));

        // Generate cache keys
        const runnerOS = core.getInput('_runner-os') || process.env.RUNNER_OS;
        const matrixJson = core.getInput('_matrix-json') || 'null';
        const runId = core.getInput('_github-run-id') || process.env.GITHUB_RUN_ID;
        const runAttempt = core.getInput('_github-run-attempt') || process.env.GITHUB_RUN_ATTEMPT;

        let matrixKey = '';
        // `matrix_key` joins all of matrix keys/values (including nested objects) to ensure that concurrent runs each use a unique cache key.
        // When `matrix` isn't set for the job then `MATRIX_JSON=null`.
        if (includeMatrix && matrixJson !== 'null') {
            try {
                const matrix = JSON.parse(matrixJson);
                const flattenPaths = (obj: Record<string, unknown>, prefix = ''): string[] => {
                    const result: string[] = [];
                    for (const [key, value] of Object.entries(obj)) {
                        const newKey = prefix ? `${prefix}-${key}` : key;
                        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
                            result.push(...flattenPaths(value as Record<string, unknown>, newKey));
                        } else {
                            result.push(`${newKey}=${value}`);
                        }
                    }
                    return result;
                };
                matrixKey = flattenPaths(matrix as Record<string, unknown>).join(';') + ';';
            } catch (e) {
                core.debug(`Failed to parse matrix JSON: ${e}`);
            }
        }

        let restoreKey = `${keyPrefix}${cacheName};os=${runnerOS};${matrixKey}`;
        // URL encode restricted characters
        restoreKey = restoreKey.replace(/,/g, '%2C');

        const key = `${restoreKey}run_id=${runId};run_attempt=${runAttempt}`;

        core.setOutput('restore-key', restoreKey);
        core.setOutput('cache-key', key);
        core.info(`Cache key: ${key}`);
        core.info(`Restore key: ${restoreKey}`);

        // Get GitHub context from inputs (for post action)
        const repository = core.getInput('_github-repository') || process.env.GITHUB_REPOSITORY;
        const ref = core.getInput('_github-ref') || process.env.GITHUB_REF;
        const defaultBranch = core.getInput('_github-event-repository-default-branch') || 'main';

        // Save state for post action
        core.saveState('cache-paths', JSON.stringify(cachePaths));
        core.saveState('cache-key', key);
        core.saveState('restore-key', restoreKey);
        core.saveState('depot', depotPath);
        core.saveState('cache-registries', cacheRegistries.toString());
        core.saveState('delete-old-caches', deleteOldCachesMode);
        core.saveState('token', token);
        core.saveState('save-always', saveAlways.toString());
        core.saveState('repository', repository);
        core.saveState('ref', ref);
        core.saveState('default-branch', defaultBranch);
        core.saveState('gcp-bucket', gcpBucket);
        core.saveState('gcp-compression', gcpCompression);

        // Restore cache
        let cacheHit = '';
        // Whether the depot is in a consistent state, i.e., the restore either completed or
        // did not start. Only then may the post step save it: if restoring failed, or if the job
        // gets cancelled while restoring, the depot may contain partially extracted files, and
        // saving it would poison the cache for later runs.
        let restoreComplete = true;
        if (cachePaths.length > 0) {
            if (gcpBucket) {
                try {
                    const storage = new GoogleCloudStorage();
                    const bucket = storage.bucket(gcpBucket);
                    const useZstd = gcpCompression === 'zstd';
                    const ext = useZstd ? '.tar.zst' : '.tar.gz';
                    let restoredKey = '';

                    const exactFile = bucket.file(`${key}${ext}`);
                    const [exactExists] = await exactFile.exists();

                    let fileToStream = null;
                    if (exactExists) {
                        fileToStream = exactFile;
                        restoredKey = key;
                    } else {
                        const restoreFile = bucket.file(`${restoreKey}${ext}`);
                        const [restoreExists] = await restoreFile.exists();
                        if (restoreExists) {
                            fileToStream = restoreFile;
                            restoredKey = restoreKey;
                        }
                    }

                    if (restoredKey && fileToStream) {
                        core.info(`Restoring cache from GCS key: ${restoredKey}`);
                        // The archive holds the cache paths relative to the filesystem root.
                        const root = process.platform === 'win32' ? depotPath.split(':')[0] + ':/' : '/';
                        // Unpack into a staging directory inside the depot (so it is on the same
                        // filesystem) and only move the cache paths into place once the whole archive
                        // has arrived, so a broken stream leaves the depot as it was. If moving fails
                        // part-way, restoreComplete stops the post step from saving the depot.
                        fs.mkdirSync(depotPath, { recursive: true });
                        removeStaleStagingDirs(depotPath);
                        const staging = fs.mkdtempSync(path.join(depotPath, STAGING_PREFIX));
                        let restoredPaths = 0;
                        try {
                            const inStream = fileToStream.createReadStream();
                            await streamGcsRestore({ inStream, useZstd, cwd: staging });
                            for (const p of cachePaths) {
                                if (p.startsWith('!')) continue;
                                const unpacked = path.join(staging, path.relative(root, p));
                                if (lstatOrUndefined(unpacked) === undefined) continue;
                                try {
                                    moveInto(unpacked, followDirSymlink(p));
                                } catch (error) {
                                    throw new Error(`moving the restored ${p} into place failed, so the depot may be partially restored: ${getErrorMessage(error)}`);
                                }
                                restoredPaths++;
                            }
                        } finally {
                            try {
                                fs.rmSync(staging, { recursive: true, force: true });
                            } catch (error) {
                                core.warning(`Could not remove restore staging directory ${staging}: ${getErrorMessage(error)}`);
                            }
                        }
                        if (restoredPaths > 0) {
                            cacheHit = restoredKey === key ? 'true' : '';
                            core.info(`Cache restored from GCS key: ${restoredKey}`);
                            core.saveState('cache-matched-key', restoredKey);
                        } else {
                            core.warning(`The cache at GCS key ${restoredKey} contains none of the cache paths, so nothing was restored. It may have been saved with a different depot path.`);
                        }
                    } else {
                        core.info('No cache found in GCS');
                    }
                } catch (error) {
                    restoreComplete = false;
                    core.warning(`Failed to restore cache from GCS: ${getErrorMessage(error)}`);
                }
            } else {
                try {
                    const restoredKey = await cache.restoreCache(cachePaths, key, [restoreKey]);
                    if (restoredKey) {
                        cacheHit = restoredKey === key ? 'true' : '';
                        core.info(`Cache restored from key: ${restoredKey}`);
                        core.saveState('cache-matched-key', restoredKey);
                    } else {
                        core.info('No cache found');
                    }
                } catch (error) {
                    restoreComplete = false;
                    core.warning(`Failed to restore cache: ${getErrorMessage(error)}`);
                }
            }
        }
        if (restoreComplete) {
            core.saveState('restore-complete', 'true');
        }

        core.setOutput('cache-hit', cacheHit);

        // Create depot directory if it doesn't exist.
        // We do this even if the cache wasn't restored, as this signals that this action ran
        // which other Julia actions to check, e.g.
        //  https://github.com/julia-actions/julia-buildpkg/pull/41
        if (!fs.existsSync(depotPath)) {
            fs.mkdirSync(depotPath, { recursive: true });
            core.info(`Created depot directory: ${depotPath}`);
        }

        // List depot directory sizes
        try {
            await exec.exec('bash', ['-c', `du -shc ${depotPath}/* 2>/dev/null || true`]);
        } catch (error) {
            // Ignore errors from du command
        }

        // issue https://github.com/julia-actions/cache/issues/110
        // Pkg may not run `Registry.update()` if a manifest exists, which may exist because of a
        // `Pkg.dev` call or because one is added to the repo. So be safe and update cached registries here.
        // Older (~v1.0) versions of julia that don't have `Pkg.Registry.update()` seem to always update registries in
        // Pkg operations. So this is only necessary for newer julia versions.
        if (cacheRegistries && fs.existsSync(registriesPath)) {
            const registriesContent = fs.readdirSync(registriesPath);
            if (registriesContent.length > 0) {
                core.info('Registries directory exists and is non-empty. Updating any registries');
                try {
                    await exec.exec('julia', ['-e', 'import Pkg; isdefined(Pkg, :Registry) && Pkg.Registry.update();']);
                } catch (error) {
                    core.warning(`Failed to update registries: ${getErrorMessage(error)}`);
                }
            } else {
                core.info('Registries directory does not exist or is empty. Skipping registry update');
            }
        }

    } catch (error) {
        core.setFailed(getErrorMessage(error));
    }
}

run();
