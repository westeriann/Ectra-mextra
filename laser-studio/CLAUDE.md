# Laser Studio — notes for Claude

- Desktop app: Tauri 2 (Rust in `src-tauri/`) + TypeScript/three.js (`src/`). See README for layout and commands.
- Pure show logic lives in `src/core/` and is unit-tested (`npm test`); keep new logic there and test it.
- Run `npm run build`, `npm test` and `cd src-tauri && cargo test` before committing.
- The user runs it on **Windows**. Windows installer from Linux: README → "Building the Windows installer from Linux".
- **Sister project: [Amethyst VJ](https://github.com/westeriann/amethyst)** (same owner). Before building features
  that overlap (audio analysis, tempo, song structure, OSC, remote, Art-Net, MIDI, Ableton Link, StageLinQ),
  read `docs/AMETHYST.md` and the matching Amethyst source, reuse its approach, and keep names, defaults and
  ports compatible. The two apps are meant to interconnect.
