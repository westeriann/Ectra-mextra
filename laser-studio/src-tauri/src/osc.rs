//! OSC input. Listens on a UDP port and forwards every message to the
//! frontend as an `osc` event, so TouchOSC, Ableton, QLab etc. can fire cues.

use serde::Serialize;
use std::net::UdpSocket;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum OscArg {
    Int(i64),
    Float(f64),
    Str(String),
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct OscMessage {
    pub address: String,
    pub args: Vec<OscArg>,
}

#[derive(Default)]
pub struct OscState {
    running: Mutex<Option<Arc<AtomicBool>>>,
}

fn read_str(buf: &[u8], pos: &mut usize) -> Option<String> {
    let start = *pos;
    let end = start + buf.get(start..)?.iter().position(|&b| b == 0)?;
    let s = std::str::from_utf8(&buf[start..end]).ok()?.to_string();
    // Strings are null-terminated and padded to a multiple of 4.
    *pos = (end + 4) & !3;
    Some(s)
}

fn read_bytes<const N: usize>(buf: &[u8], pos: &mut usize) -> Option<[u8; N]> {
    let b: [u8; N] = buf.get(*pos..*pos + N)?.try_into().ok()?;
    *pos += N;
    Some(b)
}

/// Parse an OSC packet (message or bundle, possibly nested).
pub fn parse_packet(buf: &[u8]) -> Vec<OscMessage> {
    let mut out = Vec::new();
    parse_into(buf, &mut out, 0);
    out
}

fn parse_into(buf: &[u8], out: &mut Vec<OscMessage>, depth: u8) {
    if depth > 8 {
        return;
    }
    if buf.starts_with(b"#bundle\0") {
        let mut pos = 16; // "#bundle\0" + 8-byte timetag
        while let Some(size) = read_bytes::<4>(buf, &mut pos) {
            let size = i32::from_be_bytes(size).max(0) as usize;
            let Some(inner) = buf.get(pos..pos + size) else { return };
            parse_into(inner, out, depth + 1);
            pos += size;
        }
        return;
    }
    if let Some(m) = parse_message(buf) {
        out.push(m);
    }
}

fn parse_message(buf: &[u8]) -> Option<OscMessage> {
    let mut pos = 0;
    let address = read_str(buf, &mut pos)?;
    if !address.starts_with('/') {
        return None;
    }
    let mut args = Vec::new();
    if pos >= buf.len() {
        return Some(OscMessage { address, args });
    }
    let tags = read_str(buf, &mut pos)?;
    for t in tags.chars().skip(1) {
        let arg = match t {
            'i' => OscArg::Int(i32::from_be_bytes(read_bytes(buf, &mut pos)?) as i64),
            'h' => OscArg::Int(i64::from_be_bytes(read_bytes(buf, &mut pos)?)),
            'f' => OscArg::Float(f32::from_be_bytes(read_bytes(buf, &mut pos)?) as f64),
            'd' => OscArg::Float(f64::from_be_bytes(read_bytes(buf, &mut pos)?)),
            's' | 'S' => OscArg::Str(read_str(buf, &mut pos)?),
            'T' => OscArg::Int(1),
            'F' | 'N' | 'I' => OscArg::Int(0),
            _ => return Some(OscMessage { address, args }), // unknown type: stop here
        };
        args.push(arg);
    }
    Some(OscMessage { address, args })
}

#[tauri::command]
pub fn osc_start(app: AppHandle, state: tauri::State<OscState>, port: u16) -> Result<(), String> {
    stop(&state);
    let socket = UdpSocket::bind(("0.0.0.0", port)).map_err(|e| format!("OSC: can't listen on port {port}: {e}"))?;
    socket
        .set_read_timeout(Some(Duration::from_millis(200)))
        .map_err(|e| e.to_string())?;
    let flag = Arc::new(AtomicBool::new(true));
    *state.running.lock().map_err(|e| e.to_string())? = Some(flag.clone());
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        while flag.load(Ordering::Relaxed) {
            if let Ok((n, _)) = socket.recv_from(&mut buf) {
                for msg in parse_packet(&buf[..n]) {
                    let _ = app.emit("osc", msg);
                }
            }
        }
    });
    Ok(())
}

fn stop(state: &OscState) {
    if let Ok(mut g) = state.running.lock() {
        if let Some(flag) = g.take() {
            flag.store(false, Ordering::Relaxed);
        }
    }
}

#[tauri::command]
pub fn osc_stop(state: tauri::State<OscState>) {
    stop(&state);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pad(s: &str) -> Vec<u8> {
        let mut v = s.as_bytes().to_vec();
        v.push(0);
        while v.len() % 4 != 0 {
            v.push(0);
        }
        v
    }

    fn message(addr: &str, tags: &str, data: &[u8]) -> Vec<u8> {
        let mut v = pad(addr);
        v.extend(pad(tags));
        v.extend_from_slice(data);
        v
    }

    #[test]
    fn parses_int_float_string() {
        let mut data = 3i32.to_be_bytes().to_vec();
        data.extend(0.5f32.to_be_bytes());
        data.extend(pad("go"));
        let msgs = parse_packet(&message("/cue/fire", ",ifs", &data));
        assert_eq!(
            msgs,
            vec![OscMessage {
                address: "/cue/fire".into(),
                args: vec![OscArg::Int(3), OscArg::Float(0.5), OscArg::Str("go".into())]
            }]
        );
    }

    #[test]
    fn parses_bundles() {
        let a = message("/go", ",", &[]);
        let b = message("/master", ",f", &0.25f32.to_be_bytes());
        let mut bundle = b"#bundle\0".to_vec();
        bundle.extend([0u8; 8]);
        for m in [&a, &b] {
            bundle.extend((m.len() as i32).to_be_bytes());
            bundle.extend_from_slice(m);
        }
        let msgs = parse_packet(&bundle);
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].address, "/go");
        assert_eq!(msgs[1].args, vec![OscArg::Float(0.25)]);
    }

    #[test]
    fn ignores_garbage() {
        assert!(parse_packet(b"hello").is_empty());
        assert!(parse_packet(&[]).is_empty());
        // Truncated int argument.
        let msgs = parse_packet(&message("/x", ",i", &[0, 1]));
        assert_eq!(msgs.len(), 0);
    }
}
