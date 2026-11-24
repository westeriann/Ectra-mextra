//! Ether Dream laser DAC support (discovery + point streaming).
//!
//! The frontend sends each frame as a flat list of points; a background thread
//! per DAC keeps the DAC's buffer topped up by looping the latest frame.
//!
//! Protocol reference: https://ether-dream.com/protocol.html
//! NOTE: written to the published protocol but not yet tested against hardware.

use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream, UdpSocket};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const BROADCAST_PORT: u16 = 7654;
const COMMAND_PORT: u16 = 7765;

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Point {
    pub x: i16,
    pub y: i16,
    pub r: u16,
    pub g: u16,
    pub b: u16,
}

impl Point {
    /// Encode as the 18-byte little-endian `dac_point` struct.
    pub fn encode(&self, out: &mut Vec<u8>) {
        let i = self.r.max(self.g).max(self.b);
        for v in [0u16, self.x as u16, self.y as u16, self.r, self.g, self.b, i, 0, 0] {
            out.extend_from_slice(&v.to_le_bytes());
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct DacStatus {
    pub light_engine_state: u8,
    pub playback_state: u8,
    pub buffer_fullness: u16,
    pub point_rate: u32,
}

impl DacStatus {
    pub fn parse(b: &[u8]) -> Option<Self> {
        if b.len() < 20 {
            return None;
        }
        Some(DacStatus {
            light_engine_state: b[1],
            playback_state: b[2],
            buffer_fullness: u16::from_le_bytes([b[10], b[11]]),
            point_rate: u32::from_le_bytes([b[12], b[13], b[14], b[15]]),
        })
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DacInfo {
    pub ip: String,
    pub mac: String,
    pub hw_revision: u16,
    pub sw_revision: u16,
    #[serde(skip)]
    pub buffer_capacity: u16,
}

/// Parse a 36-byte discovery broadcast.
pub fn parse_broadcast(b: &[u8], ip: String) -> Option<DacInfo> {
    if b.len() < 36 {
        return None;
    }
    let mac = b[0..6].iter().map(|x| format!("{x:02x}")).collect::<Vec<_>>().join(":");
    Some(DacInfo {
        ip,
        mac,
        hw_revision: u16::from_le_bytes([b[6], b[7]]),
        sw_revision: u16::from_le_bytes([b[8], b[9]]),
        buffer_capacity: u16::from_le_bytes([b[10], b[11]]),
    })
}

/// Convert the frontend's flat [x, y, r, g, b, ...] list (x/y in -1..1, colour 0..1).
pub fn points_from_flat(flat: &[f32]) -> Vec<Point> {
    flat.chunks_exact(5)
        .map(|c| {
            let coord = |v: f32| (v.clamp(-1.0, 1.0) * 32767.0) as i16;
            let col = |v: f32| (v.clamp(0.0, 1.0) * 65535.0) as u16;
            Point { x: coord(c[0]), y: coord(c[1]), r: col(c[2]), g: col(c[3]), b: col(c[4]) }
        })
        .collect()
}

struct Stream {
    frame: Arc<Mutex<Vec<Point>>>,
    pps: Arc<AtomicU32>,
    running: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct DacState {
    streams: Mutex<HashMap<String, Stream>>,
}

#[tauri::command]
pub fn etherdream_scan() -> Result<Vec<DacInfo>, String> {
    let sock = UdpSocket::bind(("0.0.0.0", BROADCAST_PORT)).map_err(|e| format!("Can't listen for DACs on port {BROADCAST_PORT}: {e}"))?;
    sock.set_read_timeout(Some(Duration::from_millis(250))).map_err(|e| e.to_string())?;
    let mut found: Vec<DacInfo> = Vec::new();
    let deadline = Instant::now() + Duration::from_millis(1500); // DACs announce once a second
    let mut buf = [0u8; 64];
    while Instant::now() < deadline {
        if let Ok((n, addr)) = sock.recv_from(&mut buf) {
            if let Some(info) = parse_broadcast(&buf[..n], addr.ip().to_string()) {
                if !found.iter().any(|d| d.ip == info.ip) {
                    found.push(info);
                }
            }
        }
    }
    Ok(found)
}

#[tauri::command]
pub fn etherdream_frame(state: tauri::State<DacState>, ip: String, points: Vec<f32>, pps: u32) -> Result<(), String> {
    let pts = points_from_flat(&points);
    let mut streams = state.streams.lock().map_err(|e| e.to_string())?;
    if let Some(s) = streams.get(&ip) {
        if s.running.load(Ordering::Relaxed) {
            *s.frame.lock().map_err(|e| e.to_string())? = pts;
            s.pps.store(pps, Ordering::Relaxed);
            return Ok(());
        }
    }
    let stream = Stream {
        frame: Arc::new(Mutex::new(pts)),
        pps: Arc::new(AtomicU32::new(pps)),
        running: Arc::new(AtomicBool::new(true)),
    };
    let (frame, rate, running) = (stream.frame.clone(), stream.pps.clone(), stream.running.clone());
    let addr: SocketAddr = format!("{ip}:{COMMAND_PORT}").parse().map_err(|e| format!("Bad DAC address {ip}: {e}"))?;
    std::thread::spawn(move || {
        if let Err(e) = run_stream(addr, frame, rate, running.clone()) {
            eprintln!("Ether Dream {addr}: {e}");
        }
        running.store(false, Ordering::Relaxed);
    });
    streams.insert(ip, stream);
    Ok(())
}

#[tauri::command]
pub fn etherdream_stop(state: tauri::State<DacState>) {
    if let Ok(mut s) = state.streams.lock() {
        for (_, st) in s.drain() {
            st.running.store(false, Ordering::Relaxed);
        }
    }
}

struct Conn {
    tcp: TcpStream,
    status: DacStatus,
}

impl Conn {
    /// Every command gets a 22-byte reply: response, echoed command, status.
    fn read_response(&mut self) -> std::io::Result<u8> {
        let mut b = [0u8; 22];
        self.tcp.read_exact(&mut b)?;
        if let Some(s) = DacStatus::parse(&b[2..]) {
            self.status = s;
        }
        Ok(b[0])
    }

    fn command(&mut self, bytes: &[u8]) -> std::io::Result<u8> {
        self.tcp.write_all(bytes)?;
        self.read_response()
    }
}

fn run_stream(addr: SocketAddr, frame: Arc<Mutex<Vec<Point>>>, rate: Arc<AtomicU32>, running: Arc<AtomicBool>) -> std::io::Result<()> {
    const CAPACITY: usize = 1799;
    let tcp = TcpStream::connect_timeout(&addr, Duration::from_secs(2))?;
    tcp.set_nodelay(true)?;
    tcp.set_read_timeout(Some(Duration::from_secs(2)))?;
    let mut c = Conn { tcp, status: DacStatus::default() };
    c.read_response()?; // greeting
    let mut cursor = 0usize;
    let mut started = false;

    while running.load(Ordering::Relaxed) {
        if c.status.light_engine_state != 0 {
            c.command(b"c")?; // clear emergency stop
        }
        if c.status.playback_state == 0 {
            c.command(b"p")?; // prepare
            started = false;
        }
        let pts = frame.lock().map(|f| f.clone()).unwrap_or_default();
        let free = CAPACITY.saturating_sub(c.status.buffer_fullness as usize + 100);
        if free < 50 || pts.is_empty() {
            // Ask for fresh status without blocking the DAC.
            std::thread::sleep(Duration::from_millis(5));
            c.command(b"?")?;
            continue;
        }
        let n = free.min(1000);
        let mut msg = Vec::with_capacity(3 + n * 18);
        msg.push(b'd');
        msg.extend_from_slice(&(n as u16).to_le_bytes());
        for _ in 0..n {
            pts[cursor % pts.len()].encode(&mut msg);
            cursor = (cursor + 1) % pts.len();
        }
        if c.command(&msg)? != b'a' {
            continue;
        }
        if !started && c.status.playback_state == 1 {
            let mut begin = vec![b'b'];
            begin.extend_from_slice(&0u16.to_le_bytes());
            begin.extend_from_slice(&rate.load(Ordering::Relaxed).to_le_bytes());
            started = c.command(&begin)? == b'a';
        }
    }
    let _ = c.command(b"s"); // stop output
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn point_encoding() {
        let mut out = Vec::new();
        Point { x: -32767, y: 100, r: 65535, g: 0, b: 10 }.encode(&mut out);
        assert_eq!(out.len(), 18);
        assert_eq!(&out[0..2], &[0, 0]);
        assert_eq!(i16::from_le_bytes([out[2], out[3]]), -32767);
        assert_eq!(i16::from_le_bytes([out[4], out[5]]), 100);
        assert_eq!(u16::from_le_bytes([out[6], out[7]]), 65535);
        assert_eq!(u16::from_le_bytes([out[12], out[13]]), 65535); // intensity = max channel
    }

    #[test]
    fn flat_points() {
        let p = points_from_flat(&[1.0, -2.0, 0.5, 0.0, 1.0, 9.0]);
        assert_eq!(p.len(), 1); // trailing partial point dropped
        assert_eq!(p[0].x, 32767);
        assert_eq!(p[0].y, -32767);
        assert_eq!(p[0].r, 32767);
        assert_eq!(p[0].b, 65535);
    }

    #[test]
    fn status_and_broadcast() {
        let mut st = [0u8; 20];
        st[1] = 0;
        st[2] = 2;
        st[10..12].copy_from_slice(&500u16.to_le_bytes());
        st[12..16].copy_from_slice(&30000u32.to_le_bytes());
        let s = DacStatus::parse(&st).unwrap();
        assert_eq!((s.playback_state, s.buffer_fullness, s.point_rate), (2, 500, 30000));

        let mut b = [0u8; 36];
        b[0..6].copy_from_slice(&[0, 0x11, 0x22, 0x33, 0x44, 0xff]);
        b[6] = 2;
        b[10..12].copy_from_slice(&1799u16.to_le_bytes());
        let d = parse_broadcast(&b, "10.0.0.5".into()).unwrap();
        assert_eq!(d.mac, "00:11:22:33:44:ff");
        assert_eq!(d.hw_revision, 2);
        assert_eq!(d.buffer_capacity, 1799);
    }
}
