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

        endpoint = "/repos/$repo/actions/caches"
        page = 1
        per_page = 100
        escaped_restore_key = replace(restore_key, "\"" => "\\\"")
        query = ".actions_caches[] | select(.key | startswith(\"$escaped_restore_key\")) | .id"

        deletions = String[]
        failures = String[]
        while 1 <= page <= 5 # limit to avoid accidental rate limiting
            cmd = `gh api -X GET $endpoint -F ref=$ref -F per_page=$per_page -F page=$page --jq $query`
            ids = split(read(cmd, String); keepempty=false)
            page = length(ids) == per_page ? page + 1 : -1

            # We can delete all cache entries on this branch that matches the restore key
            # because the new cache is saved later.
            for id in ids
                try
                    run(`gh api -X DELETE $repo/$id`)
                    push!(deletions, id)
                catch e
                    @error e
                    push!(failures, id)
                end
            end
        end
        if isempty(failures) && isempty(deletions)
            println("No existing caches found on ref `$ref` matching restore key `$restore_key`")
        else
            if !isempty(failures)
                println("Failed to delete $(length(failures)) existing caches on ref `$ref` matching restore key `$restore_key`")
                println.(failures)
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
            if !isempty(deletions)
                println("Deleted $(length(deletions)) caches on ref `$ref` matching restore key `$restore_key`")
                println.(deletions)
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
