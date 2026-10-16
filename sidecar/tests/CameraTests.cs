using Xunit;

namespace TeamsBridge.Tests;

public class CameraTests
{
    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("invalid JSON")]
    [InlineData("{}")]
    [InlineData("[]")]
    [InlineData("[\"one\"]")]
    [InlineData("[\"one\", \"two\", \"three\"]")]
    [InlineData("[null, \"two\"]")]
    [InlineData("[3, \"two\"]")]
    [InlineData("[\"\", \"two\"]")]
    [InlineData("[\"one\", \" \"]")]
    [InlineData("[\"one\", \"one\"]")]
    [InlineData("[\"ONE\", \"one\"]")]
    public void Swap_requires_exactly_two_different_configured_cameras(string? arg)
    {
        Assert.Null(Cameras.ParseSwap(arg));
    }

    [Fact]
    public void Swap_preserves_device_ids_and_order()
    {
        var ids = new[] { @"\\?\usb#camera\global", "@device:sw:{category}\\{virtual-camera}" };
        Assert.Equal(ids, Cameras.ParseSwap(System.Text.Json.JsonSerializer.Serialize(ids)));
    }

    [Theory]
    [InlineData(@"@device:pnp:\\?\usb#camera\global", @"\\?\usb#camera\global")]
    [InlineData(@"@DEVICE:PNP:\\?\pci#capture", @"\\?\pci#capture")]
    [InlineData("@device:sw:{category}\\{virtual-camera}", "@device:sw:{category}\\{virtual-camera}")]
    public void Device_id_matches_Teams_without_using_the_display_name(string moniker, string expected)
    {
        Assert.Equal(expected, Cameras.DeviceId(moniker));
    }

    [Fact]
    public void Camera_selector_uses_the_exact_device_id_and_existing_video_menu()
    {
        var spec = Defaults.Config().Controls["camera-select"];
        Assert.Equal("video-button-configure", spec.Menu);
        Assert.Equal("{arg}", spec.MenuItemAutomationId);
        Assert.Null(spec.MenuItemName);
        Assert.Null(spec.MenuItemOffName);
        var swap = Defaults.Config().Controls["camera-swap"];
        Assert.Equal(spec.Menu, swap.Menu);
        Assert.Equal("{arg}", swap.MenuItemAutomationId);
        Assert.Null(swap.MenuItemOffName);
    }
}
