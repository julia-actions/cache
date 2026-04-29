import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as cache from '@actions/cache';
import path from 'path';
import { fileURLToPath } from 'url';
import { Storage as GoogleCloudStorage } from '@google-cloud/storage';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function run() {
    try {
        // Get state from main action
        const cachePathsJson = core.getState('cache-paths');
        const cacheKey = core.getState('cache-key');
        const restoreKey = core.getState('restore-key');
        const deleteOldCaches = core.getState('delete-old-caches');
        const token = core.getState('token');
        const saveAlways = core.getState('save-always') === 'true';
        const cacheMatchedKey = core.getState('cache-matched-key');
        const repository = core.getState('repository');
        const ref = core.getState('ref');
        const defaultBranch = core.getState('default-branch');
        const gcpBucket = core.getState('gcp-bucket');

        if (!cachePathsJson || !cacheKey) {
            core.info('No cache state found. Skipping post action.');
            return;
        }

        const cachePaths = JSON.parse(cachePathsJson);

        // Determine if we should save the cache
        // - If saveAlways is true, save regardless of job status
        // - Otherwise, only save if the job succeeded
        // Get job status from input (evaluated at post-step time)
        const jobStatus = core.getInput('_job-status') || 'success';
        core.info(`Job status: ${jobStatus}, save-always: ${saveAlways}`);
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

        let cacheSaved = false;
        if (cachePaths.length > 0) {
            if (gcpBucket) {
                // Save the cache to Google Cloud Storage
                core.info(`Saving cache to GCS with key: ${cacheKey}`);
                try {
                    const tarPath = process.platform === 'win32'
                        ? `${process.env.RUNNER_TEMP || 'C:\\Windows\\Temp'}\\cache.tar.gz`
                        : `${process.env.RUNNER_TEMP || '/tmp'}/cache.tar.gz`;

                    const depotPath = core.getState('depot');
                    const cwd = process.platform === 'win32' && depotPath ? depotPath.split(':')[0] + ':/' : '/';
                    const excludePaths = cachePaths.filter(p => p.startsWith('!')).map(p => `--exclude=${path.relative(cwd, p.slice(1))}`);
                    const includePaths = cachePaths.filter(p => !p.startsWith('!')).map(p => path.relative(cwd, p));

                    await exec.exec('tar', ['-zcf', tarPath, ...excludePaths, ...includePaths], { cwd: cwd });

                    const storage = new GoogleCloudStorage();
                    const bucket = storage.bucket(gcpBucket);

                    // Upload exact match
                    await bucket.upload(tarPath, { destination: `${cacheKey}.tar.gz` });
                    // Upload restore key (latest fallback)
                    await bucket.upload(tarPath, { destination: `${restoreKey}.tar.gz` });

                    core.info('Cache saved to GCS successfully');
                    cacheSaved = true;
                } catch (error) {
                    core.warning(`Failed to save cache to GCS: ${error.message}`);
                }
            } else {
                // Save the cache to GitHub Actions
                core.info(`Saving cache with key: ${cacheKey}`);
                try {
                    await cache.saveCache(cachePaths, cacheKey);
                    core.info('Cache saved successfully');
                    cacheSaved = true;
                } catch (error) {
                    if (error.name === 'ReserveCacheError') {
                        core.info('Cache already exists, skipping save.');
                    } else {
                        core.warning(`Failed to save cache: ${error.message}`);
                    }
                }
            }
        }

        if (!cacheSaved) {
            core.info('No new cache was saved. Skipping old cache deletion.');
            return;
        }

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

    } catch (error) {
        core.warning(`Post action failed: ${error.message}`);
    }
}

run();
