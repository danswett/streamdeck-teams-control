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
| `gallery-1-live-state.png` | Gallery 1 of 3 | 1920 × 960 PNG |
| `gallery-2-actions.png` | Gallery 2 of 3 | 1920 × 960 PNG |
| `gallery-3-no-meeting.png` | Gallery 3 of 3 | 1920 × 960 PNG |

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

Full PowerPoint Live control too. Watching a deck? Move through slides at your own pace, jump back in sync with the presenter, open grid view, zoom, or translate the slides into 20 languages — all without touching anyone else's view. Presenting? Slide navigation, laser pointer, pen, highlighter and eraser, presenter view, private view, layout and stop sharing, with a live slide counter on the key. Keys follow your role, so taking control mid-meeting re-lights the deck for presenting.

Teams does not need to be in focus and is never pulled to the front, so you can keep working while you mute, react or raise your hand. No keystrokes are sent, so nothing leaks into the window you are actually typing in, and no global hotkeys are taken.

Keys dim when no meeting is running, so there is nothing to press by mistake, and light up the moment a call starts.

Requires Windows 10 or later, Stream Deck 7.1 or later, and the Microsoft Teams desktop app. Windows only — macOS is not supported. Not affiliated with or endorsed by Microsoft.
```

1,294 characters, within the 1,500 limit and above the 250 minimum. The opening
two sentences run to 252 characters, so the search-engine snippet reads as
complete sentences rather than breaking mid-clause.

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

For the **first** Marketplace version, use the notes below rather than the
GitHub release notes — those describe changes against a previous build, which a
new Marketplace user has never seen.

```
First release.

Control Microsoft Teams meetings from your Stream Deck, with every key showing the live state of the call.

Thirteen actions: mute, camera, raise hand, five reactions (like, love, applause, laugh, wow), background blur, screen share, chat, people, and leave.

LIVE STATE
Keys mirror Teams rather than guessing. A muted microphone shows the muted icon before you press anything, and a change you make in Teams itself reaches the keys in about a third of a second. Every key dims when no meeting is running, so there is nothing to press by mistake, and lights up the moment a call starts.

STAYS OUT OF YOUR WAY
Teams never needs to be in focus and is never pulled to the front, so you can mute, react or raise your hand without losing your place in whatever you are working in. No keystrokes are sent, so nothing leaks into the window you are actually typing in, and no global hotkeys are reserved.

Reactions and raise hand animate when pressed, the way they do in Teams.

REQUIREMENTS
Windows 10 or later, Stream Deck 7.1 or later, and the Microsoft Teams desktop app. Windows only; macOS is not supported.

Not affiliated with or endorsed by Microsoft.
```

1,170 characters, within the 1,500 limit.

For **subsequent** versions, use the notes from the matching GitHub release,
which describe what changed:
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
- [ ] Decide on the trademark question below.
- [ ] `npm run test` passes and CI is green on the commit being shipped.
- [ ] The `.streamDeckPlugin` uploaded is the one the release workflow built.

### Trademark

"Teams" is Microsoft's trademark, and Elgato's guidelines say a product name
must not infringe one. Naming a plugin after the application it controls is
normal and is nominative use, but it is a judgement call that Elgato makes at
review, not one this repository can settle. The description states plainly that
the plugin is not affiliated with or endorsed by Microsoft, no Microsoft logo or
proprietary artwork is bundled, and the icons come from Microsoft's MIT-licensed
Fluent sets.

If Elgato asks for a change, the name can only be changed by emailing
maker@elgato.com after creation — so it is worth being comfortable with it
before the first submission.
