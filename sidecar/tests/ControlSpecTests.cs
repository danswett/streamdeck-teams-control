using System.Text.RegularExpressions;
using TeamsBridge;
using Xunit;

namespace TeamsBridge.Tests;

/// <summary>
/// selectors.json is the documented way to adapt the plugin to a Teams change
/// or a non-English UI, so it is edited by hand by people who cannot run a
/// debugger. These cover what happens when that edit is wrong.
/// </summary>
public class ControlSpecTests
{
    [Fact]
    public void Validate_accepts_a_well_formed_pattern()
    {
        var spec = new ControlSpec { AutomationId = "microphone-button", ActivePattern = "^unmute" };
        Assert.Null(spec.Validate());
    }

    [Fact]
    public void Validate_accepts_a_spec_with_no_patterns_at_all()
    {
        Assert.Null(new ControlSpec { AutomationId = "hangup-button" }.Validate());
    }

    [Theory]
    [InlineData("activePattern", "^[unclosed")]
    [InlineData("inactivePattern", "(unbalanced")]
    [InlineData("menuItemName", "*leading-quantifier")]
    [InlineData("menuItemOffName", "a{2,1}")]
    public void Validate_names_the_field_that_is_wrong(string field, string pattern)
    {
        var spec = new ControlSpec { AutomationId = "x" };
        switch (field)
        {
            case "activePattern": spec.ActivePattern = pattern; break;
            case "inactivePattern": spec.InactivePattern = pattern; break;
            case "menuItemName": spec.MenuItemName = pattern; break;
            case "menuItemOffName": spec.MenuItemOffName = pattern; break;
        }

        var problem = spec.Validate();

        Assert.NotNull(problem);
        Assert.StartsWith(field + ":", problem);
    }

    [Fact]
    public void Patterns_are_case_insensitive_because_Teams_capitalisation_varies()
    {
        var spec = new ControlSpec { AutomationId = "x", ActivePattern = "^unmute" };
        Assert.Matches(spec.ActiveRegex!, "Unmute mic");
    }

    [Fact]
    public void Patterns_carry_a_match_timeout_so_backtracking_cannot_wedge_the_worker()
    {
        var spec = new ControlSpec { AutomationId = "x", ActivePattern = "^unmute" };
        Assert.Equal(ControlSpec.MatchTimeout, spec.ActiveRegex!.MatchTimeout);
        Assert.True(ControlSpec.MatchTimeout > TimeSpan.Zero);
        Assert.True(ControlSpec.MatchTimeout < TimeSpan.FromSeconds(1));
    }

    [Fact]
    public void A_pathological_pattern_times_out_rather_than_running_forever()
    {
        // Nested quantifiers over a long non-matching subject: the classic
        // catastrophic-backtracking shape a localiser could write by accident.
        var rx = new Regex("^(a+)+$", RegexOptions.IgnoreCase, ControlSpec.MatchTimeout);
        var subject = new string('a', 40) + "!";

        var sw = System.Diagnostics.Stopwatch.StartNew();
        Assert.Throws<RegexMatchTimeoutException>(() => rx.IsMatch(subject));
        sw.Stop();

        // Bounded, not merely "it threw eventually".
        Assert.True(sw.Elapsed < TimeSpan.FromSeconds(5), $"took {sw.Elapsed}");
    }

    [Fact]
    public void An_empty_pattern_compiles_to_no_regex_rather_than_matching_everything()
    {
        var spec = new ControlSpec { AutomationId = "x", ActivePattern = "", InactivePattern = "   " };
        Assert.Null(spec.ActiveRegex);
        Assert.Null(spec.InactiveRegex);
    }
}
