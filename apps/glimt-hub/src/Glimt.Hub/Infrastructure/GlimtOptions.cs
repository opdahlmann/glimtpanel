namespace Glimt.Hub.Infrastructure;

/// <summary>
/// All hub settings, read from environment variables with the GLIMT_ prefix (IMPLEMENTERINGSPLAN 5.3).
/// The env keys are UPPER_SNAKE and the properties PascalCase, so the mapping is explicit instead of
/// relying on the binder's case-insensitive matching.
/// </summary>
public sealed class GlimtOptions
{
    public const string Development = "development";
    public const string E2e = "e2e";
    public const string Production = "production";

    public required string Env { get; init; }
    public required string MongoUri { get; init; }
    public required string MongoDb { get; init; }
    public required string JwtSecret { get; init; }
    public required string HubUrl { get; init; }
    public int HeartbeatSeconds { get; init; } = 30;
    public int DownAfterSeconds { get; init; } = 120;
    public string? DevEnrolKey { get; init; }
    public string? DevUserEmail { get; init; }
    public string? DevUserPassword { get; init; }
    public string? WebPublicUrl { get; init; }
    public string? HubPublicUrl { get; init; }
    public string? InstallUrl { get; init; }
    public string? DocsUrl { get; init; }
    public string? BufferPath { get; init; }
    public bool DemoMode { get; init; }
    public string? AgentVersion { get; init; }

    /// <summary>The sidecar image in the snippets from POST /api/servers (GLIMT_AGENT_IMAGE), fase 12.</summary>
    public string? AgentImage { get; init; }

    /// <summary>Outside production: a container node `sidecar-dev` on the dev account with this token (GLIMT_DEV_CONTAINER_TOKEN), so `npm run dev -- --sidecar` always has a node.</summary>
    public string? DevContainerToken { get; init; }
    public string? AppmailUrl { get; init; }
    public string? AppmailApiKey { get; init; }
    public string? MailFrom { get; init; }
    public string? VapidPublic { get; init; }
    public string? VapidPrivate { get; init; }
    public string? VapidSubject { get; init; }

    /// <summary>GLIMT_UNLIMITED_EMAILS: accounts that are always on the unlimited plan (owner and whoever they add). Case-insensitive.</summary>
    public IReadOnlySet<string> UnlimitedEmails { get; init; } = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

    public bool IsUnlimited(string email) => UnlimitedEmails.Contains(email.Trim());

    public bool IsProduction => Env == Production;

    /// <summary>development or e2e: dev enrol key accepted, dev user seeded, CORS for the web app.</summary>
    public bool IsDevelopmentLike => Env is Development or E2e;

    public TimeSpan Heartbeat => TimeSpan.FromSeconds(HeartbeatSeconds);
    public TimeSpan DownAfter => TimeSpan.FromSeconds(DownAfterSeconds);

    /// <summary>Maps GLIMT_ENV to the ASP.NET Core environment name (only used for framework defaults).</summary>
    public static string AspNetEnvironmentName(string? glimtEnv) =>
        string.Equals(glimtEnv?.Trim(), Production, StringComparison.OrdinalIgnoreCase)
            ? Environments.Production
            : Environments.Development;

    /// <summary>Reads the options from a configuration that has AddEnvironmentVariables("GLIMT_") applied.</summary>
    /// <exception cref="GlimtConfigurationException">When required keys are missing or values are invalid.</exception>
    public static GlimtOptions FromConfiguration(IConfiguration configuration)
    {
        var missing = new List<string>();
        var invalid = new List<string>();

        string? Optional(string key)
        {
            var value = configuration[key];
            return string.IsNullOrWhiteSpace(value) ? null : value.Trim();
        }

        string Required(string key)
        {
            var value = Optional(key);
            if (value is null)
            {
                missing.Add("GLIMT_" + key);
            }

            return value ?? "";
        }

        int PositiveInt(string key, int fallback)
        {
            var value = Optional(key);
            if (value is null)
            {
                return fallback;
            }

            if (int.TryParse(value, out var parsed) && parsed > 0)
            {
                return parsed;
            }

            invalid.Add($"GLIMT_{key} must be a positive integer (was '{value}')");
            return fallback;
        }

        bool Flag(string key)
        {
            var value = Optional(key);
            if (value is null)
            {
                return false;
            }

            if (bool.TryParse(value, out var parsed))
            {
                return parsed;
            }

            invalid.Add($"GLIMT_{key} must be true or false (was '{value}')");
            return false;
        }

        var env = (Optional("ENV") ?? Development).ToLowerInvariant();
        if (env is not (Development or E2e or Production))
        {
            invalid.Add($"GLIMT_ENV must be {Development}, {E2e} or {Production} (was '{env}')");
        }

        var hubUrl = Optional("HUB_URL") ?? "http://localhost:5080";
        if (!Uri.TryCreate(hubUrl, UriKind.Absolute, out var hubUri) || hubUri.Scheme is not ("http" or "https"))
        {
            invalid.Add($"GLIMT_HUB_URL must be an absolute http(s) URL (was '{hubUrl}')");
        }

        var options = new GlimtOptions
        {
            Env = env,
            MongoUri = Required("MONGO_URI"),
            MongoDb = Required("MONGO_DB"),
            JwtSecret = Required("JWT_SECRET"),
            HubUrl = hubUrl,
            HeartbeatSeconds = PositiveInt("HEARTBEAT_SECONDS", 30),
            DownAfterSeconds = PositiveInt("DOWN_AFTER_SECONDS", 120),
            DevEnrolKey = Optional("DEV_ENROL_KEY"),
            DevUserEmail = Optional("DEV_USER_EMAIL"),
            DevUserPassword = Optional("DEV_USER_PASSWORD"),
            WebPublicUrl = Optional("WEB_PUBLIC_URL"),
            HubPublicUrl = Optional("HUB_PUBLIC_URL"),
            InstallUrl = Optional("INSTALL_URL"),
            DocsUrl = Optional("DOCS_URL"),
            BufferPath = Optional("BUFFER_PATH"),
            DemoMode = Flag("DEMO_MODE"),
            AgentVersion = Optional("AGENT_VERSION"),
            AgentImage = Optional("AGENT_IMAGE"),
            DevContainerToken = Optional("DEV_CONTAINER_TOKEN"),
            AppmailUrl = Optional("APPMAIL_URL"),
            AppmailApiKey = Optional("APPMAIL_API_KEY"),
            MailFrom = Optional("MAIL_FROM"),
            VapidPublic = Optional("VAPID_PUBLIC"),
            VapidPrivate = Optional("VAPID_PRIVATE"),
            VapidSubject = Optional("VAPID_SUBJECT"),
            UnlimitedEmails = (Optional("UNLIMITED_EMAILS") ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToHashSet(StringComparer.OrdinalIgnoreCase),
        };

        if (missing.Count > 0)
        {
            invalid.Insert(0, "missing required environment variables: " + string.Join(", ", missing)
                + " (copy example.env to .env.dev and fill in the values)");
        }

        if (invalid.Count > 0)
        {
            throw new GlimtConfigurationException("Invalid hub configuration: " + string.Join("; ", invalid));
        }

        return options;
    }
}

public sealed class GlimtConfigurationException(string message) : Exception(message);
