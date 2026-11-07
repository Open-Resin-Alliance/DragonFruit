//! Disk-only, process-private backing for the last native slice snapshot.
//! No temp-dir fallback: the caller supplies Tauri's app_cache_dir.

use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_FILE: AtomicU64 = AtomicU64::new(0);

pub fn open(directory: &Path) -> io::Result<File> {
    fs::create_dir_all(directory)?;
    let directory = fs::canonicalize(directory)?;
    reject_memory_filesystem(&directory)?;
    let mut options = OpenOptions::new();
    options.read(true).write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // DELETE_ON_CLOSE also covers process termination. No other handle may
        // open this file while it is live; std's File owns the sole OS handle.
        options.custom_flags(0x04000000).share_mode(0)
            .access_mode(0x80000000 | 0x40000000 | 0x00010000);
    }
    #[cfg(not(any(unix, windows)))]
    return Err(io::Error::new(io::ErrorKind::Unsupported, "Anonymous slice backing is unavailable"));

    #[cfg(any(unix, windows))]
    for _ in 0..32 {
        let nonce = NEXT_FILE.fetch_add(1, Ordering::Relaxed);
        let path = directory.join(format!("mesh-slice-{}-{nonce}.cache", std::process::id()));
        match options.open(&path) {
            Ok(file) => {
                #[cfg(unix)]
                fs::remove_file(&path)?;
                return Ok(file);
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    #[cfg(any(unix, windows))]
    Err(io::Error::new(io::ErrorKind::AlreadyExists, "Cannot create private slice backing"))
}

// Linux app_cache_dir can itself be redirected onto tmpfs. Refuse that case
// rather than silently consuming the RAM this cache is intended to release.
#[cfg(target_os = "linux")]
fn reject_memory_filesystem(directory: &Path) -> io::Result<()> {
    use std::os::unix::ffi::OsStringExt;
    let mounts = fs::read_to_string("/proc/self/mountinfo")?;
    let mut selected = None;
    for line in mounts.lines() {
        let Some((fields, filesystem)) = line.split_once(" - ") else { continue; };
        let Some(mount) = fields.split_whitespace().nth(4) else { continue; };
        let mut decoded = Vec::with_capacity(mount.len());
        let bytes = mount.as_bytes();
        let mut index = 0;
        while index < bytes.len() {
            if bytes[index] == b'\\' && index + 3 < bytes.len()
                && bytes[index + 1..index + 4].iter().all(|byte| (b'0'..=b'7').contains(byte))
            {
                let value = (bytes[index + 1] - b'0') * 64
                    + (bytes[index + 2] - b'0') * 8 + bytes[index + 3] - b'0';
                decoded.push(value);
                index += 4;
            } else {
                decoded.push(bytes[index]);
                index += 1;
            }
        }
        let mount = std::path::PathBuf::from(std::ffi::OsString::from_vec(decoded));
        if directory.starts_with(&mount) {
            let depth = mount.components().count();
            if selected.as_ref().map_or(true, |(old_depth, _)| depth >= *old_depth) {
                selected = Some((depth, filesystem.split_whitespace().next().unwrap_or("")));
            }
        }
    }
    match selected {
        Some((_, "tmpfs" | "ramfs" | "devtmpfs")) => Err(io::Error::new(
            io::ErrorKind::Unsupported, "Slice backing requires a disk-backed app cache directory",
        )),
        Some(_) => Ok(()),
        None => Err(io::Error::new(io::ErrorKind::NotFound, "Cannot identify app cache filesystem")),
    }
}

#[cfg(not(target_os = "linux"))]
fn reject_memory_filesystem(_directory: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Seek, SeekFrom, Write};

    #[test]
    fn backing_is_lazy_unallocated_and_removed_when_closed() {
        let directory = std::env::current_dir().unwrap().join(format!(
            ".mesh-backing-test-{}-{}", std::process::id(), NEXT_FILE.fetch_add(1, Ordering::Relaxed),
        ));
        assert!(!directory.exists());
        let mut file = open(&directory).unwrap();
        assert_eq!(file.metadata().unwrap().len(), 0);
        file.write_all(&[1, 2, 3, 4]).unwrap();
        assert_eq!(file.metadata().unwrap().len(), 4);
        file.seek(SeekFrom::Start(0)).unwrap();
        let mut bytes = [0; 4];
        file.read_exact(&mut bytes).unwrap();
        assert_eq!(bytes, [1, 2, 3, 4]);
        #[cfg(unix)]
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 0);
        drop(file);
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 0);
        fs::remove_dir(directory).unwrap();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn memory_filesystems_are_not_used_as_backing() {
        let directory = Path::new("/dev/shm");
        if directory.is_dir() {
            assert!(reject_memory_filesystem(directory).is_err());
        }
    }
}
