using Pkg, Dates
function handle_caches()
    repo = ARGS[1]
    func = ARGS[2]
    restore_key = get(ARGS, 3, "")

    if func == "list"
        println("Listing existing caches")
        run(`gh cache list --limit 100 --repo $repo`)
    elseif func == "rm"
        caches = String[]
        failed = String[]
        for _ in 1:5 # limit to avoid accidental rate limiting
            hits = split(strip(read(`gh cache list --limit 100 --repo $repo`, String)), keepempty=false)
            search_again = length(hits) == 100
            filter!(contains(restore_key), hits)
            isempty(hits) && break
            # We can delete everything that matches the restore key because the new cache is saved later.
            for c in hits
                try
                    run(`gh cache delete $(split(c)[1]) --repo $repo`)
                    push!(caches, c)
                catch e
                    @error e
                    push!(failed, c)
                end
            end
            search_again || break
        end
        if isempty(failed) && isempty(caches)
            println("No existing caches found for restore key `$restore_key`")
        else
            if !isempty(failed)
                println("Failed to delete $(length(failed)) existing caches for restore key `$restore_key`")
                println.(failed)
                @info """
                    To delete caches you need to grant the following to the default `GITHUB_TOKEN` by adding
                    this to your yml:
                    ```
                    permissions:
                        actions: write
                        contents: read
                    ```
                    (Note this won't work for fork PRs but should once merged)
                    Or provide a token with `repo` scope via the `token` input option.
                    See https://cli.github.com/manual/gh_cache_delete
                    """
            end
            if !isempty(caches)
                println("$(length(caches)) existing caches deleted that match restore key `$restore_key`:")
                println.(caches)
            end
        end
    else
        throw(ArgumentError("Unexpected second argument: $func"))
    end
end

try
    # do a gc with the standard 7-day delay
    Pkg.gc()
    handle_caches()
catch e
    @error "An error occurred while managing existing caches" e
end
