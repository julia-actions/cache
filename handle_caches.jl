using Pkg, Dates
function handle_caches()
    subcommand = ARGS[1]

    if subcommand == "list"
        repo = ARGS[2]
        println("Listing existing caches")
        run(`gh cache list --limit 100 --repo $repo`)
    elseif subcommand == "rm"
        repo, restore_key, ref = ARGS[2:4]
        allow_failure = ARGS[5] == "true"

        page = 1
        per_page = 100
        skipped = String[]
        deleted = String[]
        failed = String[]
        while 1 <= page <= 5 # limit to avoid accidental rate limiting
            # https://docs.github.com/en/rest/actions/cache?apiVersion=2022-11-28#list-github-actions-caches-for-a-repository
            # Note: The `key` field matches on the full key or a prefix.
            cmd = ```
                gh api -X GET /repos/$repo/actions/caches
                    --field per_page=$per_page
                    --field page=$page
                    --field ref=$ref
                    --field key=$restore_key
                    --field sort=last_accessed_at
                    --field direction=desc
                    --jq '.actions_caches[].id'
                ```
            ids = split(read(cmd, String); keepempty=false)

            # Avoid deleting the latest used cache entry. This is particularly important for
            # job failures where a new cache entry will not be saved after this.
            page == 1 && !isempty(ids) && push!(skipped, popfirst!(ids))

            for id in ids
                try
                    run(`gh cache delete $id --repo $repo`)
                    push!(deleted, id)
                catch e
                    @error e
                    push!(failed, id)
                end
            end

            page = length(ids) == per_page ? page + 1 : -1
        end
        if isempty(skipped) && isempty(deleted) && isempty(failed)
            println("No existing caches found on ref `$ref` matching restore key `$restore_key`")
        else
            if !isempty(failed)
                println("Failed to delete $(length(failed)) existing caches on ref `$ref` matching restore key `$restore_key`")
                println.(failed)
                @info """
                    To delete caches you need to grant the following to the default `GITHUB_TOKEN` by adding
                    this to your workflow:
                    ```
                    permissions:
                      actions: write
                      contents: read
                    ```
                    (Note this won't work for fork PRs but should once merged)
                    Or provide a token with `repo` scope via the `token` input option.
                    See https://cli.github.com/manual/gh_cache_delete
                    """
                allow_failure || exit(1)
            end
            if !isempty(deleted)
                println("Deleted $(length(deleted)) caches on ref `$ref` matching restore key `$restore_key`")
                println.(deleted)
            end
        end
    else
        throw(ArgumentError("Unexpected subcommand: $subcommand"))
    end
end

try
    # do a gc with the standard 7-day delay
    Pkg.gc()
    handle_caches()
catch e
    @error "An error occurred while managing existing caches" e
end
