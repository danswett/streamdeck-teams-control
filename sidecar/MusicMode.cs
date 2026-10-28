namespace TeamsBridge;

internal static class MusicMode
{
    internal sealed record Switch(bool? Active, bool Enabled, Func<bool> Press);

    // Re-find for every read: Teams can replace a switch after posting input.
    internal static (bool ok, string? error, bool? active) Toggle(
        Func<Switch?> find, Action? wait = null, Func<long>? now = null)
    {
        wait ??= () => Thread.Sleep(80);
        now ??= () => Environment.TickCount64;

        Switch? ReadKnown()
        {
            var deadline = now() + 1500;
            do
            {
                var current = find();
                if (current is { Enabled: false } || current?.Active is not null) return current;
                wait();
            } while (now() < deadline);
            return null;
        }

        var initial = ReadKnown();
        if (initial is { Enabled: false }) return (false, "High fidelity music mode is disabled in Teams", null);
        if (initial?.Active is not bool wasOn)
            return (false, "Teams did not expose the High fidelity music mode state", null);
        var desired = !wasOn;

        // A manual change between discovery and the write must not be undone.
        var fresh = ReadKnown();
        if (fresh is { Enabled: false }) return (false, "High fidelity music mode is disabled in Teams", null);
        if (fresh?.Active is not bool before)
            return (false, "Teams did not expose the High fidelity music mode state before the press", null);
        if (before == desired) return (true, null, desired);
        if (!fresh.Press()) return (false, "Could not press High fidelity music mode", null);

        var until = now() + 1500;
        do
        {
            var observed = find();
            if (observed?.Active == desired) return (true, null, desired);
            wait();
        } while (now() < until);

        // Retry reads, never the write: a late first click could otherwise be
        // followed by a second click that silently undoes it.
        return (false, "Teams did not confirm the High fidelity music mode change", null);
    }
}
