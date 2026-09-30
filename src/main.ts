import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as cache from '@actions/cache';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, execSync } from 'child_process';
import type { Readable } from 'stream';
import { Storage as GoogleCloudStorage } from '@google-cloud/storage';
import { parseDeleteOldCachesMode } from './delete-old-caches.js';

type GcpCompression = 'zstd' | 'gzip';

interface StreamGcsRestoreOptions {
    inStream: Readable;
    useZstd: boolean;
    cwd: string;
    // Filled with tar's verbose listing of what it extracts, to be read with
    // extractedEntries if the restore fails.
    tarOutput: Buffer[];
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

// Keeps the listing tar prints while extracting (`-v`), as raw chunks so that
// a restore of many files costs only the bytes of the listing, and passes
// tar's own diagnostics through to the log as they arrive.
function recordTarOutput(stream: Readable, chunks: Buffer[]): void {
    let pending = '';
    stream.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        pending += chunk.toString();
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) {
            if (line.startsWith('tar: ') || line.startsWith('bsdtar: ')) {
                process.stderr.write(`${line}\n`);
            }
        }
    });
}

// The absolute path of every archive member tar reported extracting, in
// extraction order. GNU tar lists a member as its name, bsdtar as "x name".
function extractedEntries(chunks: Buffer[], cwd: string): string[] {
    const entries: string[] = [];
    for (const line of Buffer.concat(chunks).toString().split('\n')) {
        if (line === '' || line.startsWith('tar: ') || line.startsWith('bsdtar: ')) continue;
        entries.push(path.resolve(cwd, line.startsWith('x ') ? line.slice(2) : line));
    }
    return entries;
}

// Only used by the Google Cloud Storage pathway: streams the archive through the
// decompressor and tar straight into the depot.
function streamGcsRestore({ inStream, useZstd, cwd, tarOutput }: StreamGcsRestoreOptions): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const decompressCmd = useZstd ? 'zstd' : 'gzip';
        const decompressArgs = useZstd ? ['-d', '-c'] : ['-d', '-c'];
        const decompressProc = spawn(decompressCmd, decompressArgs, { stdio: ['pipe', 'pipe', 'inherit'] });

        const tarProc = spawn('tar', ['-xvf', '-'], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
        recordTarOutput(tarProc.stdout, tarOutput);
        recordTarOutput(tarProc.stderr, tarOutput);

        let errorOccurred = false;
        const onError = (err: Error): void => {
            if (!errorOccurred) {
                errorOccurred = true;
                inStream.destroy();
                decompressProc.kill();
                tarProc.kill();
                reject(err);
            }
        };

        inStream.on('error', onError);
        decompressProc.on('error', onError);
        tarProc.on('error', onError);

        decompressProc.on('close', (code) => {
            if (code !== 0 && !errorOccurred) {
                onError(new Error(`${decompressCmd} process failed with exit code ${code}`));
            }
        });

        tarProc.on('close', (code) => {
            if (code === 0) {
                if (!errorOccurred) resolve();
            } else if (!errorOccurred) {
                onError(new Error(`tar extraction failed with exit code ${code}`));
            }
        });

        inStream.pipe(decompressProc.stdin);
        decompressProc.stdout.pipe(tarProc.stdin);
    });
}

// Only used by the Google Cloud Storage pathway: removes everything a failed
// streamGcsRestore wrote into the depot, so later steps do not pick up
// half-extracted files. tar lists a directory before its contents, so walking
// the list backwards removes files first; a directory is only removed once it
// is empty, which leaves alone anything that was in it before the restore, and
// the cache paths that existed beforehand are kept even when empty.
function discardPartialGcsRestore(extracted: string[], keep: Set<string>): void {
    let removed = 0;
    for (let i = extracted.length - 1; i >= 0; i--) {
        const p = extracted[i];
        try {
            if (fs.lstatSync(p).isDirectory()) {
                if (!keep.has(p) && fs.readdirSync(p).length === 0) fs.rmdirSync(p);
            } else {
                fs.unlinkSync(p);
                removed++;
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                core.warning(`Failed to remove partially restored ${p}: ${getErrorMessage(error)}`);
            }
        }
    }
    core.info(`Removed ${removed} partially restored files`);
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
                        const cwd = process.platform === 'win32' ? depotPath.split(':')[0] + ':/' : '/';
                        // tar writes straight into the depot as the archive streams in. Thus, if
                        // the stream breaks part-way, the depot is left holding whatever had
                        // arrived, including files cut short mid-write. Therefore, we keep
                        // tar's listing of what it extracts, so that it can be removed on failure.
                        const tarOutput: Buffer[] = [];
                        const preexistingPaths = new Set(cachePaths.filter(p => !p.startsWith('!') && fs.existsSync(p)));
                        try {
                            const inStream = fileToStream.createReadStream();
                            await streamGcsRestore({ inStream, useZstd, cwd, tarOutput });
                        } catch (error) {
                            discardPartialGcsRestore(extractedEntries(tarOutput, cwd), preexistingPaths);
                            // Do not let the post step save a potentially-broken depot
                            core.saveState('restore-failed-partway', 'true');
                            throw error;
                        }
                        cacheHit = restoredKey === key ? 'true' : '';
                        core.info(`Cache restored from GCS key: ${restoredKey}`);
                        core.saveState('cache-matched-key', restoredKey);
                    } else {
                        core.info('No cache found in GCS');
                    }
                } catch (error) {
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
                    core.warning(`Failed to restore cache: ${getErrorMessage(error)}`);
                }
            }
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
