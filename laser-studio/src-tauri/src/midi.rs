//! MIDI input: notes and CCs for pads/faders, and MIDI Timecode (MTC) so the
//! show can chase a DAW or playback rig.

use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum MidiEvent {
    Note { channel: u8, note: u8, velocity: u8 },
    Cc { channel: u8, controller: u8, value: u8 },
    Timecode { seconds: f64 },
}

#[derive(Default)]
pub struct MidiState {
    conn: Mutex<Option<midir::MidiInputConnection<()>>>,
}

/// Reassembles MTC quarter-frame messages into a position.
#[derive(Default)]
pub struct MtcDecoder {
    pieces: [u8; 8],
    seen: u8,
}

impl MtcDecoder {
    fn fps(rate_bits: u8) -> f64 {
        match rate_bits {
            0 => 24.0,
            1 => 25.0,
            2 => 29.97,
            _ => 30.0,
        }
    }

    /// Feed one quarter-frame data byte; returns the time once a full frame is assembled.
    pub fn quarter_frame(&mut self, data: u8) -> Option<f64> {
        let piece = (data >> 4) & 7;
        self.pieces[piece as usize] = data & 0x0f;
        self.seen |= 1 << piece;
        if piece == 7 && self.seen == 0xff {
            self.seen = 0;
            let p = &self.pieces;
            let frames = p[0] | ((p[1] & 1) << 4);
            let secs = p[2] | ((p[3] & 3) << 4);
            let mins = p[4] | ((p[5] & 3) << 4);
            let hours = p[6] | ((p[7] & 1) << 4);
            let fps = Self::fps((p[7] >> 1) & 3);
            // A full set of quarter frames takes two frames to arrive.
            let t = hours as f64 * 3600.0 + mins as f64 * 60.0 + secs as f64 + (frames as f64 + 2.0) / fps;
            return Some(t);
        }
        None
    }

    /// Full-frame SysEx: F0 7F 7F 01 01 hh mm ss ff F7
    pub fn full_frame(msg: &[u8]) -> Option<f64> {
        if msg.len() >= 10 && msg[0] == 0xf0 && msg[1] == 0x7f && msg[3] == 0x01 && msg[4] == 0x01 {
            let fps = Self::fps((msg[5] >> 5) & 3);
            let h = (msg[5] & 0x1f) as f64;
            return Some(h * 3600.0 + msg[6] as f64 * 60.0 + msg[7] as f64 + msg[8] as f64 / fps);
        }
        None
    }
}

pub fn decode(msg: &[u8], mtc: &mut MtcDecoder) -> Option<MidiEvent> {
    let status = *msg.first()?;
    match status {
        0xf1 => mtc.quarter_frame(*msg.get(1)?).map(|seconds| MidiEvent::Timecode { seconds }),
        0xf0 => MtcDecoder::full_frame(msg).map(|seconds| MidiEvent::Timecode { seconds }),
        _ => {
            let channel = status & 0x0f;
            match status & 0xf0 {
                0x90 => Some(MidiEvent::Note { channel, note: *msg.get(1)?, velocity: *msg.get(2)? }),
                0x80 => Some(MidiEvent::Note { channel, note: *msg.get(1)?, velocity: 0 }),
                0xb0 => Some(MidiEvent::Cc { channel, controller: *msg.get(1)?, value: *msg.get(2)? }),
                _ => None,
            }
        }
    }
}

#[tauri::command]
pub fn midi_ports() -> Result<Vec<String>, String> {
    let input = midir::MidiInput::new("Laser Studio").map_err(|e| e.to_string())?;
    Ok(input.ports().iter().filter_map(|p| input.port_name(p).ok()).collect())
}

#[tauri::command]
pub fn midi_open(app: AppHandle, state: tauri::State<MidiState>, name: String) -> Result<(), String> {
    let mut guard = state.conn.lock().map_err(|e| e.to_string())?;
    if let Some(c) = guard.take() {
        c.close();
    }
    let mut input = midir::MidiInput::new("Laser Studio").map_err(|e| e.to_string())?;
    // Timecode and SysEx arrive as system messages; make sure they're not filtered.
    input.ignore(midir::Ignore::ActiveSense);
    let port = input
        .ports()
        .into_iter()
        .find(|p| input.port_name(p).map(|n| n == name).unwrap_or(false))
        .ok_or_else(|| format!("MIDI device '{name}' not found"))?;
    let mut mtc = MtcDecoder::default();
    let conn = input
        .connect(
            &port,
            "laser-studio-in",
            move |_, msg, _| {
                if let Some(ev) = decode(msg, &mut mtc) {
                    let _ = app.emit("midi", ev);
                }
            },
            (),
        )
        .map_err(|e| format!("Couldn't open MIDI device '{name}': {e}"))?;
    *guard = Some(conn);
    Ok(())
}

#[tauri::command]
pub fn midi_close(state: tauri::State<MidiState>) {
    if let Ok(mut g) = state.conn.lock() {
        if let Some(c) = g.take() {
            c.close();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notes_and_ccs() {
        let mut m = MtcDecoder::default();
        assert_eq!(decode(&[0x91, 60, 100], &mut m), Some(MidiEvent::Note { channel: 1, note: 60, velocity: 100 }));
        assert_eq!(decode(&[0x80, 60, 64], &mut m), Some(MidiEvent::Note { channel: 0, note: 60, velocity: 0 }));
        assert_eq!(decode(&[0xb2, 7, 127], &mut m), Some(MidiEvent::Cc { channel: 2, controller: 7, value: 127 }));
        assert_eq!(decode(&[0xe0, 0, 0], &mut m), None);
    }

    #[test]
    fn quarter_frames() {
        // 01:02:03, frame 4 at 25 fps.
        let (h, mi, s, f, rate) = (1u8, 2u8, 3u8, 4u8, 1u8);
        let pieces = [
            f & 0xf,
            f >> 4,
            s & 0xf,
            s >> 4,
            mi & 0xf,
            mi >> 4,
            h & 0xf,
            (h >> 4) | (rate << 1),
        ];
        let mut m = MtcDecoder::default();
        let mut out = None;
        for (i, v) in pieces.iter().enumerate() {
            out = decode(&[0xf1, ((i as u8) << 4) | v], &mut m);
        }
        let Some(MidiEvent::Timecode { seconds }) = out else { panic!("no timecode") };
        assert!((seconds - (3723.0 + 6.0 / 25.0)).abs() < 1e-9);
    }

    #[test]
    fn full_frame_sysex() {
        let msg = [0xf0, 0x7f, 0x7f, 0x01, 0x01, (3 << 5) | 0, 1, 30, 15, 0xf7];
        let Some(MidiEvent::Timecode { seconds }) = decode(&msg, &mut MtcDecoder::default()) else { panic!() };
        assert!((seconds - 90.5).abs() < 1e-9);
    }
}
