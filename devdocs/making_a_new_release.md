# Making a new release

First, go to the [Releases](https://github.com/julia-actions/cache/releases) section of this repo and create a new release using the GitHub web interface.

Once you've created the new release, you need to update the `v2` tag to point to the new release. For example, suppose that the previous release was `v2.1.0`, and suppose that you just created the new release `v2.2.0`. You need to update the `v2` tag so that it points to `v2.2.0`. Here are the steps:

```bash
git clone git@github.com:julia-actions/cache.git
cd cache
git fetch --all --prune
git fetch --all --tags

# Delete the current v2 tag locally:
git tag -d v2

# Create a new v2 tag locally, where the new v2 tag will point to the
# release that you created in the previous step.
#
# Make sure to change `v2.2.0` to the actual value for the release
# that you just created in the previous step.
git tag v2 v2.2.0

# Force-push the new v2 tag:
git push --force origin v2
```
