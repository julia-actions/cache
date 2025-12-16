const core = require('@actions/core');
const exec = require('@actions/exec');
const cache = require('@actions/cache');
const path = require('path');

async function run() {
    try {
        // Get state from main action
        const cachePathsJson = core.getState('cache-paths');
        const cacheKey = core.getState('cache-key');
        const restoreKey = core.getState('restore-key');
        const depotPath = core.getState('depot');
        const cacheRegistries = core.getState('cache-registries') === 'true';
        const deleteOldCaches = core.getState('delete-old-caches');
        const token = core.getState('token');
        const saveAlways = core.getState('save-always') === 'true';
        const cacheMatchedKey = core.getState('cache-matched-key');
        const repository = core.getState('repository');
        const ref = core.getState('ref');
        const defaultBranch = core.getState('default-branch');

        if (!cachePathsJson || !cacheKey) {
            core.info('No cache state found. Skipping post action.');
            return;
        }

        const cachePaths = JSON.parse(cachePathsJson);

        // Check if on default branch
        const isDefaultBranch = ref === `refs/heads/${defaultBranch}`;

        // Run Pkg.gc() and handle old caches using the Julia script
        if (deleteOldCaches !== 'false' && !isDefaultBranch) {
            // GITHUB_ACTION_PATH points to the action root directory
            // __dirname points to dist/post/ when bundled, so go up two levels to get to root
            const actionPath = process.env.GITHUB_ACTION_PATH || path.resolve(__dirname, '..', '..');
            const handleCachesScript = path.join(actionPath, 'handle_caches.jl');
            const allowFailure = deleteOldCaches !== 'required' ? 'true' : 'false';

            core.info(`Running Pkg.gc() and cleaning up old caches...`);
            core.debug(`Action path: ${actionPath}`);
            core.debug(`Handle caches script: ${handleCachesScript}`);
            try {
                await exec.exec('julia', [
                    handleCachesScript,
                    'rm',
                    repository,
                    restoreKey,
                    ref,
                    allowFailure
                ], {
                    env: {
                        ...process.env,
                        GH_TOKEN: token
                    }
                });
            } catch (error) {
                if (deleteOldCaches === 'required') {
                    core.setFailed(`Failed to delete old caches: ${error.message}`);
                    return;
                } else {
                    core.warning(`Failed to delete old caches: ${error.message}`);
                }
            }
        }

        // Determine if we should save the cache
        // - If saveAlways is true, save regardless of job status
        // - Otherwise, only save if the job succeeded (default behavior)
        const jobStatus = process.env.JOB_STATUS || 'success';
        const shouldSave = saveAlways || jobStatus === 'success';

        if (!shouldSave) {
            core.info('Job failed and save-always is not enabled. Skipping cache save.');
            return;
        }

        // Don't save if we got an exact cache hit (cache is already up to date)
        if (cacheMatchedKey === cacheKey) {
            core.info('Cache hit occurred on the exact key, not saving cache.');
            return;
        }

        // Save the cache
        if (cachePaths.length > 0) {
            core.info(`Saving cache with key: ${cacheKey}`);
            try {
                await cache.saveCache(cachePaths, cacheKey);
                core.info('Cache saved successfully');
            } catch (error) {
                if (error.name === 'ReserveCacheError') {
                    core.info('Cache already exists, skipping save.');
                } else {
                    core.warning(`Failed to save cache: ${error.message}`);
                }
            }
        }

    } catch (error) {
        core.warning(`Post action failed: ${error.message}`);
    }
}

run();
