//! Scratch files for the undo history's spilled scene snapshots.
//!
//! The history moves old snapshots out of RAM. It used the origin private file
//! system for that, written through `FileSystemFileHandle.createWritable()`, which
//! WebKit only has from Safari 26: in the WKWebView of macOS 12 to 15 every spill
//! failed and each history entry kept a full copy of the scene in memory. Writing
//! the file from here works in every webview.
//!
//! One file per history entry, named by the key the frontend gives it, in a
//! directory under the system temp dir (which macOS clears on its own if a crash
//! ever strands one). The frontend prunes it against its live keys at startup, as
//! it did with the origin private file system.

use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;

use tauri::ipc::{InvokeBody, Request, Response};

const DIRECTORY: &str = "dragonfruit-undo";

fn directory() -> PathBuf {
    std::env::temp_dir().join(DIRECTORY)
}

/// The file for a key. Keys come from the frontend, so anything that could
/// leave the directory is refused rather than cleaned up.
fn path_for(key: &str) -> Result<PathBuf, String> {
    let valid = !key.is_empty()
        && key.len() <= 64
        && key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if !valid {
        return Err(format!("undo spill: invalid key {key:?}"));
    }
    Ok(directory().join(format!("scene-{key}.bin")))
}

fn header<'a>(request: &'a Request<'_>, name: &str) -> Result<&'a str, String> {
    request
        .headers()
        .get(name)
        .ok_or_else(|| format!("undo spill: missing {name} header"))?
        .to_str()
        .map_err(|e| format!("undo spill: invalid {name} header: {e}"))
}

/// Appends a chunk to a key's file. Offset 0 starts the file over; any other
/// offset must be where the file ends, so a lost chunk fails the write instead
/// of leaving a hole the read would take for data. Returns the new length.
#[tauri::command]
pub async fn undo_spill_append(request: Request<'_>) -> Result<u64, String> {
    let bytes = match request.body() {
        InvokeBody::Raw(bytes) => bytes,
        InvokeBody::Json(_) => return Err("undo_spill_append expects a raw body".into()),
    };
    let path = path_for(header(&request, "x-undo-spill-key")?)?;
    let offset: u64 = header(&request, "x-undo-spill-offset")?
        .trim()
        .parse()
        .map_err(|e| format!("undo spill: invalid offset: {e}"))?;

    fs::create_dir_all(directory()).map_err(|e| format!("undo spill: {e}"))?;
    let mut file = if offset == 0 {
        fs::File::create(&path)
    } else {
        OpenOptions::new().append(true).open(&path)
    }
    .map_err(|e| format!("undo spill: open {}: {e}", path.display()))?;
    let length = file.metadata().map_err(|e| format!("undo spill: {e}"))?.len();
    if length != offset {
        return Err(format!("undo spill: chunk at {offset} but the file holds {length} bytes"));
    }
    file.write_all(bytes).map_err(|e| format!("undo spill: write: {e}"))?;
    Ok(offset + bytes.len() as u64)
}

/// Reads `length` bytes at `offset` from a key's file.
#[tauri::command]
pub async fn undo_spill_read(key: String, offset: u64, length: u64) -> Result<Response, String> {
    let path = path_for(&key)?;
    let mut file =
        fs::File::open(&path).map_err(|e| format!("undo spill: open {}: {e}", path.display()))?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| format!("undo spill: seek: {e}"))?;
    let mut buffer = vec![0u8; length as usize];
    file.read_exact(&mut buffer)
        .map_err(|e| format!("undo spill: read {length} bytes at {offset}: {e}"))?;
    Ok(Response::new(buffer))
}

/// Deletes a key's file. A file that is already gone is not an error.
#[tauri::command]
pub async fn undo_spill_remove(key: String) -> Result<(), String> {
    match fs::remove_file(path_for(&key)?) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("undo spill: remove: {e}")),
    }
}

/// Deletes every file whose key is not in `active_keys`. Returns how many went.
#[tauri::command]
pub async fn undo_spill_prune(active_keys: Vec<String>) -> Result<u32, String> {
    let entries = match fs::read_dir(directory()) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(format!("undo spill: list: {e}")),
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let key = name
            .strip_prefix("scene-")
            .and_then(|rest| rest.strip_suffix(".bin"));
        if key.is_some_and(|key| active_keys.iter().any(|active| active == key)) {
            continue;
        }
        if fs::remove_file(entry.path()).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::path_for;

    #[test]
    fn keys_cannot_leave_the_directory() {
        assert!(path_for("mi3k2-ab12cd34").is_ok());
        for bad in ["", "../x", "a/b", "a\\b", "a.b", &"k".repeat(65)] {
            assert!(path_for(bad).is_err(), "{bad:?}");
        }
    }
}
