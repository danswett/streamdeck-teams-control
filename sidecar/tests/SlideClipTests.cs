using System.Drawing;
using TeamsBridge;
using Xunit;

/// <summary>
/// Clipping a filmstrip slide to the strip it lives in.
///
/// A filmstrip item reports its whole rectangle whether or not it has been
/// scrolled into view, and UI Automation only calls it offscreen once none of
/// it is showing. A half-scrolled slide is therefore reported as present, at a
/// rectangle running off the side of the list and over whatever is beside it -
/// which is how a thumbnail came back with the chat pane down one edge. These
/// are the real coordinates from that filmstrip.
/// </summary>
public class SlideClipTests
{
    // Measured from the live presenter view: the strip spans x 1350..3068,
    // and slides are 220 wide on a 240 pitch.
    private static readonly Rectangle Viewport = new(1350, 1694, 1718, 218);

    private static Rectangle Slide(int left) => new(left, 1700, 220, 125);

    [Fact]
    public void KeepsASlideThatIsFullyInView()
    {
        var slide = Slide(1878);
        var shown = TeamsClient.ClipToViewport(slide, Viewport);

        Assert.NotNull(shown);
        Assert.Equal(slide, shown!.Value);
    }

    [Fact]
    public void RefusesASlideScrolledMostlyOffTheLeft()
    {
        // 'Hibiscus Flower and Lavender Tea' sat here at 13% visible, and UI
        // Automation did not report it as offscreen.
        var shown = TeamsClient.ClipToViewport(Slide(1158), Viewport);

        Assert.Null(shown);
    }

    [Fact]
    public void RefusesASlideScrolledMostlyOffTheRight()
    {
        var shown = TeamsClient.ClipToViewport(Slide(3000), Viewport);

        Assert.Null(shown);
    }

    [Fact]
    public void RefusesASlideEntirelyOutsideTheStrip()
    {
        var shown = TeamsClient.ClipToViewport(Slide(3078), Viewport);

        Assert.Null(shown);
    }

    [Fact]
    public void RefusesHalfASlideRatherThanCroppingIt()
    {
        // Half a slide is not a useful preview, and cropping to it would put a
        // slide on the strip that is missing its right-hand side.
        var shown = TeamsClient.ClipToViewport(new Rectangle(2958, 1700, 220, 125), Viewport);

        Assert.Null(shown);
    }

    [Fact]
    public void AbsorbsAPixelOfRounding()
    {
        // The clip exists to take the edge off rounding, not to crop: a slide
        // one pixel over the edge is still worth showing, minus that pixel.
        var slide = new Rectangle(2849, 1700, 220, 125);
        var shown = TeamsClient.ClipToViewport(slide, Viewport);

        Assert.NotNull(shown);
        Assert.Equal(219, shown!.Value.Width);
        Assert.Equal(2849, shown.Value.X);
    }

    [Fact]
    public void RefusesASlideWithNoSize()
    {
        Assert.Null(TeamsClient.ClipToViewport(new Rectangle(1878, 1700, 0, 0), Viewport));
    }

    [Fact]
    public void ClipsVerticallyToo()
    {
        // The strip scrolls sideways, but nothing guarantees that, and a slide
        // hanging out of the bottom would pick up whatever is below it.
        var shown = TeamsClient.ClipToViewport(new Rectangle(1878, 1850, 220, 125), Viewport);

        Assert.Null(shown);
    }
}
