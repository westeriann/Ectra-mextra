# Laser Studio

A desktop app for designing, programming and playing back **virtual concert laser shows**:
build a venue, hang lasers, design looks, record cues, and sync the whole show to music.
It can also drive real hardware through Art-Net, OSC, MIDI/timecode and Ether Dream laser DACs.

Built with [Tauri 2](https://tauri.app) (Rust backend) and TypeScript + [three.js](https://threejs.org) (UI and 3D).

## Features

**Program** (the default tab)
- 12 beam effects: static fan, fan, sweep, crossfan, wave, chase, cone, tunnel, sheet ("liquid sky"), spiral, scatter, and ILDA shapes.
- Per-effect beams, spread, size, pan/tilt, speed (free-running Hz or locked to the beat), phase spread across lasers, left/right mirroring, colour modes (solid, alternate, gradient, rainbow, ILDA source colours), strobe and audio-reactive intensity.
- A programmer: select lasers (in the list or by clicking them in 3D), change the look live, then **Record new cue** or **Update** an existing one.
- A cue list with crossfade times, GO / Back / Release, drag-to-reorder, duplicate and colour tags.
- 8 **flash pads** for busking: hold (flash) or latch (toggle), each bound to a key and optionally a MIDI note.
- Master fader, blackout and tap tempo.

**Show** (music sync)
- Load MP3/WAV/OGG/FLAC/M4A. The waveform is drawn and the **tempo and downbeat are detected automatically**.
- A timeline with a beat/bar grid, a cue lane and a hits lane (flash / strobe / blackout). Drag to move, snap to the beat, double-click to add, Delete to remove. Ctrl+wheel zooms.
- **Auto-program** lays your cues along the song: calm cues on quiet sections, intense cues on loud ones, flashes on drops.
- **Record live**: arm recording, play the song and fire cues. Your presses are written to the timeline.
- Beat-synced effects lock to the song's grid. The tempo can be fixed by hand (×2, ÷2, "downbeat here").
- Microphone / line-in mode makes effects react to a live DJ when no song is loaded.

**Stage** (venue designer)
- Templates: Club, Arena, Festival Main Stage, Warehouse, Empty Floor.
- Add and edit floors, risers, truss, LED screens (animated, beat-reactive), speaker stacks, crowds (people bounce on the beat), walls and pillars.
- Move things with the 3D gizmo or by dragging on the top-down floor plan. Size, rotation and colour are set in the inspector.
- Place lasers one at a time or as a row. Each has an aim, scan angle, beam limit, power, DMX patch and an optional DAC.
- Haze, house lights and sky colour.

**Setup** (hardware, desktop app only)
- **Art-Net output**: every laser's look is sent as a 10-channel DMX profile (Dimmer, Effect, Pan, Tilt, Size, Speed, R, G, B, Strobe).
- **OSC input**, so TouchOSC, QLab, Companion, Ableton etc. can run the show:

  | Address | Action |
  |---|---|
  | `/ls/go`, `/ls/back` | Next / previous cue |
  | `/ls/cue <n or name>` | Go to a cue |
  | `/ls/pad <n> <0/1>` | Press / release flash pad *n* |
  | `/ls/master <0..1>`, `/ls/blackout <0/1>` | Master, blackout |
  | `/ls/play`, `/ls/pause`, `/ls/stop`, `/ls/seek <s>` | Transport |
  | `/ls/bpm <bpm>`, `/ls/tap` | Tempo |

- **MIDI input** with learn mode for GO, Back, Blackout, Master, Tap, Play and every pad. **MIDI Timecode (MTC) chase** keeps the song locked to a DAW or playback rig.
- **Ether Dream DACs** (experimental): discover DACs on the network and stream each laser's beams as a real scan path.

**Everywhere**
- A fullscreen **output window** for a projector or second screen (double-click for fullscreen, F1–F5 for cameras).
- Camera presets: front of house, in the crowd, side, top down, drone orbit.
- **Record video** of the 3D view, with the music, to WebM.
- Import ILDA (`.ild`) laser graphics: formats 0, 1, 4 and 5.
- Undo/redo, autosave and crash recovery. Shows are saved as readable `.lshow` JSON files.

Press `?` in the app for all keyboard shortcuts.

## Running it

### Prerequisites
- [Node.js](https://nodejs.org) 20+
- [Rust](https://rustup.rs) (stable)
- The Tauri system packages for your OS: <https://tauri.app/start/prerequisites/>
  - **Windows:** WebView2 (preinstalled on Windows 10/11) and the MSVC build tools.
  - **macOS:** Xcode command line tools.
  - **Linux (Debian/Ubuntu):** `sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev libasound2-dev build-essential`

### Develop
```bash
cd laser-studio
npm install
npm run app:dev        # desktop app with hot reload
```
`npm run dev` runs the UI alone in a browser at http://localhost:1420. Everything works there except the hardware outputs and native file dialogs.

### Build an installer
```bash
npm run app:build      # → src-tauri/target/release/bundle/
```
This produces an `.msi`/`.exe` on Windows, a `.dmg`/`.app` on macOS, and `.deb`/`.AppImage`/`.rpm` on Linux. Build on each OS you want to ship for.

### Tests
```bash
npm test                          # effects, engine, timeline, music analysis, ILDA, DMX, show files
cd src-tauri && cargo test        # Art-Net, OSC, MIDI/MTC and Ether Dream protocol encoding
```

## Project layout
```
src/core/       Pure show logic (no DOM): data model, effects, playback engine,
                music analysis, ILDA, DMX mapping, laser scan paths. Unit tested.
src/render/     three.js: instanced beams, stage geometry, viewport/camera/gizmo.
src/ui/         Panels for each tab, the store (undo/autosave) and the controller.
src/platform/   Bridge to the Rust backend, with browser fallbacks.
src-tauri/src/  Rust: file I/O, Art-Net, OSC, MIDI + timecode, Ether Dream.
tests/          Vitest unit tests.
```

## Notes and limitations
- **Ether Dream output follows the published protocol but hasn't been tested on a real DAC yet.** Treat it as experimental.
- Art-Net uses a simple generic profile. Real DMX lasers each have their own channel layout, so you may need to adapt `src/core/dmx.ts` to your fixture.
- Video recording uses the browser's MediaRecorder, so the output is WebM (VP8/VP9).
- **Laser safety:** if you connect real projectors, never scan beams into an audience without proper safety zones, a trained operator and any licence your country requires.
