# cache-artifacts
A shortcut action to cache Julia artifacts.

Using this action is equivalent to including the following step in your workflows:

```yaml
- uses: actions/cache@v1
  env:
    cache-name: cache-artifacts
  with:
    path: ~/.julia/artifacts
    key: ${{ runner.os }}-test-${{ env.cache-name }}-${{ hashFiles('**/Project.toml') }}
    restore-keys: |
      ${{ runner.os }}-test-${{ env.cache-name }}-
      ${{ runner.os }}-test-
      ${{ runner.os }}-
```

## Usage

### Inputs

```yaml
- uses: julia-actions/cache-artifacts@v1
  with:
    # The cache name is used as part of the cache key.
    # It is equivalent to the cache-name environment variable in the snippet above.
    #
    # Default: cache-artifacts
    cache-name: ''
```

### Outputs

```yaml
outputs:
  # A boolean value to indicate an exact match was found for the primary key.
  # Forwarded from actions/cache, check its documentation for more info.
  cache-hit: ''
```

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
