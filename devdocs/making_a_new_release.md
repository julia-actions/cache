# Making a new release

In this guide, as an example, `v2.2.0` refers to the version number of the new release that you want to make.

## Part 1: Use the Git CLI to create and push the Git tags

Step 1: Clone the repository:

```bash
git clone git@github.com:julia-actions/cache.git
cd cache
```

Step 2: Create a new lightweight tag of the form `vMAJOR.MINOR.PATCH`.

```bash
# Get the commit SHA of the latest pushed commit on the default branch
git fetch origin --tags --force
commit_sha=$(git rev-parse origin/HEAD)

# Validate this commit is the one you intend to release
git --no-pager log -1 ${commit_sha:?}

# Now, create a new lightweight tag of the form `vMAJOR.MINOR.PATCH`.
# Replace `v2.2.0` with the actual version number that you want to use.
tag=v2.2.0
git tag ${tag:?} ${commit_sha:?}
```

Step 3: Once you've created the new release, you need to update the major tag to point to the new release. For example, suppose that the previous release was `v2.1.0`, and suppose that you just created the new release `v2.2.0`. You need to update the major tag `v2` so that it points to `v2.2.0`. Here are the commands:

```bash
# Create/update the new major tag locally, where the new major tag will point to the
# release that you created in the previous step.
#
# The `-f` flag forcibly overwrites the old major tag (if it exists).
major_tag=$(echo ${tag:?} | grep -o '^v[0-9]*')
git tag -f ${major_tag:?} ${tag:?}
```

Step 4: Now you need to push the tags:

```bash
# Regular-push the new tag:
git push origin tag ${tag:?}

# Force-push the new major tag:
git push origin tag ${major_tag:?} --force
```

## Part 2: Create the GitHub Release

Go to the [Releases](https://github.com/julia-actions/cache/releases) section of this repo and create a new release (using the GitHub web interface).

For the "choose a tag" drop-down field, select the new tag (e.g. `v2.2.0`) that you created and pushed in Part 1 of this guide.
