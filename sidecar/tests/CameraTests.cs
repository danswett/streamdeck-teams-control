using Xunit;

namespace TeamsBridge.Tests;

public class CameraTests
{
    [Fact]
    public void Existing_camera_arguments_leave_all_preferences_unchanged()
    {
        Assert.Equal(new CameraChoice("one", new()), Assert.Single(CameraArguments.Parse("one", false)!));
        Assert.Equal(new[] { new CameraChoice("one", new()), new CameraChoice("two", new()) },
            CameraArguments.Parse("[\"one\",\"two\"]", true));
    }

    [Fact]
    public void Swap_preferences_stay_with_their_camera()
    {
        var choices = CameraArguments.Parse("""
            {"cameras":[
                {"id":"one","mirror":"on","softFocus":"off","brightness":"on"},
                {"id":"two","mirror":"off","softFocus":"on","brightness":"off"}
            ]}
            """, true);
        Assert.Equal(new[] {
            new CameraChoice("one", new(true, false, true)),
            new CameraChoice("two", new(false, true, false))
        }, choices);
    }

    [Fact]
    public void Omitted_and_unchanged_preferences_do_not_override_Teams()
    {
        var choice = Assert.Single(CameraArguments.Parse("""
            {"cameras":[{"id":"one","mirror":"unchanged","brightness":"off"}]}
            """, false)!);
        Assert.Equal(new CameraPreferences(null, null, false), choice.Preferences);
    }

    [Theory]
    [InlineData(null, false)]
    [InlineData("", false)]
    [InlineData("{", false)]
    [InlineData("{}", false)]
    [InlineData("{\"cameras\":null}", false)]
    [InlineData("{\"cameras\":[]}", false)]
    [InlineData("{\"cameras\":[{}]}", false)]
    [InlineData("{\"cameras\":[{\"id\":\" \"}]}", false)]
    [InlineData("{\"cameras\":[{\"id\":1}]}", false)]
    [InlineData("{\"cameras\":[{\"id\":\"one\",\"mirror\":true}]}", false)]
    [InlineData("{\"cameras\":[{\"id\":\"one\",\"softFocus\":null}]}", false)]
    [InlineData("{\"cameras\":[{\"id\":\"one\",\"brightness\":\"invalid\"}]}", false)]
    [InlineData("{\"cameras\":[{\"id\":\"one\"}]}", true)]
    [InlineData("{\"cameras\":[{\"id\":\"one\"},{\"id\":\"two\"}]}", false)]
    [InlineData("{\"cameras\":[{\"id\":\"one\"},{\"id\":\"ONE\"}]}", true)]
    public void Invalid_preferences_or_camera_pairs_are_rejected_before_switching(string? arg, bool swap)
    {
        Assert.Null(CameraArguments.Parse(arg, swap));
    }

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

    [Fact]
    public void Both_webcams_of_a_swap_go_through_the_selector_template()
    {
        // A selectors.json fix after a Teams update may wrap the device id. The
        // second webcam used to be looked up raw, so it would never have matched.
        var spec = new ControlSpec
        {
            Menu = "video-button-configure",
            MenuItemAutomationId = "camera-{arg}",
            MenuItemName = "^{arg}$"
        };
        var pair = Cameras.ParseSwap("""["usb-cam", "virtual.cam"]""")!;

        foreach (var id in pair)
        {
            Assert.True(TeamsClient.TryItemSelectors(spec, id, out var ids, out var nameRx, out _));
            Assert.Equal($"camera-{id}", ids[0]);
            Assert.NotNull(nameRx);
            Assert.Matches(nameRx, id);
            Assert.DoesNotMatch(nameRx, "virtualXcam");
        }
    }
}
