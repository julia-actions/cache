# julia-actions/cache Action

A shortcut action to cache Julia depot contents to reduce GitHub Actions running time.

## Usage

An example workflow that uses this action might look like this:

```yaml
name: CI

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v3
    - uses: julia-actions/setup-julia@v1
    - uses: julia-actions/cache@v1
    - uses: julia-actions/julia-buildpkg@v1
    - uses: julia-actions/julia-runtest@v1
```

By default, this caches the files in `~/.julia/artifacts/` and `~/.julia/packages/`.
To also cache `~/.julia/registries/`, use

```yaml
    - uses: julia-actions/cache@v1
      with:
        cache-registries: "true"
```

Note that caching the registries may actually slow down the workflow running time on Windows runners.
That is why caching the registries is disabled by default.

### Optional Inputs

- `cache-name` - Name used as part of the cache keys. Defaults to `julia-cache`. If your matrix has `julia-version` or
  `arch` under different names, interpolate their values into this name.
- `cache-artifacts` - Whether to cache `~/.julia/artifacts/`. Defaults to `yes`.
- `cache-packages` - Whether to cache `~/.julia/packages/`. Defaults to `yes`.
- `cache-registries` - Whether to cache `~/.julia/registries/`. Defaults to `no`. Disabled to ensure CI gets latest versions.
- `cache-compiled` - Whether to cache `~/.julia/compiled/`. Defaults to `yes`.
- `cache-scratchspaces` - Whether to cache `~/.julia/scratchspaces/`. Defaults to `yes`.
- `cache-log` - Whether to cache `~/.julia/logs/`. Defaults to `yes`. Helps auto-`Pkg.gc()` keep the cache small

### Outputs

- `cache-hit` - A boolean value to indicate an exact match was found for the primary key. Returns \"\" when the key is new. Forwarded from actions/cache.

## How It Works

This action is a wrapper around <https://github.com/actions/cache>.
In summary, this action stores the files in the aforementioned paths in one compressed file when running for the first time.
This cached file is then restored upon the second run, and afterwards resaved under a new key, and the previous cache deleted.
The benefit of this is that downloading one big file is quicker than downloading many different files from many different locations
and precompiling them.

### Cache keys

The cache key that the cache will be saved as is based on:
- The `cache-name` input
- An assumed `matrix.julia-version` variable (ignored if not found)
- The `runner.os`
- An assumed `matrix.arch` variable (ignored if not found)
- The run id
- The run attempt number

> [!NOTE]
> If in your workflow the above matrix variables are named differently, either conform them, or interpolate them into your
`cache-name` to ensure that individual caches are maintained for unique job types that run concurrently, otherwise caching
may not be effective.

### Cache Retention

This action automatically deletes old caches that match the first 4 fields of the above key:
- The `cache-name` input
- An assumed `matrix.julia-version` variable (ignored if not found)
- The `runner.os`
- An assumed `matrix.arch` variable (ignored if not found)

Which means your caches files will not grow needlessly. Github also deletes cache files after 7 days.

### Cache Garbage Collection

Caches are restored and re-saved after every run, retaining the state of the depot throughout runs.
Their size will be regulated like a local depot automatically by the automatic `Pkg.gc()` functionality that clears out
old content, which is made possible because the `/log` contents are cached.

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
