using System.Diagnostics.CodeAnalysis;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text.Json;

namespace TeamsBridge;

internal sealed record CameraDevice(string Id, string Name);

/// <summary>Enumerates Windows video inputs without opening a camera or requiring Teams.</summary>
internal static class Cameras
{
    internal static string[]? ParseSwap(string? arg)
    {
        if (string.IsNullOrWhiteSpace(arg)) return null;
        try
        {
            using var document = JsonDocument.Parse(arg);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Array || root.GetArrayLength() != 2 ||
                root[0].ValueKind != JsonValueKind.String || root[1].ValueKind != JsonValueKind.String)
                return null;
            var first = root[0].GetString();
            var second = root[1].GetString();
            return string.IsNullOrWhiteSpace(first) || string.IsNullOrWhiteSpace(second) ||
                   string.Equals(first, second, StringComparison.OrdinalIgnoreCase)
                ? null : [first, second];
        }
        catch (JsonException) { return null; }
    }

    internal static string DeviceId(string moniker) =>
        moniker.StartsWith("@device:pnp:", StringComparison.OrdinalIgnoreCase)
            ? moniker["@device:pnp:".Length..]
            : moniker;

    // COM marshaling needs the complete interface metadata in the trimmed sidecar.
    [DynamicDependency(DynamicallyAccessedMemberTypes.All, typeof(ICreateDevEnum))]
    [DynamicDependency(DynamicallyAccessedMemberTypes.All, typeof(IPropertyBag))]
    [DynamicDependency(DynamicallyAccessedMemberTypes.All, typeof(IEnumMoniker))]
    [DynamicDependency(DynamicallyAccessedMemberTypes.All, typeof(IMoniker))]
    public static CameraDevice[] Enumerate()
    {
        var enumerator = (ICreateDevEnum)new SystemDeviceEnumerator();
        IEnumMoniker? monikers = null;
        try
        {
            var category = new Guid("860BB310-5D01-11D0-BD3B-00A0C911CE86");
            var hr = enumerator.CreateClassEnumerator(ref category, out monikers, 0);
            if (hr == 1) return [];
            Marshal.ThrowExceptionForHR(hr);
            var cameras = new List<CameraDevice>();
            var next = new IMoniker[1];
            while (true)
            {
                var nextHr = monikers!.Next(1, next, IntPtr.Zero);
                if (nextHr == 1) break;
                Marshal.ThrowExceptionForHR(nextHr);
                var moniker = next[0];
                object? bag = null;
                try
                {
                    var bagId = typeof(IPropertyBag).GUID;
                    moniker.BindToStorage(null!, null!, ref bagId, out bag);
                    Marshal.ThrowExceptionForHR(((IPropertyBag)bag).Read("FriendlyName", out var name, IntPtr.Zero));
                    moniker.GetDisplayName(null!, null!, out var displayName);
                    cameras.Add(new(DeviceId(displayName), (string)name));
                }
                finally
                {
                    if (bag is not null) Marshal.ReleaseComObject(bag);
                    Marshal.ReleaseComObject(moniker);
                }
            }
            return cameras.ToArray();
        }
        finally
        {
            if (monikers is not null) Marshal.ReleaseComObject(monikers);
            Marshal.ReleaseComObject(enumerator);
        }
    }

    [ComImport, Guid("62BE5D10-60EB-11D0-BD3B-00A0C911CE86")]
    private class SystemDeviceEnumerator { }

    [ComImport, Guid("29840822-5B84-11D0-BD3B-00A0C911CE86"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface ICreateDevEnum
    {
        [PreserveSig]
        int CreateClassEnumerator(ref Guid category, out IEnumMoniker? enumerator, int flags);
    }

    [ComImport, Guid("55272A00-42CB-11CE-8135-00AA004BB851"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IPropertyBag
    {
        [PreserveSig]
        int Read([MarshalAs(UnmanagedType.LPWStr)] string name, [MarshalAs(UnmanagedType.Struct)] out object value, IntPtr errorLog);
        [PreserveSig]
        int Write([MarshalAs(UnmanagedType.LPWStr)] string name, [MarshalAs(UnmanagedType.Struct)] ref object value);
    }
}
