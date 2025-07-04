# julia-actions/cache Action

A shortcut action to cache Julia depot contents to reduce GitHub Actions running time.

## Usage

An example workflow that uses this action might look like this:

```yaml
name: CI

on: [push, pull_request]

# needed to allow julia-actions/cache to delete old caches that it has created
permissions:
  actions: write
  contents: read

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v4
    - uses: julia-actions/setup-julia@v2
    - uses: julia-actions/cache@v2
    - uses: julia-actions/julia-buildpkg@v1
    - uses: julia-actions/julia-runtest@v1
```

By default all depot directories called out below are cached.

### Requirements

- `jq`: This action uses [`jq`](https://github.com/jqlang/jq) to parse JSON. For GitHub-hosted runners, `jq` is installed by default. On self-hosted runners and custom containers, if `jq` is not already available, this action will automatically use [`dcarbone/install-jq-action`](https://github.com/dcarbone/install-jq-action) to install `jq` (Note: `dcarbone/install-jq-action` requires that `curl` is installed; this may not always be the case in custom containers and self-hosted runners).
- `bash`: This action requires `bash`. For GitHub-hosted runners `bash` is installed by default. Self-hosted runners will need to ensure that `bash` is installed and available on the `PATH`.

### Optional Inputs

- `cache-name` - The cache key prefix. Defaults to `julia-cache;workflow=${{ github.workflow }};job=${{ github.job }}`. The key body automatically includes the OS and, unless disabled with `include-matrix`, the matrix vars. Include any other parameters/details in this prefix to ensure one unique cache key per concurrent job type.
- `include-matrix` - Whether to include the matrix values when constructing the cache key. Defaults to `true`.
- `depot` - Path to a Julia [depot](https://pkgdocs.julialang.org/v1/glossary/) directory where cached data will be saved to and restored from. Defaults to the first depot in [`JULIA_DEPOT_PATH`](https://docs.julialang.org/en/v1/manual/environment-variables/#JULIA_DEPOT_PATH) if specified. Otherwise, defaults to `~/.julia`.
- `cache-artifacts` - Whether to cache the depot's `artifacts` directory. Defaults to `true`.
- `cache-packages` - Whether to cache the depot's `packages` directory. Defaults to `true`.
- `cache-registries` - Whether to cache the depot's `registries` directory. Defaults to `true`.
- `cache-compiled` - Whether to cache the depot's `compiled` directory. Defaults to `true`.
- `cache-scratchspaces` - Whether to cache the depot's `scratchspaces` directory. Defaults to `true`.
- `cache-logs` - Whether to cache the depot's `logs` directory. Defaults to `true`. Helps auto-`Pkg.gc()` keep the cache small.
- `delete-old-caches` - Whether to delete old caches for the given key. Defaults to `true`.
- `token` - A [GitHub PAT](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens). Defaults to `github.token`. Requires `repo` scope to enable the deletion of old caches.

### Outputs

- `cache-hit` - A boolean value to indicate an exact match was found for the primary key. Returns \"\" when the key is new. Forwarded from actions/cache.
- `cache-paths` - A list of paths (as a newline-separated string) that were cached.
- `cache-key` - The cache key that was used for this run.

## How It Works

This action is a wrapper around <https://github.com/actions/cache>.
In summary, this action stores the files in the aforementioned paths in one compressed file when running for the first time.
This cached file is then restored upon the second run, and afterwards resaved under a new key, and the previous cache deleted.
The benefit of caching is that downloading one big file is quicker than downloading many different files from many different locations
and precompiling them.

By default, this action removes caches that were previously made by jobs on the same branch with the same restore key.
GitHub automatically removes old caches after a certain period or when the repository cache allocation is full.
It is, however, more efficient to explicitly remove old caches to improve caching for less frequently run jobs.

For more information about GitHub caching generically, for example how to manually delete caches, see
[this GitHub documentation page](https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/caching-dependencies-to-speed-up-workflows#managing-caches).

### Cache keys

The cache key that the cache will be saved as is based on:
- The `cache-name` input
- All variables in the `matrix` (unless disabled via `include-matrix: 'false'`)
- The `runner.os` (may be in the matrix too, but included for safety)
- The run id
- The run attempt number

> [!NOTE]
> If there is job concurrency that is not fully defined by a matrix you should ensure that `cache-name` is 
> unique for each concurrent job, otherwise caching may not be effective.

### Cache Retention

This action automatically deletes old caches that match the first 4 fields of the above key:
- The `cache-name` input
- All variables in the `matrix` (unless disabled via `include-matrix: 'false'`)
- The `runner.os` (may be in the matrix too, but included for safety)

Which means your caches files will not grow needlessly. GitHub also deletes cache files after
[7 days of not being accessed](https://docs.github.com/en/actions/using-workflows/caching-dependencies-to-speed-up-workflows#usage-limits-and-eviction-policy), and there is a limit of 10 GB for the total size of cache files associated to each repository.

> [!NOTE]
> To allow deletion of caches you will likely need to [grant the following permissions](https://docs.github.com/en/actions/using-jobs/assigning-permissions-to-jobs)
> to the `GITHUB_TOKEN` by adding this to your GitHub actions workflow:
> ```yaml
> permissions:
>   actions: write
>   contents: read
> ```
> (Note this won't work for fork PRs but should once merged)
> Or provide a token with `repo` scope via the `token` input option.
> See https://cli.github.com/manual/gh_cache_delete

To disable deletion set input `delete-old-caches: 'false'`.

### Caching even if an intermediate job fails

Just like [the basic actions/cache workflow](https://github.com/actions/cache), this action has a cache restore step, and also a save step which runs after the workflow completes.
By default, if any job in the workflow fails, the entire workflow will be stopped, and the cache will not be saved.

Due to current limitations in GitHub Actions syntax, there is no built-in option for this action to save the cache even if the job fails.
However, it does output information which you can feed into `actions/cache` yourself to achieve the same effect.
For example, this workflow will ensure that the cache is saved if a step fails (but skipping it if the cache was hit, i.e. there's no need to cache it again).

```yaml
    steps:
      - uses: actions/checkout@v4

      - name: Load Julia packages from cache
        id: julia-cache
        uses: julia-actions/cache@v2

      # do whatever you want here (that might fail)

      - name: Save Julia depot cache on cancel or failure
        id: julia-cache-save
        if: cancelled() || failure()
        uses: actions/cache/save@v4
        with: 
          path: |
            ${{ steps.julia-cache.outputs.cache-paths }}
          key: ${{ steps.julia-cache.outputs.cache-key }}
```

### Cache Garbage Collection

Caches are restored and re-saved after every run, retaining the state of the depot throughout runs.
Their size will be regulated like a local depot automatically by the automatic `Pkg.gc()` functionality that
clears out old content, which is made possible because the `/log` contents are cached.

## Third Party Notice

This action is built around [`actions/cache`](https://github.com/actions/cache/) and includes parts of that action. `actions/cache` has been released under the following licence:

> The MIT License (MIT)
>
> Copyright (c) 2018 GitHub, Inc. and contributors
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in
> all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
> THE SOFTWARE.
