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
| `gallery-1-live-state.png` | Gallery 1 of 6 | 1920 × 960 PNG |
| `gallery-2-meeting-controls.png` | Gallery 2 of 6 | 1920 × 960 PNG |
| `gallery-3-presenting.png` | Gallery 3 of 6 | 1920 × 960 PNG |
| `gallery-4-watching.png` | Gallery 4 of 6 | 1920 × 960 PNG |
| `gallery-5-profiles.png` | Gallery 5 of 6 | 1920 × 960 PNG |
| `gallery-6-no-meeting.png` | Gallery 6 of 6 | 1920 × 960 PNG |
| `demo.mp4` | Gallery video | 1920 × 1080 MP4, under 250 MB |

Elgato requires three gallery items and allows up to ten. Six is the point at
which the two halves of the plugin — meetings and PowerPoint Live — are both
shown in both roles, without repeating a layout.

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

Full PowerPoint Live control too. Watching a deck? Move through slides at your own pace, jump back in sync, open grid view, or pop the deck into its own window, without touching anyone else's view. Presenting? Slide navigation, laser pointer, pen, highlighter and eraser, presenter view, private view and stop sharing, with a live slide counter on the key. Keys follow your role, so taking control re-lights the deck for presenting.

On a Stream Deck + XL the dials set ink color and thickness, move through the deck and run the meeting timer, and the touch strip shows the current and next slide.

Three bundled profiles can follow the meeting: meeting controls when you join, attendee or presenter tools when a deck goes up, and back again when it ends.

Teams does not need to be in focus and is never pulled to the front, so you can keep working while you mute, react or raise your hand. No keystrokes are sent, so nothing leaks into the window you are typing in, and no global hotkeys are taken.

Keys dim when no meeting is running, so there is nothing to press by mistake.

Requires Windows 10 or later, Stream Deck 7.1 or later, and the Microsoft Teams desktop app. Windows only. Not affiliated with or endorsed by Microsoft.
```

1,486 characters, within the 1,500 limit and above the 250 minimum. The opening
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

### Version 1.9.0 — the notes for this submission

Submitted after 1.8.3 is live, so these describe only what changed on top of it.
Everything about PowerPoint Live and the profiles is in the notes below, which
is what people will already have.

```
Stream Deck + XL support.

The + XL gets its own layouts, laid out for nine columns. The four leftmost columns are the meeting and stay put whether or not anyone is presenting, so mute never moves out from under your finger.

The dials and touch strip cover the parts of a presentation a key cannot show. One dial sets ink thickness and another runs through the pen or highlighter's colors, both acting on whichever tool you have selected in Teams. Turn the slide dial to move through the deck, and press it for grid view.

The meeting timer gets a dial too: press to start or pause it, hold to reset it, with the time left and a bar that drains as it runs.

The touch strip can show the slide you are presenting and the one coming next, and the slide counter key can show the current slide above its count.

Slide pictures are off until you switch them on, per control. They are copied from the Teams window straight to your Stream Deck and go nowhere else: nothing is uploaded, saved to disk, or written to any log.

The 15-key layouts are unchanged. Stream Deck will ask whether to install the updated + XL profile; decline it and everything else still works.
```

1,157 characters.

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
- [ ] The **Media** tab carries all six gallery items, not the original three.

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
