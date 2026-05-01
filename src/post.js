import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as cache from '@actions/cache';
import { Octokit } from '@octokit/rest';

async function runPkgGc() {
    const exitCode = await exec.exec('julia', [
        '-e',
        [
            'try',
            '    using Pkg',
            '    Pkg.gc()',
            'catch e',
            '    @error "An error occurred while managing existing caches" e',
            '    exit(17)',
            'end'
        ].join('\n')
    ], {
        ignoreReturnCode: true
    });

    return exitCode === 0;
}

function parseRepository(repository) {
    const [owner, repo] = repository.split('/');
    if (!owner || !repo) {
        throw new Error(`Invalid GitHub repository: ${repository}`);
    }

    return { owner, repo };
}

async function cleanupOldCaches({ repository, restoreKey, ref, token, allowFailure }) {
    let page = 1;
    const perPage = 100;
    const skipped = [];
    const deleted = [];
    const failed = [];

    try {
        const { owner, repo } = parseRepository(repository);
        const octokit = new Octokit({ auth: token });

        while (1 <= page && page <= 5) {
            const response = await octokit.rest.actions.getActionsCacheList({
                owner,
                repo,
                per_page: perPage,
                page,
                ref,
                key: restoreKey,
                sort: 'last_accessed_at',
                direction: 'desc'
            });

            const ids = response.data.actions_caches.map(cacheEntry => cacheEntry.id);

            // Avoid deleting the latest used cache entry. This is particularly important for
            // job failures where a new cache entry will not be saved after this.
            if (page === 1 && ids.length > 0) {
                skipped.push(ids.shift());
            }

            for (const id of ids) {
                try {
                    await octokit.rest.actions.deleteActionsCacheById({
                        owner,
                        repo,
                        cache_id: id
                    });
                    deleted.push(id);
                } catch (error) {
                    core.error(error);
                    failed.push(id);
                }
            }

            page = ids.length === perPage ? page + 1 : -1;
        }
    } catch (error) {
        core.error(`An error occurred while managing existing caches: ${error.message}`);
        return true;
    }

    if (skipped.length === 0 && deleted.length === 0 && failed.length === 0) {
        core.info(`No existing caches found on ref \`${ref}\` matching restore key \`${restoreKey}\``);
    } else {
        if (failed.length > 0) {
            core.info(`Failed to delete ${failed.length} existing caches on ref \`${ref}\` matching restore key \`${restoreKey}\``);
            failed.forEach(id => core.info(String(id)));
            core.info([
                'To delete caches you need to grant the following to the default `GITHUB_TOKEN` by adding',
                'this to your workflow:',
                '```',
                'permissions:',
                '  actions: write',
                '  contents: read',
                '```',
                "(Note this won't work for fork PRs but should once merged)",
                'Or provide a token with `repo` scope via the `token` input option.',
                'See https://docs.github.com/en/rest/actions/cache#delete-a-github-actions-cache-for-a-repository-using-a-cache-id'
            ].join('\n'));

            if (!allowFailure) {
                return false;
            }
        }

        if (deleted.length > 0) {
            core.info(`Deleted ${deleted.length} caches on ref \`${ref}\` matching restore key \`${restoreKey}\``);
            deleted.forEach(id => core.info(String(id)));
        }
    }

    return true;
}

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
            // Save the cache
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

        if (!cacheSaved) {
            core.info('No new cache was saved. Skipping old cache deletion.');
            return;
        }

        // Check if on default branch
        const isDefaultBranch = ref === `refs/heads/${defaultBranch}`;

        // Run Pkg.gc() and handle old caches
        if (deleteOldCaches !== 'false' && !isDefaultBranch) {
            const allowFailure = deleteOldCaches !== 'required';

            core.info(`Running Pkg.gc() and cleaning up old caches...`);
            try {
                const gcSucceeded = await runPkgGc();
                if (!gcSucceeded) {
                    return;
                }

                const cleanupSucceeded = await cleanupOldCaches({
                    repository,
                    restoreKey,
                    ref,
                    token,
                    allowFailure
                });

                if (!cleanupSucceeded) {
                    core.setFailed('Failed to delete old caches');
                    return;
                }
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
