namespace TeamsBridge;

internal static class MusicMode
{
    internal sealed class Observer<T>(
        Func<T?> find, Func<T, bool?> read, Func<T, Action<bool?>, IDisposable?> subscribe) : IDisposable where T : class
    {
        private T? _element;
        private IDisposable? _subscription;
        private Signal? _signal;

        internal bool? LastKnown { get; private set; }

        internal bool? Refresh(bool exposed)
        {
            Remember(_signal?.Take());
            if (!exposed)
            {
                Release();
                return LastKnown;
            }

            var value = _element is null ? null : read(_element);
            if (value is null)
            {
                Release();
                _element = find();
                if (_element is not null)
                {
                    var signal = new Signal();
                    _signal = signal;
                    _subscription = subscribe(_element, signal.Record);
                    value = read(_element);
                }
            }
            Remember(value);
            return LastKnown;
        }

        private void Remember(bool? value)
        {
            if (value.HasValue) LastKnown = value;
        }

        private void Release()
        {
            _subscription?.Dispose();
            Remember(_signal?.Take());
            _subscription = null;
            _signal = null;
            _element = null;
        }

        public void Dispose() => Release();

        // Event callbacks only hand off a scalar; all UIA reads and state-map
        // writes stay on the worker. A detached subscription owns its own
        // signal, so a late callback cannot overwrite its replacement.
        private sealed class Signal
        {
            private int _value = -1;
            internal void Record(bool? value)
            {
                if (value.HasValue) Interlocked.Exchange(ref _value, value.Value ? 1 : 0);
            }
            internal bool? Take() => Interlocked.Exchange(ref _value, -1) switch
            {
                0 => false,
                1 => true,
                _ => null
            };
        }
    }

    internal sealed record Switch(bool? Active, bool Enabled, Func<bool> Press);

    internal static (bool ok, string? error) WithFlyout(
        bool? wasOpen, Func<bool> expand, Func<(bool ok, string? error)> invoke, Action deferDismiss)
    {
        if (wasOpen is null) return (false, "Teams did not expose the audio options state");
        if (wasOpen is true) return invoke();
        try
        {
            if (!expand()) return (false, "Could not open Teams audio options");
            return invoke();
        }
        finally { deferDismiss(); }
    }

    internal static bool Dismiss(Func<bool?> isOpen, Func<bool> collapse, Func<bool> waitForClosed)
    {
        if (isOpen() is false) return true;
        // Collapse is idempotent even if Teams closes between the read and call.
        // Do not fall back to a host toggle, including through generic cleanup.
        return collapse() ? waitForClosed() : isOpen() is false;
    }

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
