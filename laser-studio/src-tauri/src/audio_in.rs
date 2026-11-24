//! Live audio capture for audio reactions: microphones / line inputs, and on
//! Windows "system audio" (loopback of an output device — whatever is playing
//! on the PC, no microphone needed), like Amethyst VJ.
//!
//! Samples are mixed to mono f32 and streamed to the frontend as raw bytes over
//! a Tauri channel, where the same analyser handles songs, mics and loopback.

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::ipc::{Channel, InvokeResponseBody};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioDeviceInfo {
    /// "in:<n>" for inputs, "out:<n>" for system-audio loopback of an output.
    pub id: String,
    pub name: String,
    /// "input" or "system".
    pub kind: String,
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioStarted {
    pub sample_rate: u32,
    pub name: String,
}

#[derive(Default)]
pub struct AudioInState {
    running: Mutex<Option<Arc<AtomicBool>>>,
}

/// Interleaved frames → mono.
pub fn to_mono(data: &[f32], channels: usize, out: &mut Vec<f32>) {
    let ch = channels.max(1);
    for frame in data.chunks_exact(ch) {
        out.push(frame.iter().sum::<f32>() / ch as f32);
    }
}

/// Little-endian bytes of the samples (what the frontend reads as a Float32Array).
pub fn to_bytes(samples: &[f32]) -> Vec<u8> {
    let mut b = Vec::with_capacity(samples.len() * 4);
    for s in samples {
        b.extend_from_slice(&s.to_le_bytes());
    }
    b
}

#[tauri::command]
pub fn audio_devices() -> Vec<AudioDeviceInfo> {
    use cpal::traits::{DeviceTrait, HostTrait};
    let host = cpal::default_host();
    let mut out = Vec::new();
    let def_in = host.default_input_device().and_then(|d| d.name().ok());
    if let Ok(devs) = host.input_devices() {
        for (i, d) in devs.enumerate() {
            let name = d.name().unwrap_or_else(|_| format!("Input {}", i + 1));
            out.push(AudioDeviceInfo { id: format!("in:{i}"), is_default: Some(&name) == def_in.as_ref(), name, kind: "input".into() });
        }
    }
    // WASAPI can record what an output device plays (loopback). Other hosts can't.
    if cfg!(windows) {
        let def_out = host.default_output_device().and_then(|d| d.name().ok());
        if let Ok(devs) = host.output_devices() {
            for (i, d) in devs.enumerate() {
                let name = d.name().unwrap_or_else(|_| format!("Output {}", i + 1));
                out.push(AudioDeviceInfo { id: format!("out:{i}"), is_default: Some(&name) == def_out.as_ref(), name, kind: "system".into() });
            }
        }
    }
    out
}

fn stop(state: &AudioInState) {
    if let Ok(mut g) = state.running.lock() {
        if let Some(flag) = g.take() {
            flag.store(false, Ordering::Relaxed);
        }
    }
}

#[tauri::command]
pub fn audio_stop(state: tauri::State<AudioInState>) {
    stop(&state);
}

/// Start capturing `id` ("default", "in:<n>" or "out:<n>") and stream mono samples to `on_data`.
#[tauri::command]
pub fn audio_start(state: tauri::State<AudioInState>, id: String, on_data: Channel<InvokeResponseBody>) -> Result<AudioStarted, String> {
    stop(&state);
    let flag = Arc::new(AtomicBool::new(true));
    *state.running.lock().map_err(|e| e.to_string())? = Some(flag.clone());
    // cpal streams can't move between threads on every platform: build and own it on its own thread.
    let (tx, rx) = std::sync::mpsc::channel::<Result<AudioStarted, String>>();
    std::thread::spawn(move || {
        let stream = match open_stream(&id, on_data) {
            Ok((stream, info)) => {
                let _ = tx.send(Ok(info));
                stream
            }
            Err(e) => {
                let _ = tx.send(Err(e));
                return;
            }
        };
        while flag.load(Ordering::Relaxed) {
            std::thread::sleep(Duration::from_millis(50));
        }
        drop(stream);
    });
    rx.recv_timeout(Duration::from_secs(5)).map_err(|_| "The audio device didn't respond".to_string())?
}

fn open_stream(id: &str, on_data: Channel<InvokeResponseBody>) -> Result<(cpal::Stream, AudioStarted), String> {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    let host = cpal::default_host();
    let (device, config) = if let Some(n) = id.strip_prefix("out:") {
        let i: usize = n.parse().map_err(|_| "bad device id")?;
        let d = host.output_devices().map_err(|e| e.to_string())?.nth(i).ok_or("That output device is gone")?;
        let c = d.default_output_config().map_err(|e| format!("Can't use that output for system audio: {e}"))?;
        (d, c)
    } else {
        let d = match id.strip_prefix("in:") {
            Some(n) => {
                let i: usize = n.parse().map_err(|_| "bad device id")?;
                host.input_devices().map_err(|e| e.to_string())?.nth(i).ok_or("That input device is gone")?
            }
            None => host.default_input_device().ok_or("No audio input found")?,
        };
        let c = d.default_input_config().map_err(|e| format!("Can't open that input: {e}"))?;
        (d, c)
    };
    let name = device.name().unwrap_or_default();
    let sample_rate = config.sample_rate().0;
    let channels = config.channels() as usize;
    let format = config.sample_format();
    let cfg: cpal::StreamConfig = config.into();

    // Send ~20 ms blocks: low latency without flooding the IPC.
    let block = (sample_rate as usize / 50).max(256);
    let buf = Arc::new(Mutex::new(Vec::<f32>::with_capacity(block * 2)));
    let push = {
        let buf = buf.clone();
        move |mono: &[f32]| {
            if let Ok(mut b) = buf.lock() {
                b.extend_from_slice(mono);
                if b.len() >= block {
                    let _ = on_data.send(InvokeResponseBody::Raw(to_bytes(&b)));
                    b.clear();
                }
            }
        }
    };
    let err = |e: cpal::StreamError| eprintln!("audio input error: {e}");
    let stream = match format {
        cpal::SampleFormat::F32 => {
            let mut tmp = Vec::new();
            device.build_input_stream(
                &cfg,
                move |data: &[f32], _: &_| {
                    tmp.clear();
                    to_mono(data, channels, &mut tmp);
                    push(&tmp);
                },
                err,
                None,
            )
        }
        cpal::SampleFormat::I16 => {
            let mut tmp = Vec::new();
            let mut f = Vec::new();
            device.build_input_stream(
                &cfg,
                move |data: &[i16], _: &_| {
                    f.clear();
                    f.extend(data.iter().map(|s| *s as f32 / 32768.0));
                    tmp.clear();
                    to_mono(&f, channels, &mut tmp);
                    push(&tmp);
                },
                err,
                None,
            )
        }
        cpal::SampleFormat::U16 => {
            let mut tmp = Vec::new();
            let mut f = Vec::new();
            device.build_input_stream(
                &cfg,
                move |data: &[u16], _: &_| {
                    f.clear();
                    f.extend(data.iter().map(|s| (*s as f32 - 32768.0) / 32768.0));
                    tmp.clear();
                    to_mono(&f, channels, &mut tmp);
                    push(&tmp);
                },
                err,
                None,
            )
        }
        other => return Err(format!("Unsupported sample format {other:?}")),
    }
    .map_err(|e| format!("Couldn't open {name}: {e}"))?;
    stream.play().map_err(|e| format!("Couldn't start {name}: {e}"))?;
    Ok((stream, AudioStarted { sample_rate, name }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mono_mix_and_bytes() {
        let mut m = Vec::new();
        to_mono(&[1.0, 0.0, 0.5, 0.5, 9.0], 2, &mut m); // trailing half frame dropped
        assert_eq!(m, vec![0.5, 0.5]);
        let b = to_bytes(&[1.0, -2.0]);
        assert_eq!(b.len(), 8);
        assert_eq!(f32::from_le_bytes([b[4], b[5], b[6], b[7]]), -2.0);
    }

    #[test]
    fn listing_devices_never_panics() {
        // CI machines often have no audio hardware at all.
        let _ = audio_devices();
    }
}
