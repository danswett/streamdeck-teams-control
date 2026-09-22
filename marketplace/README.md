# Marketplace submission

Everything Maker Console asks for, kept beside the product so a submission can
be reproduced rather than reassembled from memory.

Regenerate the images with:

```bash
node tools/generate-marketplace.ts
```

They are rendered from the same glyph set the keys use, so the listing always
shows the artwork that actually ships.

| File | Purpose | Required size |
|---|---|---|
| `app-icon-288.png` | App icon | 288 × 288 PNG |
| `thumbnail.png` | Thumbnail | 1920 × 960 PNG |
| `gallery-1-live-state.png` | Gallery 1 of 7 | 1920 × 960 PNG |
| `gallery-2-meeting-controls.png` | Gallery 2 of 7 | 1920 × 960 PNG |
| `gallery-3-presenting.png` | Gallery 3 of 7 | 1920 × 960 PNG |
| `gallery-4-watching.png` | Gallery 4 of 7 | 1920 × 960 PNG |
| `gallery-5-profiles.png` | Gallery 5 of 7 | 1920 × 960 PNG |
| `gallery-6-decks.png` | Gallery 6 of 7 | 1920 × 960 PNG |
| `gallery-7-no-meeting.png` | Gallery 7 of 7 | 1920 × 960 PNG |
| `demo.mp4` | Gallery video | 1920 × 1080 MP4, under 250 MB |

Elgato requires three gallery items and allows up to ten. Seven is the point at
which the two halves of the plugin — meetings and PowerPoint Live — are both
shown in both roles, without repeating a layout, and a reader can find their own
deck in the set.

The deck item draws the grids rather than listing seven product names, because
the shapes are recognizable at a glance and the list is not. It is generated
from the same `tools/decks.ts` table the layouts are built from, so it cannot
advertise a deck the plugin does not ship a layout for.

The video is generated too, by `node tools/build-demo-frames.ts` followed by
the ffmpeg line it prints. Every key in it is drawn by the same functions the
plugin uses, so it cannot show artwork the product does not ship. It contains
no Teams interface on purpose: that artwork is Microsoft's, and a mock-up of it
would go stale on their release schedule rather than ours.

Product file: `dist/com.bad-duck.teamscontrol.streamDeckPlugin`, built by
`npm run pack` and attached to every GitHub release by the release workflow.

---

## Name

```
Teams Meeting Controls
```

22 characters. No maker name, no price wording, no product category, no special
characters — see [product guidelines](https://docs.elgato.com/guidelines/products).

## Description

The first 250 characters are what search engines show, so the opening sentences
carry the requirements and the differentiator rather than a preamble.

```
Control Microsoft Teams meetings from your Stream Deck: mute, camera, raise hand, the five reactions, background blur, screen share, chat, people and leave. Every key shows the real state of the meeting, so a muted mic looks muted before you press it.

Full PowerPoint Live control too. Watching a deck? Move through slides at your own pace, jump back in sync, open grid view, or pop the deck into its own window, without touching anyone else's view. Presenting? Slide navigation, laser pointer, pen, highlighter and eraser, presenter view, private view and stop sharing, with a live slide counter. Keys follow your role, so taking control re-lights the deck.

On a Stream Deck + or + XL the dials set ink color and thickness, move through the deck and run the meeting timer, and the touch strip shows the current and next slide.

Three bundled profiles can follow the meeting: meeting controls when you join, attendee or presenter tools when a deck goes up, and back again when it ends. Every Stream Deck gets its own set, laid out for its grid.

Teams never needs focus and is never pulled to the front, so you can keep working while you mute, react or raise your hand. No keystrokes are sent, so nothing leaks into whatever you are typing in, and no global hotkeys are taken.

Keys dim when no meeting is running, so there is nothing to press by mistake.

Requires Windows 10 or later, Stream Deck 7.1 or later, and the Microsoft Teams desktop app. Not affiliated with or endorsed by Microsoft.
```

1,497 characters, within the 1,500 limit and above the 250 minimum. The opening
two sentences run to 251 characters, so the search-engine snippet reads as
complete sentences rather than breaking mid-clause.

Character counts are asserted by `tests/marketplace.test.ts`, which also checks
that the copy does not name a control the plugin no longer ships — an earlier
version of this description advertised a zoom key months after it was removed,
and claimed 20 translation languages when 19 ship plus an off switch.

## Tags

`teams`, `microsoft teams`, `meetings`, `mute`, `camera`, `video call`,
`conferencing`, `work from home`, `productivity`, `windows`, `powerpoint`,
`presentation`, `slides`

## Identity

These must agree, because the `Author` field is shown in both Stream Deck and
Marketplace, and Elgato's guidelines ask for the organization name.

| Where | Value |
|---|---|
| Maker organization | Bad Duck Software |
| Marketplace handle | `@badduck` |
| Marketplace listing | https://marketplace.elgato.com/product/teams-meeting-controls-cd033891-69c4-4ee7-95e5-f07773b6fb95 |
| Product ID | `cd033891-69c4-4ee7-95e5-f07773b6fb95` |
| Manifest `Author` | `Bad Duck Software` |
| Manifest `URL` | https://bad-duck.com |
| Manifest `SupportURL` | https://github.com/danswett/streamdeck-teams-control/issues |
| Plugin UUID | `com.bad-duck.teamscontrol` |
| Support email (Maker Console) | support@bad-duck.com |

The UUID is reverse-DNS on the organization's own domain. **It cannot be changed
once the plugin is published** — Elgato's guidelines list changing a UUID after
publishing as something not to do — so it was settled before the first
submission rather than after.

`URL` is the organization's site, not the Marketplace listing and not the
repository. The [manifest schema](https://schemas.elgato.com/streamdeck/plugins/manifest.json)
defines it as "Link to the plugin's website" and gives `https://elgato.com` and
`https://corsair.com` as the examples; Elgato's own plugins follow that. Linking
back to Marketplace would be circular, because the field is surfaced inside
Stream Deck to someone who has already installed the plugin. Bug reports belong
on `SupportURL` instead, and a domain we control can be repointed without
shipping a new version.

## Additional links

| Label | URL |
|---|---|
| Website | https://bad-duck.com |
| Source code | https://github.com/danswett/streamdeck-teams-control |
| Support | https://github.com/danswett/streamdeck-teams-control/issues |
| Privacy | https://github.com/danswett/streamdeck-teams-control#privacy |

## Pricing

Free.

## Release notes

The product is **published**, so a submission is a new version of an existing
listing rather than a first publication. Use the version notes below; they
describe what changed, which is what an existing user opens the listing to find
out.

The first-release notes are kept further down for reference only — they describe
the plugin from scratch, which is the right shape for a first publication and
the wrong shape now.

### Version 1.9.9 — the notes for this submission

Submitted to fix what review asked for on 1.8.2: the icons in the Stream Deck
app's action list have to be white, and five of ours were not.

The PowerPoint Live drawing tools — laser pointer, pen, highlighter, eraser,
cursor — drew Teams' own artwork there, in Teams' own colors. That was a
deliberate choice and the wrong one: a red pen and a yellow highlighter read
well on a key, where the guidelines allow color, and read as a rule being
broken in a list that is meant to be monochrome. They now use plain white
Fluent glyphs in the list. The keys are untouched, so nothing on the deck
looks any different.

Two smaller things came out of the same pass. The ink colour and ink thickness
dials had borrowed the pen and the highlighter for their list icons, which put
four entries in the list as two pairs of identical marks; they now have a
palette and a stack of lines. And the laser pointer's white stand-in was a
small filled dot, chosen back when Fluent had no laser glyph — it has one, at
the same 20px tier PowerPoint Live's own toolbar is drawn at, so it uses that.

The rule is now checked rather than remembered: `tests/marketplace.test.ts`
rasterises every category and action icon and fails on any colour other than
white, on a solid background, or on a blank icon. It reads pixels, not markup,
because the icons that broke the rule were PNGs with no markup to read.

```
Housekeeping, at Elgato's request.

The five PowerPoint Live drawing tools showed Teams' coloured artwork in the Stream Deck app's action list, where the guidelines ask for plain white icons. They now match the rest of the list. The keys on your deck are unchanged, and so is everything the plugin does.
```

317 characters.

### Version 1.9.8 — submitted

One thing, and it is the thing people notice: the deck used to take about ten
seconds to catch up when you joined a meeting.

Two separate waits, both of them fixed sleeps standing in for a signal nobody
had gone looking for. A meeting window opening raises an event, but Teams builds
that window's accessibility tree only once something asks for it, so the single
look that event triggered arrived before there was anything to find — and the
next look was fifteen seconds away. And each deck's profile change was followed
by a sleep long enough to cover the worst case, so a second deck sat three and a
half seconds behind the first, or nine seconds on the first meeting after the
plugin restarted.

Both now wait for the thing itself rather than for a timer. Joining is measured
at about 4.3 seconds end to end, most of which is Teams building its own tree,
and both decks change together. Leaving a meeting hands the decks back almost
at once, where it used to take three and a half seconds a deck.

Nothing about this is configurable and nothing about it changed what the keys
do, which is why the copy below says none of it.

```
Your deck keeps up with the meeting now.

Joining a meeting used to take about ten seconds to reach the keys, and if you use two Stream Decks the second one lagged several seconds behind the first. Both now change as the meeting starts, and hand themselves back the moment you leave.

Profile switching is still off until you turn it on, in any key's settings.
```

360 characters.

### Version 1.9.7 — submitted
No new actions and no profile changed, so by the 1.9.5 test this looks like a
release with nothing to advertise. It is the opposite. Two of the things the
listing already promises were not actually true, and now are.

Pressing a reaction while presenting through PowerPoint Live could advance the
deck — for everyone watching, if you were the one presenting. Closing the
reactions flyout posts a click at a spot picked to be inert, and the slide
surface was excluded by asking the accessibility tree where it was. Opening a
flyout removes the slide-show subtree from that tree, so at the one moment the
exclusion was needed it found nothing and the click landed on the slide.
Measured: the deck moved from slide 5 to 6. The plugin no longer posts that
click at all while a deck is up; the flyout is closed by asking the menu to
collapse itself, which has no side effect.

Separately, the keys could go grey during a meeting that was still running, and
stay that way. Teams builds its accessibility tree only while something is using
it and takes it down again afterwards; the plugin woke it once per window and
never again, so when it went back to sleep the meeting was lost for good.

The rest is speed. A reaction press now returns in about a quarter of the time,
the state behind every key is read roughly ten times faster, and sitting outside
a meeting costs about a twentieth of what it did.

```
Reactions no longer move your slides.

If you pressed a reaction while presenting through PowerPoint Live, the plugin could advance your deck — for everyone watching. It does not any more.

Two other fixes worth knowing about. The keys could go grey in the middle of a meeting that was still running, and stay grey until you restarted; that is fixed. And a reaction that worked once and then did nothing for the rest of the meeting now works every time.

Everything is quicker as well: reactions land about four times faster, the keys follow what you do in Teams about ten times faster, and the plugin is far lighter when you are not in a meeting at all.
```

654 characters.

### Version 1.9.6 — submitted

The first release since 1.9.4 with anything a user can see, so it carries 1.9.5
with it. 1.9.5 was tagged and built but deliberately not submitted: nothing in it
was user-visible.

What changed is small and worth saying plainly. Profile switching existed in
1.9.4 and almost nobody could find it, because the setting only appeared in the
PowerPoint Live keys' settings — so anyone who had placed a mute key and nothing
else had no way to discover the feature existed. It is the same setting, still
off until you turn it on, now visible from nearly every key in the plugin.

Deliberately not changed: it stays **off by default**. Moving someone's deck
between profiles without being asked is delightful once and infuriating
afterwards, and an update should not start doing it to people who never opted in.

```
Profile switching is easier to find.

The plugin can move your deck between its three layouts as a meeting goes — Teams Meeting when you join, PowerPoint Live when a deck goes up, and back to your own profile when you leave. That setting used to appear only in the PowerPoint Live keys' settings, so if you had placed a mute key and nothing else, you would never have known it was there. It now appears on nearly every key in the plugin.

It is still off until you switch it on, and it still hands your deck back when you turn it off or leave a meeting.

Also includes the 1.9.5 build, which had no user-visible changes.
```

620 characters.

### Version 1.9.5 — tagged and built, deliberately not submitted

Nothing in it is user-visible. The action list is identical to 1.9.4 (38 before,
38 after, same UUIDs), no profile changed, and the one new capability —
[Direct mode](../docs/direct-mode.md) — is off by default and cannot be turned on
from the plugin at all: it requires the user to open a local debugging port on
Teams themselves, which the plugin never does.

So there is nothing here for a listing to advertise, and two reasons not to:
submitting asks a reviewer to re-review a build with no change they can see, and
the only way to describe the feature honestly involves the words "local
debugging port", which do not belong in consumer listing copy for something
almost no one should switch on.

Fold it into the next submission that does carry user-visible change. The
internal audience for Direct mode is served by the repo doc instead.

### Version 1.9.4 — submitted

Submitted after 1.8.3 was live, so these describe only what changed on top of it.
Everything about PowerPoint Live and the meeting keys is in the notes below,
which is what people will already have.

1.9.0 through 1.9.3 were tagged and built on GitHub but never submitted here, so
their changes are folded into these notes rather than split across five entries.

The last paragraph is not decoration. The two 15-key PowerPoint Live layouts
changed, and Stream Deck cannot update a profile in place — anyone who already
has them keeps the old copy alongside the new one, and will want to know which
is which.

```
Every Stream Deck now has its own layouts.

Mini, Stream Deck, +, Neo, XL and + XL each get three profiles built for their own grid: meeting controls when you join, attendee or presenter tools when a deck goes up, and back again when it ends. Mute is on every one of them, so being moved onto a presentation layout never costs you it.

Slide navigation is laid out the same way everywhere: previous, the slide counter, then next, side by side on the bottom row, where your hand finds them without looking. On the wider decks the meeting keys stay put across all three layouts, so mute never moves out from under the finger reaching for it.

The dials on a + and a + XL set ink thickness and color for whichever drawing tool you have picked, move through the deck, and run the meeting timer. The touch strip shows the slide you are presenting and the one coming next, and the slide counter key can show the current slide above its count.

Slide pictures are off until you switch them on, per control. They are copied from the Teams window straight to your Stream Deck and go nowhere else: nothing is uploaded, saved to disk, or written to any log.

If you already use the 15-key PowerPoint Live profiles, the redesigned ones arrive named "r2" and are used automatically. The originals stay in your profile list until you delete them.
```

1,332 characters.

### Version 1.9.3 — tagged and built, never submitted

Folded into the 1.9.4 notes above.

### Version 1.9.2 — tagged and built, never submitted

Folded into the 1.9.3 notes above.

### Version 1.9.1 — tagged and built, never submitted

Folded into the 1.9.3 notes above.

### Version 1.8.3 — submitted, in review

Described only what changed on top of 1.8.2.

```
Matches the icon shown on this page.

The plugin icon inside Stream Deck was still the one from before PowerPoint Live, so this page and the installed plugin showed different marks. Both are now drawn from the same source and cannot drift apart again.

The plugin's own description, which Stream Deck shows and search engines index, now mentions PowerPoint Live instead of describing a meetings-only plugin.

No keys changed, and nothing about how the plugin works changed.
```

473 characters.

### Version 1.8.2 — submitted, in review

Marketplace shows plain text, so this is the GitHub release rewritten for
someone who has the plugin installed but has never read a commit.

```
PowerPoint Live control, and profiles that follow the meeting.

POWERPOINT LIVE
Twenty new keys for a shared deck, and they follow whichever role you are in.

Watching someone present: move through the slides at your own pace without touching anyone else's view, jump back to the presenter whenever you want, open grid view, switch to high contrast, pop the deck into its own window, or take control of it.

Presenting: previous and next, laser pointer, pen, highlighter, eraser and cursor, presenter view, private viewing, present the latest saved version, copy a link to the deck, change layout, and stop sharing. A live slide counter sits on its own key, and the ink keys show the color you picked in Teams.

Take control mid-meeting and the deck re-lights itself for presenting.

PROFILES THAT FOLLOW THE MEETING
Three bundled profiles move the deck for you: meeting controls when you join, attendee or presenter tools the moment a deck goes up, back to meeting controls when it ends, and back to your own profile when you leave. Nothing to press.

Turn it on with "Follow the meeting between profiles" on any PowerPoint Live key. 15-key Stream Decks.

The thirteen meeting keys are unchanged.

REQUIREMENTS
Windows 10 or later, Stream Deck 7.1 or later, and the Microsoft Teams desktop app. Windows only.
```

1,310 characters, within the 1,500 limit. It covers only what is new to
someone upgrading: the thirteen meeting keys have not changed since the
published version, so there are no fixes to report to a Marketplace user.

### First-release notes — reference only

Used for the original publication. Kept because a listing that is ever recreated
from scratch needs this shape rather than a changelog.

```
First release.

Control Microsoft Teams meetings and PowerPoint Live from your Stream Deck, with every key showing the live state of the call.

MEETINGS
Mute, camera, raise hand, five reactions (like, love, applause, laugh, wow), background blur, screen share, chat, people, and leave.

POWERPOINT LIVE
Watching a deck: move through slides at your own pace, jump back in sync with the presenter, grid view, high contrast, pop out, and take control.

Presenting: laser pointer, pen, highlighter, eraser, cursor, presenter view, private view, present the latest version, copy link, layout, and stop sharing, with a live slide counter on the key.

Keys follow your role, so an attendee never sees presenter tools.

LIVE STATE
Keys mirror Teams rather than guessing. A muted microphone shows the muted icon before you press anything, and a change you make in Teams itself reaches the keys in about a third of a second. Every key dims when no meeting is running, so there is nothing to press by mistake.

PROFILES
Three bundled profiles can move the deck on their own as a meeting goes, and back to your own profile when you leave. 15-key decks.

STAYS OUT OF YOUR WAY
Teams never needs to be in focus and is never pulled to the front. No keystrokes are sent, and no global hotkeys are reserved.

REQUIREMENTS
Windows 10 or later, Stream Deck 7.1 or later, and the Microsoft Teams desktop app. Windows only.

Not affiliated with or endorsed by Microsoft.
```

1,449 characters, within the 1,500 limit. It describes the plugin as it stands
rather than what changed, because a first-time reader has no previous build to
compare against.

For the changelog behind these notes, see the matching GitHub release:
https://github.com/danswett/streamdeck-teams-control/releases
---

## Publishing a new version

There are two separate publishes, and only the first is automated.

**1. GitHub — automated.** `.github/workflows/release.yml` runs on any `v*`
tag. It installs from the lockfile, runs both unit suites, builds the sidecar
and the plugin, validates the manifest, packages the `.streamDeckPlugin`, checks
the tag against the manifest version, and attaches the package to the GitHub
release.

```bash
# 1. bump "Version" in com.bad-duck.teamscontrol.sdPlugin/manifest.json
#    Stream Deck wants four parts, for example 1.5.0.0
# 2. commit it
git tag -a v1.5.0 -m "v1.5.0" && git push origin v1.5.0
```

The tag check is the point of that step: a `v1.5.0` tag on a manifest still
saying `1.4.0.0` fails the run instead of shipping a build whose release notes
describe something else. Re-running a tag that already exists is possible
through the workflow's `workflow_dispatch` input.

**2. Marketplace — manual.** Elgato has no public API or CLI for submission;
`@elgato/cli` stops at `pack`. Uploading is done by hand in
[Maker Console](https://maker.elgato.com):

1. **Products** → the product → **Versions** → **Create version**.
2. Upload the `.streamDeckPlugin` attached to the GitHub release, so what
   ships is the artifact CI built rather than a local rebuild.
3. Paste the release notes.
4. Tick **Automatically publish after being approved** unless the release has
   to land on a particular date — if it does, leave it unticked and press
   **Release** in the **Versions** tab once approved.

Review takes **4–10 business days** in busy periods, so a version is not live
the day it is submitted. Only the most recent *approved* version is offered to
users, and metadata and media are versioned separately from the product file —
changing the description or the gallery does not require a new version, and a
new version does not refresh them.

Media and copy changes go through the **Details** and **Media** tabs. The name
and monetization cannot be changed in Maker Console at all; those need an email
to maker@elgato.com.

---

## Before submitting

- [x] A Maker Console account exists and the organization name matches the
      manifest `Author` field — Bad Duck Software, set in 1.5.0.
- [x] The name cleared review at first publication, so the trademark question
      below is settled in practice. It is kept for the reasoning, not as an
      open decision.
- [ ] `npm run test` passes and CI is green on the commit being shipped.
- [ ] The `.streamDeckPlugin` uploaded is the one the release workflow built.
- [ ] The **Details** tab carries the long description from this file. The
      published listing currently shows the 215-character manifest text, which
      is below Elgato's 250-character minimum for a description and says
      nothing about PowerPoint Live.
- [ ] The **Media** tab carries all seven gallery items, not the original three.

Media and copy are versioned separately from the product file, so the two
uploads below are independent: a new version does not refresh the description or
the gallery, and changing those does not require a new version.

### Trademark

"Teams" is Microsoft's trademark, and Elgato's guidelines say a product name
must not infringe one. Naming a plugin after the application it controls is
normal and is nominative use. The name cleared review at first publication,
which settles it in practice, but the reasoning is kept because a name can only
be changed after creation by emailing maker@elgato.com — so a future rename is
expensive and worth avoiding. The description states plainly that
the plugin is not affiliated with or endorsed by Microsoft, no Microsoft logo or
proprietary artwork is bundled, and the icons come from Microsoft's MIT-licensed
Fluent sets.

If Elgato ever asks for a change, it has to go through maker@elgato.com; the
name cannot be edited in Maker Console.
