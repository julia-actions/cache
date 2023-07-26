# julia-actions/cache Action

A shortcut action to cache Julia artifacts, packages and (optionally) registries to reduce GitHub Actions running time.

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

### Inputs

- `cache-name` - Name used as part of the cache keys
- `cache-artifacts` - Whether to cache `~/.julia/artifacts/`. Enabled by default.
- `cache-packages` - Whether to cache `~/.julia/packages/`. Enabled by default.
- `cache-registries` - Whether to cache `~/.julia/registries/`. Disabled by default.
- `cache-compiled` - Whether to cache `~/.julia/compiled/`. Disabled by default. **USE ONLY IF YOU KNOW WHAT YOU'RE DOING!** See [#11](https://github.com/julia-actions/cache/issues/11).
- `cache-scratchspaces` - Whether to cache `~/.julia/scratchspaces/`. Enabled by default.

### Outputs

- `cache-hit` - A boolean value to indicate an exact match was found for the primary key. Returns \"\" when the key is new. Forwarded from actions/cache.

## How it works

This action is a wrapper around <https://github.com/actions/cache>.
In summary, this action stores the files in the aforementioned paths in one compressed file when running for the first time.
This cached file is then restored upon the second run.
The benefit of this is that downloading one big file is quicker than downloading many different files from many different locations.

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
