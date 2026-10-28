using System.Text.Json;

namespace TeamsBridge;

internal sealed record CameraPreferences(bool? Mirror = null, bool? SoftFocus = null, bool? Brightness = null);
internal sealed record CameraChoice(string Id, CameraPreferences Preferences);

internal static class CameraArguments
{
    internal static CameraChoice[]? Parse(string? arg, bool swap)
    {
        if (string.IsNullOrWhiteSpace(arg)) return null;
        if (!arg.TrimStart().StartsWith('{'))
        {
            var ids = swap ? Cameras.ParseSwap(arg) : [arg];
            return ids?.Select(id => new CameraChoice(id, new())).ToArray();
        }

        try
        {
            using var document = JsonDocument.Parse(arg);
            var root = document.RootElement;
            if (!root.TryGetProperty("cameras", out var cameras) ||
                cameras.ValueKind != JsonValueKind.Array || cameras.GetArrayLength() != (swap ? 2 : 1))
                return null;
            var choices = new List<CameraChoice>();
            foreach (var camera in cameras.EnumerateArray())
            {
                if (camera.ValueKind != JsonValueKind.Object ||
                    !camera.TryGetProperty("id", out var id) || id.ValueKind != JsonValueKind.String ||
                    string.IsNullOrWhiteSpace(id.GetString()) ||
                    !Preference(camera, "mirror", out var mirror) ||
                    !Preference(camera, "softFocus", out var softFocus) ||
                    !Preference(camera, "brightness", out var brightness))
                    return null;
                choices.Add(new(id.GetString()!, new(mirror, softFocus, brightness)));
            }
            if (swap && string.Equals(choices[0].Id, choices[1].Id, StringComparison.OrdinalIgnoreCase))
                return null;
            return choices.ToArray();
        }
        catch (JsonException) { return null; }
    }

    private static bool Preference(JsonElement camera, string name, out bool? value)
    {
        value = null;
        if (!camera.TryGetProperty(name, out var property)) return true;
        if (property.ValueKind != JsonValueKind.String) return false;
        switch (property.GetString())
        {
            case "unchanged": return true;
            case "on": value = true; return true;
            case "off": value = false; return true;
            default: return false;
        }
    }
}
