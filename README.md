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
    - uses: julia-actions/setup-julia@v1
    - uses: julia-actions/cache@v1
    - uses: julia-actions/julia-buildpkg@v1
    - uses: julia-actions/julia-runtest@v1
```

By default the majority of the depot is cached. To also cache `~/.julia/registries/`, use

```yaml
    - uses: julia-actions/cache@v1
      with:
        cache-registries: "true"
```

However note that caching the registries may mean that the registry will not be updated each run.

### Optional Inputs

- `cache-name` - The cache key prefix. Defaults to `julia-cache;workflow=${{ github.workflow }};job=${{ github.job }}`. The key body automatically includes the OS and, unless disabled with `include-matrix`, the matrix vars. Include any other parameters/details in this prefix to ensure one unique cache key per concurrent job type.
- `include-matrix` - Whether to include the matrix values when constructing the cache key. Defaults to `true`.
- `depot` - Path to a Julia [depot](https://pkgdocs.julialang.org/v1/glossary/) directory where cached data will be saved to and restored from. Defaults to the first depot in [`JULIA_DEPOT_PATH`](https://docs.julialang.org/en/v1/manual/environment-variables/#JULIA_DEPOT_PATH) if specified. Otherwise, defaults to `~/.julia`.
- `cache-artifacts` - Whether to cache the depot's `artifacts` directory. Defaults to `true`.
- `cache-packages` - Whether to cache the depot's `packages` directory. Defaults to `true`.
- `cache-registries` - Whether to cache the depot's `registries` directory. Defaults to `false`. Disabled to ensure CI gets latest versions.
- `cache-compiled` - Whether to cache the depot's `compiled` directory. Defaults to `true`.
- `cache-scratchspaces` - Whether to cache the depot's `scratchspaces` directory. Defaults to `true`.
- `cache-logs` - Whether to cache the depot's `logs` directory. Defaults to `true`. Helps auto-`Pkg.gc()` keep the cache small.
- `delete-old-caches` - Whether to delete old caches for the given key. Defaults to `true`.
- `token` - A [GitHub PAT](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens). Defaults to `github.token`. Requires `repo` scope to enable the deletion of old caches.

### Outputs

- `cache-hit` - A boolean value to indicate an exact match was found for the primary key. Returns \"\" when the key is new. Forwarded from actions/cache.

## How It Works

This action is a wrapper around <https://github.com/actions/cache>.
In summary, this action stores the files in the aforementioned paths in one compressed file when running for the first time.
This cached file is then restored upon the second run, and afterwards resaved under a new key, and the previous cache deleted.
The benefit of caching is that downloading one big file is quicker than downloading many different files from many different locations
and precompiling them.

### Cache keys

The cache key that the cache will be saved as is based on:
- The `cache-name` input
- All variables in the `matrix` (unless disabled via `include-matrix: 'false'`)
- The `runner.os` (may be in the matrix too, but included for safety)
- The run id
- The run attempt number

> [!NOTE]
> If in your workflow if you do not use a matrix for concurrency you should make `cache-name` such that it is unique for
> concurrent jobs, otherwise caching may not be effective.

### Cache Retention

This action automatically deletes old caches that match the first 4 fields of the above key:
- The `cache-name` input
- All variables in the `matrix` (unless disabled via `include-matrix: 'false'`)
- The `runner.os` (may be in the matrix too, but included for safety)

Which means your caches files will not grow needlessly. GitHub also deletes cache files after
[90 days which can be increased in private repos to up to 400 days](https://docs.github.com/en/organizations/managing-organization-settings/configuring-the-retention-period-for-github-actions-artifacts-and-logs-in-your-organization)

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
