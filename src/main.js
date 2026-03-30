import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as cache from '@actions/cache';
import fs from 'fs';
import os from 'os';

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
        const deleteOldCaches = core.getInput('delete-old-caches');
        const token = core.getInput('token');
        const saveAlways = core.getInput('save-always') === 'true';

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
                const flattenPaths = (obj, prefix = '') => {
                    const result = [];
                    for (const [key, value] of Object.entries(obj)) {
                        const newKey = prefix ? `${prefix}-${key}` : key;
                        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
                            result.push(...flattenPaths(value, newKey));
                        } else {
                            result.push(`${newKey}=${value}`);
                        }
                    }
                    return result;
                };
                matrixKey = flattenPaths(matrix).join(';') + ';';
            } catch (e) {
                core.debug(`Failed to parse matrix JSON: ${e}`);
            }
        }

        let restoreKey = `${cacheName};os=${runnerOS};${matrixKey}`;
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
        core.saveState('delete-old-caches', deleteOldCaches);
        core.saveState('token', token);
        core.saveState('save-always', saveAlways.toString());
        core.saveState('repository', repository);
        core.saveState('ref', ref);
        core.saveState('default-branch', defaultBranch);

        // Restore cache
        let cacheHit = '';
        if (cachePaths.length > 0) {
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
                core.warning(`Failed to restore cache: ${error.message}`);
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
                    core.warning(`Failed to update registries: ${error.message}`);
                }
            } else {
                core.info('Registries directory does not exist or is empty. Skipping registry update');
            }
        }

    } catch (error) {
        core.setFailed(error.message);
    }
}

run();
