namespace Glimt.Hub.Features.Auth;

/// <summary>Password rules (IMPLEMENTERINGSPLAN 2.2): at least 10 characters and not among the most common passwords.</summary>
public static class Passwords
{
    public const int MinLength = 10;
    public const int MaxLength = 200;

    /// <summary>
    /// The most common passwords that survive the 10-character minimum (from public breach lists). A short embedded
    /// list; the plan mentions the top 10 000, which can replace this table without touching the callers.
    /// </summary>
    private static readonly HashSet<string> Common = new(StringComparer.OrdinalIgnoreCase)
    {
        "1234567890", "12345678910", "123456789012", "1234567890123", "0123456789", "0987654321", "1234512345", "1231231231",
        "1111111111", "0000000000", "2222222222", "9999999999", "1122334455", "1212121212", "1234554321", "1029384756",
        "password12", "password123", "password1234", "password12345", "password!", "password1!", "passw0rd123", "p@ssword123",
        "p@ssw0rd123", "mypassword", "mypassword1", "mypassword123", "passwordpassword", "password2024", "password2025", "password2026",
        "qwertyuiop", "qwerty1234", "qwerty12345", "qwerty123456", "qwertyuiop123", "1q2w3e4r5t", "1q2w3e4r5t6y", "1qaz2wsx3edc",
        "qazwsxedcrfv", "asdfghjkl;", "asdfghjkl1", "zxcvbnm123", "asdf1234asdf", "abcd1234abcd", "abcdefghij", "abcdefghijk",
        "abcdefghijkl", "abcdefg123", "abc12345678", "abcdef1234", "iloveyou12", "iloveyou123", "iloveyou1234", "iloveyou!!",
        "iloveyou2024", "loveyou123", "letmein123", "letmein1234", "welcome123", "welcome1234", "welcome2024", "welcome2025",
        "welcome2026", "administrator", "admin123456", "admin12345", "adminadmin", "admin@123", "root123456", "superman123",
        "batman1234", "spiderman1", "football12", "football123", "baseball12", "baseball123", "basketball", "basketball1",
        "soccer1234", "trustno1234", "sunshine12", "sunshine123", "princess12", "princess123", "monkey1234", "monkey12345",
        "dragon1234", "dragon12345", "shadow1234", "master1234", "michael123", "jennifer123", "jessica123", "computer12",
        "computer123", "internet123", "whatever12", "whatever123", "changeme123", "temppassword", "temp123456", "test123456",
        "testtest123", "testing123", "starwars123", "pokemon123", "minecraft1", "minecraft123", "cheese1234", "chocolate1",
        "liverpool1", "liverpool123", "arsenal123", "manchester1", "november12", "december12", "september1", "1234qwerty",
        "123456qwerty", "123qweasd", "123qweasdzxc", "1234abcd1234", "1234567890a", "a1234567890", "aa123456789",
    };

    /// <summary>Returns a validation message, or null when the password is acceptable.</summary>
    public static string? Validate(string? password)
    {
        if (string.IsNullOrEmpty(password) || password.Length < MinLength)
        {
            return $"Password must be at least {MinLength} characters.";
        }

        if (password.Length > MaxLength)
        {
            return $"Password must be at most {MaxLength} characters.";
        }

        if (Common.Contains(password.Trim()))
        {
            return "That password is too common. Choose another one.";
        }

        return null;
    }
}
