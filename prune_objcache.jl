# Remove the native code cache (objcache) entries that this job did not use, and replace each
# cache file with a compacted copy, so that the saved cache holds only the job's working set.
# Run with `JULIA_OBJCACHE=0`: the caches are replaced while this script runs, so it must not
# have one open itself.
function prune_objcaches()
    depot, start_time = ARGS[1], parse(Float64, ARGS[2])
    root = joinpath(depot, "cache", "v$(VERSION.major).$(VERSION.minor)", "objcache-lmdb1")
    isdir(root) || return
    if !isdefined(Base.Experimental, :prune_objcache)
        @info "This Julia version cannot prune the objcache. Saving it as it is."
        return
    end
    age = time() - start_time
    for (dir, _, files) in walkdir(root)
        "data.mdb" in files || continue
        file = joinpath(dir, "data.mdb")
        mktempdir(depot) do tmp
            out = joinpath(tmp, "objcache")
            cmd = `$(Base.julia_cmd()) --startup-file=no -e "print(Base.Experimental.prune_objcache(ARGS[1]; age=$age))" $out`
            cmd = addenv(cmd, "JULIA_OBJCACHE" => "1", "JULIA_OBJCACHE_PATH" => dir)
            removed = try
                readchomp(cmd)
            catch err
                @warn "Could not prune the objcache in $dir" exception=err
                return
            end
            removed == "nothing" && return
            before = filesize(file)
            mv(joinpath(out, "data.mdb"), file; force=true)
            @info "Pruned the objcache in $dir: removed $removed entries, $(Base.format_bytes(before)) -> $(Base.format_bytes(filesize(file)))"
        end
    end
end

prune_objcaches()
