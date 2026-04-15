//! CLI thumbnail extractor for VOXL V2 files.
//!
//! Used as the backend for Linux thumbnailers and macOS QuickLook extensions.
//!
//! Usage:
//!   dragonfruit-voxl-thumbnailer <input.voxl> <output.png> [size]
//!   dragonfruit-voxl-thumbnailer --size <pixels> <input.voxl> <output.png>
//!
//! The `size` argument is the maximum dimension in pixels (default 256).
//! It also accepts the freedesktop thumbnailer format:  %i %o %s

use std::path::PathBuf;
use std::process;

fn main() {
    let args: Vec<String> = std::env::args().collect();

    let (input, output, size) = match parse_args(&args) {
        Some(v) => v,
        None => {
            eprintln!(
                "Usage: {} <input.voxl> <output.png> [size]\n       {} --size <px> <input.voxl> <output.png>",
                args[0], args[0]
            );
            process::exit(2);
        }
    };

    match dragonfruit_voxl_thumbnail::extract_thumbnail_resized(&input, size) {
        Ok(png) => {
            if let Err(e) = std::fs::write(&output, &png) {
                eprintln!("error: failed to write {}: {}", output.display(), e);
                process::exit(1);
            }
        }
        Err(e) => {
            eprintln!("error: {}", e);
            process::exit(1);
        }
    }
}

fn parse_args(args: &[String]) -> Option<(PathBuf, PathBuf, u32)> {
    if args.len() < 3 {
        return None;
    }

    // --size <px> <input> <output>
    if args.len() >= 5 && args[1] == "--size" {
        let size: u32 = args[2].parse().ok()?;
        return Some((PathBuf::from(&args[3]), PathBuf::from(&args[4]), size));
    }

    // <input> <output> [size]   (freedesktop thumbnailer format)
    let input = PathBuf::from(&args[1]);
    let output = PathBuf::from(&args[2]);
    let size = if args.len() > 3 {
        args[3].parse().unwrap_or(256)
    } else {
        256
    };

    Some((input, output, size))
}
