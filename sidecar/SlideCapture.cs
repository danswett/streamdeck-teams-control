using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

namespace TeamsBridge;

/// <summary>
/// Grabs part of a window and returns it as a PNG data URI.
///
/// Used for slide thumbnails. PowerPoint Live exposes no image of a slide
/// anywhere in the accessibility tree - only the name of it - so the picture
/// has to come off the window. That makes this the one part of the plugin that
/// reads meeting content rather than controls, and it is deliberately narrow:
/// a caller names a rectangle inside a window, gets back a downscaled still,
/// and nothing is written to disk or logged.
/// </summary>
internal static class SlideCapture
{
    /// <summary>
    /// The touch strip gives every dial a 200x100 slot, and a 16:9 slide fits
    /// that at 178x100. Capturing much above the size it will be shown at only
    /// costs encoding time and bytes on the wire.
    /// </summary>
    public const int MaxWidth = 200;
    public const int MaxHeight = 100;

    /// <summary>Width of the red border Teams draws around the live slide.</summary>
    private const int BorderWidth = 3;

    /// <summary>Render the whole window, including anything drawn on top of it.</summary>
    private const int PW_RENDERFULLCONTENT = 2;

    [DllImport("user32.dll")]
    private static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT
    {
        public int Left, Top, Right, Bottom;
    }

    /// <summary>
    /// Captures a screen rectangle that lies inside the given window, scaled to
    /// fit the given bounds.
    ///
    /// The window is asked to draw itself rather than the screen being read,
    /// which matters twice over: a thumbnail is right even when something is
    /// sitting on top of Teams, and a region that is not actually inside the
    /// window can be rejected instead of returning a picture of whatever else
    /// happened to be at those coordinates. The filmstrip reports rectangles
    /// for slides scrolled out of view, so that is not hypothetical.
    ///
    /// Returns null rather than throwing: a slide that cannot be grabbed is a
    /// thumbnail that does not appear, not a failed press.
    /// </summary>
    public static string? Grab(
        IntPtr window,
        int x,
        int y,
        int width,
        int height,
        bool border = false,
        int slotWidth = MaxWidth,
        int slotHeight = MaxHeight)
    {
        using var slot = Compose(window, x, y, width, height, border, slotWidth, slotHeight);
        return slot is null ? null : Encode(slot);
    }

    /// <summary>
    /// The same capture, plus the frames that fade the previous picture into
    /// it.
    ///
    /// The blend is done here because the bitmaps are already here: handing the
    /// plugin two pictures and asking it to interpolate would mean shipping an
    /// image library to Node for arithmetic that GDI+ is already doing.
    ///
    /// <paramref name="key"/> names the slot to remember, so the current and
    /// next thumbnails fade independently of each other. The first capture for
    /// a key has nothing to fade from and returns no frames.
    /// </summary>
    public static (string? image, List<string> frames) GrabSequence(
        string key,
        IntPtr window,
        int x,
        int y,
        int width,
        int height,
        bool border,
        int fadeFrames,
        int slotWidth = MaxWidth,
        int slotHeight = MaxHeight)
    {
        var frames = new List<string>();
        var slot = Compose(window, x, y, width, height, border, slotWidth, slotHeight);
        if (slot is null) return (null, frames);

        try
        {
            lock (PreviousLock)
            {
                Previous.TryGetValue(key, out var from);

                if (from is not null && fadeFrames > 0 && from.Size == slot.Size)
                {
                    for (var i = 1; i <= fadeFrames; i++)
                    {
                        // Endpoints are left out: the picture already on the
                        // strip is frame zero, and the capture itself is the
                        // last one, so sending either again only costs a paint.
                        using var blended = Blend(from, slot, (float)i / (fadeFrames + 1));
                        frames.Add(EncodeJpeg(blended));
                    }
                }

                from?.Dispose();
                Previous[key] = (Bitmap)slot.Clone();
            }

            return (Encode(slot), frames);
        }
        finally
        {
            slot.Dispose();
        }
    }

    /// <summary>
    /// Forgets the last picture for a slot, so nothing fades out of it.
    ///
    /// Keys are the slot name and the size it was composed at, because the same
    /// slide is captured at one size for the touch strip and another for a key,
    /// and a fade can only run between two frames of the same shape. Passing a
    /// slot name forgets every size of it; passing null forgets everything.
    ///
    /// The frames are kept only to fade from, so once a deck stops - or the
    /// user withdraws permission to read it - holding a slide in a process that
    /// runs for the whole session buys nothing and keeps meeting content
    /// resident.
    /// </summary>
    public static void ForgetPrevious(string? key = null)
    {
        lock (PreviousLock)
        {
            var doomed = Previous.Keys
                .Where(k => key is null || k == key || k.StartsWith(key + ":", StringComparison.Ordinal))
                .ToList();

            foreach (var k in doomed)
            {
                Previous[k].Dispose();
                Previous.Remove(k);
            }
        }
    }

    /// <summary>The last picture composed for each slot, to fade out of.</summary>
    private static readonly Dictionary<string, Bitmap> Previous = new();
    private static readonly object PreviousLock = new();

    /// <summary><paramref name="to"/> drawn over <paramref name="from"/> at the given opacity.</summary>
    private static Bitmap Blend(Bitmap from, Bitmap to, float alpha)
    {
        var frame = new Bitmap(from.Width, from.Height, PixelFormat.Format32bppArgb);
        try
        {
            using var g = Graphics.FromImage(frame);
            g.DrawImage(from, 0, 0, from.Width, from.Height);

            var matrix = new ColorMatrix { Matrix33 = alpha };
            using var attrs = new ImageAttributes();
            attrs.SetColorMatrix(matrix);
            g.DrawImage(
                to,
                new Rectangle(0, 0, to.Width, to.Height),
                0, 0, to.Width, to.Height,
                GraphicsUnit.Pixel,
                attrs);

            return frame;
        }
        catch
        {
            frame.Dispose();
            throw;
        }
    }

    private static Bitmap? Compose(
        IntPtr window,
        int x,
        int y,
        int width,
        int height,
        bool border,
        int slotWidth,
        int slotHeight)
    {
        if (width <= 0 || height <= 0) return null;
        if (window == IntPtr.Zero) return null;

        Bitmap? composed = null;
        try
        {
            if (!GetWindowRect(window, out var wr)) return null;

            var windowWidth = wr.Right - wr.Left;
            var windowHeight = wr.Bottom - wr.Top;
            if (windowWidth <= 0 || windowHeight <= 0) return null;

            // Window-relative, and inside it: a filmstrip runs past the edge of
            // the window, and those slides are not drawn at all.
            var rx = x - wr.Left;
            var ry = y - wr.Top;
            if (rx < 0 || ry < 0 || rx + width > windowWidth || ry + height > windowHeight) return null;

            var shot = WindowBuffer(windowWidth, windowHeight);
            using (var g = Graphics.FromImage(shot))
            {
                // Reused between captures, so last time's window is still in
                // it. PrintWindow redraws the lot, but a window that declines
                // to draw part of itself would otherwise leave the previous
                // capture showing through.
                g.Clear(Color.Black);

                var hdc = g.GetHdc();
                try
                {
                    if (!PrintWindow(window, hdc, PW_RENDERFULLCONTENT)) return null;
                }
                finally
                {
                    g.ReleaseHdc(hdc);
                }
            }

            using var region = shot.Clone(new Rectangle(rx, ry, width, height), PixelFormat.Format32bppArgb);

            /*
                Composed at the size of the slot it will occupy rather than
                handed over raw. The alternative was returning the crop and
                letting the plugin letterbox it inside an SVG, which would mean
                base64 inside base64 - roughly a third more bytes over the wire
                for a picture, to do arithmetic that is easier here where the
                dimensions are already known.
            */
            var scale = Math.Min((double)slotWidth / width, (double)slotHeight / height);
            var w = Math.Max(1, (int)Math.Round(width * scale));
            var h = Math.Max(1, (int)Math.Round(height * scale));
            var left = (slotWidth - w) / 2;
            var top = (slotHeight - h) / 2;

            var slot = new Bitmap(slotWidth, slotHeight, PixelFormat.Format32bppArgb);
            composed = slot;
            using (var g = Graphics.FromImage(slot))
            {
                g.Clear(Color.Black);
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                g.DrawImage(region, left, top, w, h);

                if (border)
                {
                    /*
                        The same red Teams draws around the slide being
                        presented, so the strip says which one is live the way
                        the app does.

                        Filled as four bands rather than stroked with a pen,
                        because PenAlignment.Inset is a pixel out at the bottom
                        and right - it left a sliver of slide showing below the
                        border rather than a clean edge.
                    */
                    using var red = new SolidBrush(Color.FromArgb(0xC4, 0x31, 0x4B));
                    var b = Math.Min(BorderWidth, Math.Min(w, h) / 2);
                    g.FillRectangle(red, left, top, w, b);
                    g.FillRectangle(red, left, top + h - b, w, b);
                    g.FillRectangle(red, left, top + b, b, h - 2 * b);
                    g.FillRectangle(red, left + w - b, top + b, b, h - 2 * b);
                }
            }
            return slot;
        }
        catch (Exception ex)
        {
            // The slot is built before it is returned, so an exception part-way
            // through leaves one behind - a leak of exactly the thing being
            // allocated most often.
            composed?.Dispose();
            Console.Error.WriteLine($"slide capture failed: {ex.Message}");
            return null;
        }
    }

    /// <summary>
    /// The scratch bitmap PrintWindow draws the whole window into, kept between
    /// captures.
    ///
    /// It is the size of the Teams window - around 14 MB at the sizes people
    /// actually present at - and a fresh one per capture put that straight onto
    /// the large object heap several times a second while a pen was in hand.
    /// Reused while the window keeps its size, and replaced when it does not.
    ///
    /// Captures are serialised through the sidecar's work queue, so this is
    /// only ever touched by one of them at a time; the lock is there to keep
    /// that true if that ever stops being the case.
    /// </summary>
    private static Bitmap WindowBuffer(int width, int height)
    {
        lock (BufferLock)
        {
            _bufferUsedAt = Environment.TickCount64;

            if (_buffer is not null && _buffer.Width == width && _buffer.Height == height) return _buffer;

            _buffer?.Dispose();
            _buffer = new Bitmap(width, height, PixelFormat.Format32bppArgb);
            return _buffer;
        }
    }

    /// <summary>
    /// Hands the window buffer back once captures stop.
    ///
    /// Keeping it costs about 14 MB for as long as the sidecar runs, which is
    /// the whole session - worth paying while a presenter is drawing on a
    /// slide and not worth paying for the hours either side. Reusing it and
    /// then releasing it when it goes quiet is cheaper than both the
    /// allocate-every-time it replaced and the keep-it-forever it would
    /// otherwise become.
    /// </summary>
    public static void TrimBuffer(long idleMs)
    {
        lock (BufferLock)
        {
            if (_buffer is null) return;
            if (Environment.TickCount64 - _bufferUsedAt < idleMs) return;

            _buffer.Dispose();
            _buffer = null;
        }
    }

    private static Bitmap? _buffer;
    private static long _bufferUsedAt;
    private static readonly object BufferLock = new();

    /// <summary>
    /// PNG, base64, with the mime type declared - which is the only form a
    /// touch-strip pixmap accepts.
    /// </summary>
    private static string Encode(Bitmap bitmap)
    {
        using var buffer = new MemoryStream();
        bitmap.Save(buffer, ImageFormat.Png);
        return $"data:image/png;base64,{Convert.ToBase64String(buffer.ToArray())}";
    }

    /// <summary>
    /// A fade frame, as JPEG.
    ///
    /// Every frame crosses the websocket to Stream Deck, and a photographic
    /// 200x100 PNG is several times the size of the same frame as JPEG. The
    /// frames are on screen for a few tens of milliseconds each on their way to
    /// the real capture, which is still sent as PNG.
    /// </summary>
    private static string EncodeJpeg(Bitmap bitmap)
    {
        using var buffer = new MemoryStream();

        if (JpegCodec is null)
        {
            bitmap.Save(buffer, ImageFormat.Jpeg);
        }
        else
        {
            using var parameters = new EncoderParameters(1);
            parameters.Param[0] = new EncoderParameter(Encoder.Quality, 70L);
            bitmap.Save(buffer, JpegCodec, parameters);
        }

        return $"data:image/jpeg;base64,{Convert.ToBase64String(buffer.ToArray())}";
    }

    /// <summary>Looked up once; the lookup walks every installed encoder.</summary>
    private static readonly ImageCodecInfo? JpegCodec =
        ImageCodecInfo.GetImageEncoders().FirstOrDefault(c => c.FormatID == ImageFormat.Jpeg.Guid);
}
