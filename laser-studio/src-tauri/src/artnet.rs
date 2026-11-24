//! Art-Net (DMX over UDP) output. Sends ArtDmx packets to a host or the
//! broadcast address so lighting consoles, visualisers and DMX nodes can
//! receive the show.

use std::net::UdpSocket;
use std::sync::Mutex;

pub const ARTNET_PORT: u16 = 6454;

#[derive(Default)]
pub struct ArtnetState {
    socket: Mutex<Option<UdpSocket>>,
    sequence: Mutex<u8>,
}

/// Build an ArtDmx packet (OpCode 0x5000, protocol 14).
pub fn artdmx_packet(universe: u16, sequence: u8, data: &[u8]) -> Vec<u8> {
    // DMX length must be even and between 2 and 512.
    let mut len = data.len().clamp(2, 512);
    if len % 2 == 1 {
        len += 1;
    }
    let mut p = Vec::with_capacity(18 + len);
    p.extend_from_slice(b"Art-Net\0");
    p.extend_from_slice(&0x5000u16.to_le_bytes());
    p.extend_from_slice(&14u16.to_be_bytes());
    p.push(sequence);
    p.push(0); // physical
    p.push((universe & 0xff) as u8); // SubUni
    p.push(((universe >> 8) & 0x7f) as u8); // Net
    p.extend_from_slice(&(len as u16).to_be_bytes());
    p.extend_from_slice(&data[..data.len().min(len)]);
    p.resize(18 + len, 0);
    p
}

#[tauri::command]
pub fn artnet_send(
    state: tauri::State<ArtnetState>,
    host: String,
    universe: u16,
    data: Vec<u8>,
) -> Result<(), String> {
    let mut guard = state.socket.lock().map_err(|e| e.to_string())?;
    if guard.is_none() {
        let s = UdpSocket::bind("0.0.0.0:0").map_err(|e| format!("Art-Net socket: {e}"))?;
        s.set_broadcast(true).map_err(|e| e.to_string())?;
        *guard = Some(s);
    }
    let mut seq = state.sequence.lock().map_err(|e| e.to_string())?;
    // Sequence 0 means "disabled" in Art-Net, so cycle through 1..=255.
    *seq = if *seq == 255 { 1 } else { *seq + 1 };
    let packet = artdmx_packet(universe, *seq, &data);
    guard
        .as_ref()
        .unwrap()
        .send_to(&packet, (host.as_str(), ARTNET_PORT))
        .map_err(|e| format!("Art-Net send to {host}: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packet_layout() {
        let p = artdmx_packet(0x0123, 7, &[1, 2, 3]);
        assert_eq!(&p[0..8], b"Art-Net\0");
        assert_eq!(&p[8..10], &[0x00, 0x50]); // OpDmx little-endian
        assert_eq!(&p[10..12], &[0, 14]);
        assert_eq!(p[12], 7);
        assert_eq!(p[14], 0x23);
        assert_eq!(p[15], 0x01);
        assert_eq!(&p[16..18], &[0, 4]); // padded to even length
        assert_eq!(&p[18..], &[1, 2, 3, 0]);
    }

    #[test]
    fn full_universe() {
        let p = artdmx_packet(0, 1, &[9; 600]);
        assert_eq!(p.len(), 18 + 512);
        assert_eq!(&p[16..18], &[2, 0]);
    }
}
