# Laser Studio ↔ Amethyst VJ

[Amethyst](https://github.com/westeriann/amethyst) is our sister project: a Windows VJ app for MilkDrop
presets (C++, libprojectM, SDL2, ImGui). Laser Studio does lasers; Amethyst does video. They're meant to run
side by side at the same show and eventually talk to each other. Keep the two consistent: same names for the
same ideas, compatible defaults, and ports that don't collide.

## What Laser Studio has taken from Amethyst

| Laser Studio | Amethyst source | Notes |
|---|---|---|
| `src/core/live.ts`: bands with auto-gain | `src/app/03_audio_outputs.inc` (`pumpAudio`) | Same band filters (~150 Hz / ~2 kHz splits) and peak-follower AGC (≈11 s decay, 0.01 floor). |
| `src/core/live.ts`: tempo & phase | `src/tempo.cpp` | Direct port: 10 ms onset hops, band-wise log-energy flux, ACF scoring with harmonic/sub-harmonic weights, score accumulation over ~8 s, prior centred on 140 BPM, stricter switching to *related* tempos once locked, comb phase estimate eased 35 %. Locks 174 for DnB instead of 87 (tested). |
| `src/core/live.ts`: kick / snare / hat hits | `src/structure.cpp` (`percStep`) | Same hat (2× HP ~7 kHz) and snare (2× HP ~1 kHz + LP ~4 kHz) bands, "jump over own recent average" detection, snare ignored when the kick jumps at the same time. |
| `src/core/react.ts`: audio reactions | `src/app/04_live_features.inc` (modulation routes) | Source → target routes with an amount, plus one-click starters (Amethyst: "kick → zoom pulse, hats → RGB split"). |
| `src-tauri/src/audio_in.rs`: system audio | `src/audio.cpp` (miniaudio loopback) | "What you hear" capture with no share dialog. Laser Studio uses cpal (WASAPI loopback on Windows). |
| `src/core/generate.ts`: song sections | `src/structure.h` (`MusicStructure::Section`) | Same vocabulary: Intro, Groove, Build, Drop, Breakdown (Laser Studio adds Outro; Amethyst adds Silence and Fakeout). Keep new section names in sync. |

## Ideas from Amethyst still to bring over

- **Ableton Link** (Amethyst `tempo.cpp`): shared tempo/phase with DJ software and *with each other*. Top priority for interconnection; needs a Rust Link binding (e.g. `rusty_link`).
- **Phone web remote** (Amethyst `net.cpp`, `remote_page.h`, port 8080).
- **StageLinQ** DJ link (Denon Engine OS: on-air deck BPM/beat, track changes). Amethyst has a working implementation (`stagelinq.cpp`) built from the open protocol docs.
- **Vocal detection** (`structure.cpp` vocal band): calm effects while someone sings.
- **Fakeout drop detection** and **build-up tease** (`07_auto_mix.inc`): useful for the song-to-show generator.
- **Show safety watchdog** (`11_safety.inc`): for lasers this would be scan-fail / audience-zone safety.
- **Visual keyboard / MIDI templates** (Launchpad, APC40) with LED feedback.
- **Offline render to MP4** (`08_render.inc`): frame-exact, faster than real time.
- **Scenes that morph over N beats**: Laser Studio's morph crossfades are timed in seconds; consider beats.

## Interconnection plan

| Channel | Amethyst | Laser Studio | Plan |
|---|---|---|---|
| OSC in | UDP **9000**, `/amethyst/<action> [value]` | UDP **9001** (default for new shows), `/ls/...` | Distinct ports so both can listen on one PC. Next: Laser Studio sends `/amethyst/...` on cue/section changes (and vice versa) so one operator drives both. |
| Web remote | HTTP **8080** | — | When Laser Studio gets a phone remote, use another port (e.g. 8081). |
| Tempo | Auto / Tap / **Ableton Link** / StageLinQ | Song grid / live tracker / tap | Add Ableton Link to Laser Studio; then both follow one beat clock. |
| Art-Net | Output: fixtures take colours from slices of the video | Output: 10-channel laser profile per fixture | Use different universes by default. An option for lasers to follow Amethyst's palette could come later. |
| Song structure | Live `MusicStructure` events (drop, build, breakdown…) | Offline song map + live tracker | Shared vocabulary already; broadcasting live section events over OSC would let either app follow the other's analysis. |
