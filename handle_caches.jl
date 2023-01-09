func = ARGS[1]
restore_key = get(ARGS, 2, "")

if func == "list"
    println("Listing existing caches")
    run(`gh cache list --limit 100`)
elseif func == "rm"
    caches = String[]
    for _ in 1:5 # limit to avoid accidental rate limiting
        hits = split(strip(read(`gh cache list --limit 100`, String)), keepempty=false)
        search_again = length(hits) == 100
        filter!(contains(restore_key), hits)
        isempty(hits) && break
        for c in hits
            try
                run(`gh cache delete $(split(c)[1])`)
            catch e
                @error e
            end
        end
        append!(caches, hits)
        search_again || break
    end
    if isempty(caches)
        println("No existing caches found for restore key `$restore_key`")
    else
        println("$(length(caches)) existing caches deleted that match restore key `$restore_key`:")
        println.(caches)
    end
end
