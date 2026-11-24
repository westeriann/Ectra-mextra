//! File access for show files, audio and ILDA. Paths come from the native
//! open/save dialogs (or a show's stored audio path).

use tauri::ipc::Response;

#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("Couldn't open {path}: {e}"))
}

#[tauri::command]
pub fn write_text_file(path: String, contents: String) -> Result<(), String> {
    // Write to a temp file first so a crash mid-save can't destroy the show.
    let tmp = format!("{path}.saving");
    std::fs::write(&tmp, contents).map_err(|e| format!("Couldn't save {path}: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("Couldn't save {path}: {e}"))
}

/// A show file passed on the command line (double-clicking a .lshow file).
#[tauri::command]
pub fn startup_file() -> Option<String> {
    std::env::args()
        .skip(1)
        .find(|a| a.to_lowercase().ends_with(".lshow") && std::path::Path::new(a).is_file())
}

/// Returned as raw bytes so the frontend gets an ArrayBuffer (no JSON number arrays).
#[tauri::command]
pub fn read_binary_file(path: String) -> Result<Response, String> {
    std::fs::read(&path)
        .map(Response::new)
        .map_err(|e| format!("Couldn't open {path}: {e}"))
}

/// Takes the bytes as a raw request body (fast for large videos) and the
/// percent-encoded destination path in the `path` header.
#[tauri::command]
pub fn write_binary_file(request: tauri::ipc::Request) -> Result<(), String> {
    let encoded = request
        .headers()
        .get("path")
        .and_then(|v| v.to_str().ok())
        .ok_or("missing path")?;
    let path = percent_decode(encoded)?;
    let tauri::ipc::InvokeBody::Raw(data) = request.body() else {
        return Err("expected raw bytes".into());
    };
    std::fs::write(&path, data).map_err(|e| format!("Couldn't save {path}: {e}"))
}

/// Decode `encodeURIComponent` output.
pub fn percent_decode(s: &str) -> Result<String, String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hex = std::str::from_utf8(&b[i + 1..i + 3]).map_err(|e| e.to_string())?;
            out.push(u8::from_str_radix(hex, 16).map_err(|_| format!("bad escape %{hex}"))?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    #[test]
    fn decodes_paths() {
        assert_eq!(super::percent_decode("C%3A%5CShows%5Cn%C3%BCit%20show.webm").unwrap(), "C:\\Shows\\nüit show.webm");
        assert_eq!(super::percent_decode("/tmp/a.webm").unwrap(), "/tmp/a.webm");
        assert!(super::percent_decode("%zz").is_err());
    }
}
