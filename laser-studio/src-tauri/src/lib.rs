//! Laser Studio desktop backend: file access and the hardware protocols a
//! browser can't speak (Art-Net, OSC, MIDI/timecode, Ether Dream laser DACs).

mod artnet;
mod etherdream;
mod files;
mod midi;
mod osc;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(artnet::ArtnetState::default())
        .manage(osc::OscState::default())
        .manage(midi::MidiState::default())
        .manage(etherdream::DacState::default())
        .invoke_handler(tauri::generate_handler![
            files::read_text_file,
            files::write_text_file,
            files::read_binary_file,
            files::write_binary_file,
            files::startup_file,
            artnet::artnet_send,
            osc::osc_start,
            osc::osc_stop,
            midi::midi_ports,
            midi::midi_open,
            midi::midi_close,
            etherdream::etherdream_scan,
            etherdream::etherdream_frame,
            etherdream::etherdream_stop,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Laser Studio");
}
