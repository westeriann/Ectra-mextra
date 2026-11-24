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
- **Morphing crossfades**: by default beams glide from one look into the next and colours blend. Each cue can switch to a classic dissolve instead.
- 8 **flash pads** for busking: hold (flash) or latch (toggle), each bound to a key and optionally a MIDI note.
- Master fader, blackout and tap tempo.

**Show** (music sync)
- Load MP3/WAV/OGG/FLAC/M4A. The waveform is drawn and the **tempo and downbeat are detected automatically**.
- A timeline with a beat/bar grid, a cue lane and a hits lane (flash / strobe / blackout). Drag to move, snap to the beat, double-click to add, Delete to remove. Ctrl+wheel zooms.
- **Automation lanes**: curves for intensity, speed, size, spread, pan, tilt and colour shift, per laser group, with linear, smooth or step segments. Click a lane to add points, drag to move them, double-click to delete. There's also a one-click "8-bar build-up" preset that ramps into the drop.
- **Auto-program** lays your cues along the song: calm cues on quiet sections, intense cues on loud ones, flashes on drops.
- **Record live**: arm recording, play the song and fire cues. Your presses are written to the timeline.
- Beat-synced effects lock to the song's grid. The tempo can be fixed by hand (×2, ÷2, "downbeat here").
- Microphone / line-in mode makes effects react to a live DJ when no song is loaded.

**Stage** (venue designer)
- Templates: Club, Arena, Festival Main Stage, Warehouse, Empty Floor.
- Add and edit floors, risers, truss, LED screens (animated, beat-reactive), speaker stacks, crowds (people bounce on the beat), walls and pillars.
- **Beams stop at solid objects** (screens, walls, risers, speakers, pillars) and leave glowing hit spots where they land. This can be turned off per venue.
- **Mirrors** (rotate and tilt them to bounce beams around the room) and **mirror balls** (each beam that hits one splits into a spinning spray of reflections).
- Tools: **Move (G)**, **Rotate (R)**, which also aims lasers, and **Scale (C)**, with snapping, Focus (F), Duplicate (Ctrl+D) and Delete. Grab any object and drag it in 3D (Shift-drag lifts it), or drag it on the top-down floor plan.
- Drag items from the add buttons straight onto the floor plan or into the 3D view to place them.
- Fly the camera with **WASD**, turn with **Q/E** and look up or down with **Z/X** (Shift = faster).
- Place lasers one at a time or as a row. Each has an aim, scan angle, beam limit, power, DMX patch and an optional DAC.
- Haze, house lights and sky colour.

**Live audio** (🎤 button in the top bar)
- Listen to a microphone or line in. In the desktop app on Windows you can also pick **system audio**, i.e. whatever the PC is playing (Spotify, DJ software), with no microphone needed.
- Auto-levelled bass, mid and treble meters, kick, snare and hi-hat detection, and **live tempo tracking**. Beat-synced effects lock to the music (tap, ×2 and ÷2 to correct it). The analysis is ported from our sister project [Amethyst VJ](https://github.com/westeriann/amethyst); see `docs/AMETHYST.md`.
- **Reactions** work on every look with no per-cue setup: Kick pump, Bass breathes, Hat shimmer, Snare colour, Beat sway and Kick flash. You can also add your own (any sound → brightness, size, spread, tilt, sway, colour or flash).
- While a song plays in the Show tab, the reactions follow the song instead.

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
- A guided tour on first launch (File → Tutorial to see it again).
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
#### Building the Windows installer from Linux
No Windows machine needed. This uses the MinGW toolchain, so nothing is downloaded from Microsoft:
```bash
sudo apt install nsis gcc-mingw-w64-x86-64 g++-mingw-w64-x86-64
rustup target add x86_64-pc-windows-gnu
npx tauri build --target x86_64-pc-windows-gnu --bundles nsis
# → src-tauri/target/x86_64-pc-windows-gnu/release/bundle/nsis/Laser Studio_<version>_x64-setup.exe
```
The installer is unsigned, so Windows SmartScreen will warn on first run (More info → Run anyway). Signing needs a code-signing certificate; see `bundle > windows > signCommand` in the Tauri docs.

GitHub Actions (`.github/workflows/laser-studio.yml`) builds and tests on Windows, macOS and Linux on every push, and uploads the installers as workflow artifacts. Pushing a tag like `laser-studio-v0.2.0` also creates a draft GitHub Release with them.
This produces an `.msi`/`.exe` on Windows, a `.dmg`/`.app` on macOS, and `.deb`/`.AppImage`/`.rpm` on Linux. Build on each OS you want to ship for.

### Tests
```bash
npm test                          # effects, engine, timeline, music analysis, ILDA, DMX, show files
cd src-tauri && cargo test        # Art-Net, OSC, MIDI/MTC and Ether Dream protocol encoding
```

## Project layout
```
src/core/       Pure show logic (no DOM): data model, effects, playback engine,
                automation & morphing, beam tracing (occlusion/mirrors), music
                analysis, ILDA, DMX mapping, laser scan paths. Unit tested.
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
