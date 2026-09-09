namespace Glimt.Hub.Infrastructure;

/// <summary>
/// Development convenience: when GLIMT_MONGO_URI is not in the process environment, loads the repo's
/// .env and then .env.dev (later file wins, existing process variables always win). Mirrors
/// scripts/env.mjs so `dotnet run` and `dotnet test` behave like `npm run dev:hub` from any shell.
/// Never applies in production.
/// </summary>
public static class DotEnv
{
    public const string RootMarker = "example.env";

    private static readonly string[] Files = [".env", ".env.dev"];
    private static readonly string[] CommentMarkers = [" #", "\t#"];

    public sealed record LoadResult(string? RepoRoot, IReadOnlyList<string> LoadedFiles, int AppliedKeys, string? SkippedReason);

    public static LoadResult LoadIfNeeded()
    {
        if (string.Equals(Environment.GetEnvironmentVariable("GLIMT_DOTENV"), "off", StringComparison.OrdinalIgnoreCase))
        {
            return new LoadResult(null, [], 0, "GLIMT_DOTENV=off");
        }

        if (!string.IsNullOrEmpty(Environment.GetEnvironmentVariable("GLIMT_MONGO_URI")))
        {
            return new LoadResult(null, [], 0, "GLIMT_MONGO_URI is already set");
        }

        var env = Environment.GetEnvironmentVariable("GLIMT_ENV");
        if (string.Equals(env, GlimtOptions.Production, StringComparison.OrdinalIgnoreCase))
        {
            return new LoadResult(null, [], 0, "GLIMT_ENV=production");
        }

        var root = FindRepoRoot(Directory.GetCurrentDirectory()) ?? FindRepoRoot(AppContext.BaseDirectory);
        if (root is null)
        {
            return new LoadResult(null, [], 0, $"no {RootMarker} found above the working directory");
        }

        var merged = new Dictionary<string, string>(StringComparer.Ordinal);
        var loaded = new List<string>();
        foreach (var name in Files)
        {
            var path = Path.Combine(root, name);
            if (!File.Exists(path))
            {
                continue;
            }

            foreach (var (key, value) in Parse(File.ReadLines(path)))
            {
                merged[key] = value;
            }

            loaded.Add(path);
        }

        var applied = 0;
        foreach (var (key, value) in merged)
        {
            if (Environment.GetEnvironmentVariable(key) is null)
            {
                Environment.SetEnvironmentVariable(key, value);
                applied++;
            }
        }

        return new LoadResult(root, loaded, applied, null);
    }

    /// <summary>Walks up from <paramref name="start"/> until a directory containing example.env is found.</summary>
    public static string? FindRepoRoot(string start)
    {
        var dir = new DirectoryInfo(start);
        while (dir is not null)
        {
            if (File.Exists(Path.Combine(dir.FullName, RootMarker)))
            {
                return dir.FullName;
            }

            dir = dir.Parent;
        }

        return null;
    }

    /// <summary>
    /// Parses KEY=value lines. Blank lines and lines starting with # are ignored, quoted values keep
    /// their content verbatim, unquoted values lose a trailing " # comment".
    /// </summary>
    public static IEnumerable<KeyValuePair<string, string>> Parse(IEnumerable<string> lines)
    {
        foreach (var raw in lines)
        {
            var line = raw.Trim();
            if (line.Length == 0 || line.StartsWith('#'))
            {
                continue;
            }

            var eq = line.IndexOf('=');
            if (eq <= 0)
            {
                continue;
            }

            var key = line[..eq].Trim();
            var value = line[(eq + 1)..].Trim();
            if (value.Length >= 2 && ((value[0] == '"' && value[^1] == '"') || (value[0] == '\'' && value[^1] == '\'')))
            {
                value = value[1..^1];
            }
            else
            {
                var cut = -1;
                foreach (var marker in CommentMarkers)
                {
                    var index = value.IndexOf(marker, StringComparison.Ordinal);
                    if (index >= 0 && (cut < 0 || index < cut))
                    {
                        cut = index;
                    }
                }

                if (cut >= 0)
                {
                    value = value[..cut];
                }

                value = value.Trim();
            }

            yield return new KeyValuePair<string, string>(key, value);
        }
    }
}
