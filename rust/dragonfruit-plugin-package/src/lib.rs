//! `.dfplugin` package parsing, verification and sealing.
//!
//! The format is specified in `docs/dev/plugins-sideloaded.md`. In short: a ZIP
//! holding a plaintext signed manifest, a detached Ed25519 signature over that
//! manifest's exact bytes, and an AEAD-sealed payload ZIP.
//!
//! The manifest is plaintext so the import UI can show publisher, capabilities
//! and app range *before* asking for a key. The payload is the only part that is
//! sealed, and the seal is distribution control, not DRM.
//!
//! Licensed **MIT OR Apache-2.0**: a vendor's packaging tool links this crate to
//! write the format, so it must not drag AGPL terms into their build. It contains
//! no host code — only the format, its verification and its sealing.

use std::collections::BTreeMap;
use std::io::{Cursor, Read, Write};
use std::path::Path;

use argon2::{Algorithm, Argon2, Params, Version};
use base64::Engine as _;
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const FORMAT_VERSION: u32 = 1;
/// Wire protocol the host speaks to the plugin process. Owned by the SDK so the
/// two cannot drift; re-exported here because the manifest validates against it.
pub use dragonfruit_plugin_sdk::PROTOCOL_VERSION;
/// The manifest and the wire must name the same capabilities and transports, so
/// they are one definition rather than two that drift.
pub use dragonfruit_plugin_sdk::{Capability, Transport};

pub const MANIFEST_ENTRY: &str = "dfplugin.json";
pub const SIGNATURE_ENTRY: &str = "signature.ed25519";
pub const PAYLOAD_ENTRY: &str = "payload.bin";

const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
const MAX_PAYLOAD_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_PAYLOAD_FILE_BYTES: u64 = 512 * 1024 * 1024;
/// Payload roots a package may ship. Anything else is a packaging mistake or an
/// attempt to drop files somewhere the host does not expect.
const ALLOWED_PAYLOAD_ROOTS: &[&str] = &["bin/", "lib/", "assets/"];
const ALLOWED_PAYLOAD_FILES: &[&str] = &["README.md"];

const NONCE_BYTES: usize = 24;
const KEY_BYTES: usize = 32;
const SALT_BYTES: usize = 16;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum EntryKind {
    Process,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Vendor {
    pub name: String,
    #[serde(default)]
    pub homepage: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub kind: EntryKind,
    pub proto: u32,
    #[serde(default = "default_transport")]
    pub transport: Transport,
}

fn default_transport() -> Transport {
    Transport::Shm
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Publisher {
    /// Base64 Ed25519 public key. Trust on first use: the host pins a
    /// fingerprint per plugin id and refuses a silent key change.
    pub key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Seal {
    pub alg: String,
    pub kdf: String,
    pub salt: String,
    pub m: u32,
    pub t: u32,
    pub p: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadRef {
    pub sha256: String,
    pub bytes: u64,
    #[serde(default)]
    pub seal: Option<Seal>,
}

/// What the encoder wants per layer. RLE is the cheap path: the engine already
/// rasterises to runs and a run stream is far smaller than a PNG of the same
/// layer. PNG stays the default for formats that need pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LayerKind {
    Png,
    Rle,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatDecl {
    pub id: String,
    pub extensions: Vec<String>,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub layers: Option<LayerKind>,
}

impl FormatDecl {
    pub fn layer_kind(&self) -> LayerKind {
        self.layers.unwrap_or(LayerKind::Png)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkDecl {
    pub plugin_id: String,
}

/// An extension the package can open. Declared here, not discovered at runtime:
/// the host matches a dropped file by extension before it starts anything.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileTypeDecl {
    /// Lowercase, leading dot.
    pub extension: String,
    pub display_name: String,
    /// True when the payload is a scene (models, supports, transforms) rather
    /// than a single mesh.
    #[serde(default)]
    pub is_scene_file: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub format_version: u32,
    pub id: String,
    pub name: String,
    pub version: String,
    pub vendor: Vendor,
    pub min_app_version: String,
    pub capabilities: Vec<Capability>,
    pub entry: Entry,
    pub publisher: Publisher,
    pub payload: PayloadRef,
    #[serde(default)]
    pub formats: Vec<FormatDecl>,
    #[serde(default)]
    pub network: Option<NetworkDecl>,
    #[serde(default)]
    pub file_types: Vec<FileTypeDecl>,
}

/// A package whose manifest parsed and whose signature verified. The payload is
/// still sealed here; `unseal` is the step that needs the passphrase.
#[derive(Debug, Clone)]
pub struct Inspected {
    pub manifest: Manifest,
    /// Hex SHA-256 of the publisher key — what the UI shows for comparison and
    /// what the host pins per plugin id.
    pub publisher_fingerprint: String,
    pub sealed: bool,
}

#[derive(Debug)]
pub enum PackageError {
    Io(String),
    Zip(String),
    Json(String),
    Unsupported(String),
    Invalid(String),
    SignatureInvalid,
    Sealed,
    WrongKey,
    HashMismatch,
}

impl std::fmt::Display for PackageError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(detail) => write!(f, "I/O error: {detail}"),
            Self::Zip(detail) => write!(f, "Package archive is not a readable ZIP: {detail}"),
            Self::Json(detail) => write!(f, "Manifest is not valid JSON: {detail}"),
            Self::Unsupported(detail) => write!(f, "Unsupported: {detail}"),
            Self::Invalid(detail) => write!(f, "Invalid package: {detail}"),
            Self::SignatureInvalid => write!(f, "Manifest signature does not verify"),
            Self::Sealed => write!(f, "Package is sealed; a passphrase is required"),
            Self::WrongKey => write!(f, "Passphrase does not unseal this package"),
            Self::HashMismatch => write!(f, "Payload hash does not match the manifest"),
        }
    }
}

impl std::error::Error for PackageError {}

fn zip_err(err: zip::result::ZipError) -> PackageError {
    PackageError::Zip(err.to_string())
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn read_entry<R: Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
    name: &str,
    max_bytes: u64,
) -> Result<Vec<u8>, PackageError> {
    let mut file = archive
        .by_name(name)
        .map_err(|_| PackageError::Invalid(format!("missing {name}")))?;
    if file.size() > max_bytes {
        return Err(PackageError::Invalid(format!("{name} is too large")));
    }
    let mut out = Vec::with_capacity(file.size() as usize);
    file.read_to_end(&mut out).map_err(|err| PackageError::Io(err.to_string()))?;
    Ok(out)
}

fn decode_key(manifest: &Manifest) -> Result<VerifyingKey, PackageError> {
    let raw = base64::engine::general_purpose::STANDARD
        .decode(manifest.publisher.key.trim())
        .map_err(|_| PackageError::Invalid("publisher key is not base64".to_string()))?;
    let bytes: [u8; 32] = raw
        .try_into()
        .map_err(|_| PackageError::Invalid("publisher key must be 32 bytes".to_string()))?;
    VerifyingKey::from_bytes(&bytes)
        .map_err(|_| PackageError::Invalid("publisher key is not a valid Ed25519 key".to_string()))
}

fn validate(manifest: &Manifest) -> Result<(), PackageError> {
    if manifest.format_version != FORMAT_VERSION {
        return Err(PackageError::Unsupported(format!(
            "formatVersion {} (this build knows {FORMAT_VERSION})",
            manifest.format_version
        )));
    }
    if manifest.entry.proto != PROTOCOL_VERSION {
        return Err(PackageError::Unsupported(format!(
            "protocol {} (this build knows {PROTOCOL_VERSION})",
            manifest.entry.proto
        )));
    }
    if manifest.id.trim().is_empty() || manifest.id.len() > 120 {
        return Err(PackageError::Invalid("id must be 1..120 characters".to_string()));
    }
    if !manifest
        .id
        .chars()
        .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || matches!(ch, '.' | '_' | '-'))
    {
        return Err(PackageError::Invalid(
            "id may only contain a-z, 0-9, '.', '_' and '-'".to_string(),
        ));
    }
    if manifest.name.trim().is_empty() || manifest.name.len() > 120 {
        return Err(PackageError::Invalid("name must be 1..120 characters".to_string()));
    }
    if manifest.version.trim().is_empty() || manifest.version.len() > 48 {
        return Err(PackageError::Invalid("version must be 1..48 characters".to_string()));
    }
    if manifest.capabilities.is_empty() {
        return Err(PackageError::Invalid(
            "a package must declare at least one capability".to_string(),
        ));
    }
    if !manifest.file_types.is_empty() && !manifest.capabilities.contains(&Capability::FileType) {
        return Err(PackageError::Invalid(
            "fileTypes are declared but the fileType capability is not".to_string(),
        ));
    }
    for file_type in &manifest.file_types {
        if !file_type.extension.starts_with('.')
            || file_type.extension.len() < 2
            || file_type.extension.len() > 16
        {
            return Err(PackageError::Invalid(format!(
                "file type extension '{}' must start with '.' and be 2..16 characters",
                file_type.extension
            )));
        }
        if file_type.extension != file_type.extension.to_ascii_lowercase() {
            return Err(PackageError::Invalid(format!(
                "file type extension '{}' must be lowercase",
                file_type.extension
            )));
        }
        if file_type.display_name.trim().is_empty() {
            return Err(PackageError::Invalid(format!(
                "file type '{}' needs a display name",
                file_type.extension
            )));
        }
    }
    for format in &manifest.formats {
        if format.extensions.is_empty() {
            return Err(PackageError::Invalid(format!(
                "format '{}' declares no extensions",
                format.id
            )));
        }
        for extension in &format.extensions {
            if !extension.starts_with('.') || extension.len() < 2 || extension.len() > 16 {
                return Err(PackageError::Invalid(format!(
                    "format extension '{extension}' must start with '.' and be 2..16 characters"
                )));
            }
        }
    }
    Ok(())
}

/// Parse and verify a package without touching the payload.
pub fn inspect(bytes: &[u8]) -> Result<Inspected, PackageError> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(zip_err)?;
    let manifest_bytes = read_entry(&mut archive, MANIFEST_ENTRY, MAX_MANIFEST_BYTES)?;
    let signature_bytes = read_entry(&mut archive, SIGNATURE_ENTRY, 1024)?;

    let manifest: Manifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|err| PackageError::Json(err.to_string()))?;
    validate(&manifest)?;

    let key = decode_key(&manifest)?;
    let signature = Signature::from_slice(&signature_bytes)
        .map_err(|_| PackageError::SignatureInvalid)?;
    key.verify_strict(&manifest_bytes, &signature)
        .map_err(|_| PackageError::SignatureInvalid)?;

    Ok(Inspected {
        publisher_fingerprint: sha256_hex(&key.to_bytes()),
        sealed: manifest.payload.seal.is_some(),
        manifest,
    })
}

fn derive_key(passphrase: &str, seal: &Seal) -> Result<[u8; KEY_BYTES], PackageError> {
    if seal.alg != "xchacha20poly1305" {
        return Err(PackageError::Unsupported(format!("seal algorithm '{}'", seal.alg)));
    }
    if seal.kdf != "argon2id" {
        return Err(PackageError::Unsupported(format!("seal kdf '{}'", seal.kdf)));
    }
    let salt = base64::engine::general_purpose::STANDARD
        .decode(seal.salt.trim())
        .map_err(|_| PackageError::Invalid("seal salt is not base64".to_string()))?;
    let params = Params::new(seal.m, seal.t, seal.p, Some(KEY_BYTES))
        .map_err(|err| PackageError::Invalid(format!("seal parameters: {err}")))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = [0u8; KEY_BYTES];
    argon
        .hash_password_into(passphrase.as_bytes(), &salt, &mut key)
        .map_err(|err| PackageError::Invalid(format!("key derivation failed: {err}")))?;
    Ok(key)
}

/// Derive the seal key a package's `seal` block describes.
///
/// The host keeps it after a successful import (owner-only file in the plugin's
/// directory) so a later re-extract does not re-prompt. Exposed rather than
/// inlined into `unseal` for exactly that reason.
pub fn derive_seal_key(passphrase: &str, seal: &Seal) -> Result<[u8; KEY_BYTES], PackageError> {
    derive_key(passphrase, seal)
}

/// Unseal the payload and check it against the manifest hash. Returns the
/// plaintext payload ZIP bytes.
pub fn unseal(bytes: &[u8], inspected: &Inspected, passphrase: &str) -> Result<Vec<u8>, PackageError> {
    let seal = inspected
        .manifest
        .payload
        .seal
        .as_ref()
        .ok_or(PackageError::Sealed)?;
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(zip_err)?;
    let sealed = read_entry(&mut archive, PAYLOAD_ENTRY, MAX_PAYLOAD_BYTES)?;

    if sealed.len() <= NONCE_BYTES {
        return Err(PackageError::Invalid("payload is truncated".to_string()));
    }
    let (nonce, ciphertext) = sealed.split_at(NONCE_BYTES);
    let key = derive_key(passphrase, seal)?;
    let cipher = XChaCha20Poly1305::new(Key::from_slice(&key));
    let plaintext = cipher
        .decrypt(XNonce::from_slice(nonce), ciphertext)
        .map_err(|_| PackageError::WrongKey)?;

    if plaintext.len() as u64 != inspected.manifest.payload.bytes {
        return Err(PackageError::HashMismatch);
    }
    if sha256_hex(&plaintext) != inspected.manifest.payload.sha256.to_ascii_lowercase() {
        return Err(PackageError::HashMismatch);
    }
    Ok(plaintext)
}

/// True when a payload entry is allowed to be written out.
pub fn payload_entry_allowed(name: &str) -> bool {
    if name.contains("..") || name.starts_with('/') || name.contains('\\') {
        return false;
    }
    ALLOWED_PAYLOAD_FILES.contains(&name)
        || ALLOWED_PAYLOAD_ROOTS.iter().any(|root| name.starts_with(root) && name.len() > root.len())
}

/// Extract a plaintext payload ZIP into `dest`, refusing anything outside the
/// allowed roots or with traversal in the name. Returns the written paths,
/// relative to `dest`.
pub fn extract_payload(payload_zip: &[u8], dest: &Path) -> Result<Vec<String>, PackageError> {
    let mut archive = zip::ZipArchive::new(Cursor::new(payload_zip)).map_err(zip_err)?;
    let mut written = Vec::new();
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(zip_err)?;
        let name = entry.name().to_string();
        if entry.is_dir() {
            continue;
        }
        if !payload_entry_allowed(&name) {
            return Err(PackageError::Invalid(format!("payload entry '{name}' is not allowed")));
        }
        if entry.size() > MAX_PAYLOAD_FILE_BYTES {
            return Err(PackageError::Invalid(format!("payload entry '{name}' is too large")));
        }
        let target = dest.join(&name);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|err| PackageError::Io(err.to_string()))?;
        }
        let mut out = Vec::with_capacity(entry.size() as usize);
        entry
            .read_to_end(&mut out)
            .map_err(|err| PackageError::Io(err.to_string()))?;
        std::fs::write(&target, &out).map_err(|err| PackageError::Io(err.to_string()))?;
        written.push(name);
    }
    Ok(written)
}

/// Build a payload ZIP from `(path, bytes)` pairs. Paths are validated with the
/// same rules `extract_payload` enforces, so a package cannot be built that the
/// host would refuse.
pub fn build_payload_zip(files: &BTreeMap<String, Vec<u8>>) -> Result<Vec<u8>, PackageError> {
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    for (name, bytes) in files {
        if !payload_entry_allowed(name) {
            return Err(PackageError::Invalid(format!("payload entry '{name}' is not allowed")));
        }
        writer.start_file(name.as_str(), options).map_err(zip_err)?;
        writer.write_all(bytes).map_err(|err| PackageError::Io(err.to_string()))?;
    }
    let cursor = writer.finish().map_err(zip_err)?;
    Ok(cursor.into_inner())
}

/// Seal `payload_zip` with `passphrase`, returning the ciphertext (nonce
/// prefixed) and the manifest fields that describe it.
pub fn seal_payload(
    payload_zip: &[u8],
    passphrase: &str,
    nonce: [u8; NONCE_BYTES],
    salt: [u8; SALT_BYTES],
) -> Result<(Vec<u8>, Seal), PackageError> {
    let params = Params::new(64 * 1024, 3, 1, Some(KEY_BYTES))
        .map_err(|err| PackageError::Invalid(format!("seal parameters: {err}")))?;
    let seal = Seal {
        alg: "xchacha20poly1305".to_string(),
        kdf: "argon2id".to_string(),
        salt: base64::engine::general_purpose::STANDARD.encode(salt),
        m: 64 * 1024,
        t: 3,
        p: 1,
    };
    let _ = params;
    let key = derive_key(passphrase, &seal)?;
    let cipher = XChaCha20Poly1305::new(Key::from_slice(&key));
    let ciphertext = cipher
        .encrypt(XNonce::from_slice(&nonce), payload_zip)
        .map_err(|_| PackageError::Invalid("sealing failed".to_string()))?;
    let mut sealed = Vec::with_capacity(NONCE_BYTES + ciphertext.len());
    sealed.extend_from_slice(&nonce);
    sealed.extend_from_slice(&ciphertext);
    Ok((sealed, seal))
}

/// Assemble a complete `.dfplugin` archive: fills `payload` in the manifest,
/// signs the serialized manifest, and writes the three entries.
///
/// `nonce`/`salt` are caller-supplied so packaging is deterministic in tests.
pub fn build_package(
    manifest: &Manifest,
    payload_zip: &[u8],
    passphrase: Option<&str>,
    nonce: [u8; NONCE_BYTES],
    salt: [u8; SALT_BYTES],
    signing_key: &SigningKey,
) -> Result<Vec<u8>, PackageError> {
    let mut manifest = manifest.clone();
    manifest.format_version = FORMAT_VERSION;
    manifest.payload = PayloadRef {
        sha256: sha256_hex(payload_zip),
        bytes: payload_zip.len() as u64,
        seal: None,
    };

    let (payload_bytes, seal) = match passphrase {
        Some(passphrase) => {
            let (sealed, seal) = seal_payload(payload_zip, passphrase, nonce, salt)?;
            (sealed, Some(seal))
        }
        None => (payload_zip.to_vec(), None),
    };
    manifest.payload.seal = seal;
    validate(&manifest)?;

    let manifest_bytes =
        serde_json::to_vec_pretty(&manifest).map_err(|err| PackageError::Json(err.to_string()))?;
    let signature = signing_key.sign(&manifest_bytes);

    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Stored);
    writer.start_file(MANIFEST_ENTRY, options).map_err(zip_err)?;
    writer
        .write_all(&manifest_bytes)
        .map_err(|err| PackageError::Io(err.to_string()))?;
    writer.start_file(SIGNATURE_ENTRY, options).map_err(zip_err)?;
    writer
        .write_all(&signature.to_bytes())
        .map_err(|err| PackageError::Io(err.to_string()))?;
    writer.start_file(PAYLOAD_ENTRY, options).map_err(zip_err)?;
    writer
        .write_all(&payload_bytes)
        .map_err(|err| PackageError::Io(err.to_string()))?;
    let cursor = writer.finish().map_err(zip_err)?;
    Ok(cursor.into_inner())
}

/// Seal with a fresh random nonce and salt.
///
/// This is the entry point a packaging tool should use: reusing a nonce under the
/// same key breaks XChaCha20-Poly1305 outright, and a predictable salt weakens
/// the Argon2id derivation. `build_package` takes both explicitly for
/// reproducible builds and tests only.
pub fn build_package_sealed(
    manifest: &Manifest,
    payload_zip: &[u8],
    passphrase: &str,
    signing_key: &SigningKey,
) -> Result<Vec<u8>, PackageError> {
    let mut nonce = [0u8; NONCE_BYTES];
    let mut salt = [0u8; SALT_BYTES];
    getrandom::getrandom(&mut nonce).map_err(|err| PackageError::Io(err.to_string()))?;
    getrandom::getrandom(&mut salt).map_err(|err| PackageError::Io(err.to_string()))?;
    build_package(manifest, payload_zip, Some(passphrase), nonce, salt, signing_key)
}

/// Public key bytes as base64, for embedding in a manifest.
pub fn publisher_key_base64(key: &VerifyingKey) -> String {
    base64::engine::general_purpose::STANDARD.encode(key.to_bytes())
}

/// Re-exported so packaging tools and tests can hold a key without depending on
/// the exact `ed25519-dalek` version this crate resolves.
pub use ed25519_dalek::SigningKey as PluginSigningKey;

/// Deterministic key from a 32-byte seed. For tests and the reference packer;
/// a real vendor generates and stores a keypair.
pub fn signing_key_from_seed(seed: [u8; 32]) -> PluginSigningKey {
    PluginSigningKey::from_bytes(&seed)
}

/// Public key an existing signing key publishes, base64, ready for a manifest.
pub fn publisher_key_for(key: &PluginSigningKey) -> String {
    publisher_key_base64(&key.verifying_key())
}

#[cfg(test)]
mod tests {
    use super::*;

    const PASSPHRASE: &str = "correct horse battery staple";
    const SEED: [u8; 32] = [7u8; 32];

    fn signing_key() -> SigningKey {
        SigningKey::from_bytes(&SEED)
    }

    fn manifest_for(key: &SigningKey) -> Manifest {
        Manifest {
            format_version: FORMAT_VERSION,
            id: "alphabeta.alphaprint".to_string(),
            name: "AlphaPrint Format".to_string(),
            version: "1.0.0".to_string(),
            vendor: Vendor {
                name: "AlphaBeta".to_string(),
                homepage: None,
            },
            min_app_version: "0.4.0".to_string(),
            capabilities: vec![Capability::SlicerEncoder],
            entry: Entry {
                kind: EntryKind::Process,
                proto: PROTOCOL_VERSION,
                transport: Transport::Shm,
            },
            publisher: Publisher {
                key: publisher_key_base64(&key.verifying_key()),
            },
            payload: PayloadRef {
                sha256: String::new(),
                bytes: 0,
                seal: None,
            },
            formats: vec![FormatDecl {
                id: "apf".to_string(),
                extensions: vec![".apf".to_string()],
                display_name: None,
                layers: None,
            }],
            network: None,
            file_types: Vec::new(),
        }
    }

    fn payload() -> Vec<u8> {
        let mut files = BTreeMap::new();
        files.insert("bin/linux/alphaprint".to_string(), b"#!/bin/sh\n".to_vec());
        files.insert("README.md".to_string(), b"AlphaPrint plugin\n".to_vec());
        build_payload_zip(&files).expect("payload")
    }

    fn make_package(passphrase: Option<&str>) -> Vec<u8> {
        let key = signing_key();
        build_package(
            &manifest_for(&key),
            &payload(),
            passphrase,
            [1u8; NONCE_BYTES],
            [2u8; SALT_BYTES],
            &key,
        )
        .expect("package")
    }

    #[test]
    fn inspects_a_signed_package_and_reports_fingerprint() {
        let bytes = make_package(Some(PASSPHRASE));
        let inspected = inspect(&bytes).expect("inspect");
        assert_eq!(inspected.manifest.id, "alphabeta.alphaprint");
        assert!(inspected.sealed);
        assert_eq!(
            inspected.publisher_fingerprint,
            sha256_hex(&signing_key().verifying_key().to_bytes())
        );
    }

    #[test]
    fn rejects_a_tampered_manifest() {
        let bytes = make_package(None);
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).expect("zip");
        let mut entries: BTreeMap<String, Vec<u8>> = BTreeMap::new();
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index).expect("entry");
            let name = entry.name().to_string();
            let mut data = Vec::new();
            entry.read_to_end(&mut data).expect("read");
            entries.insert(name, data);
        }
        let manifest = entries.get_mut(MANIFEST_ENTRY).expect("manifest");
        let text = String::from_utf8(manifest.clone()).expect("utf8");
        *manifest = text.replace("\"1.0.0\"", "\"1.0.1\"").into_bytes();

        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default();
        for (name, data) in &entries {
            writer.start_file(name.as_str(), options).expect("start");
            writer.write_all(data).expect("write");
        }
        let tampered = writer.finish().expect("finish").into_inner();
        assert!(matches!(inspect(&tampered), Err(PackageError::SignatureInvalid)));
    }

    #[test]
    fn unseals_with_the_right_passphrase_only() {
        let bytes = make_package(Some(PASSPHRASE));
        let inspected = inspect(&bytes).expect("inspect");

        let wrong = unseal(&bytes, &inspected, "not the passphrase");
        assert!(matches!(wrong, Err(PackageError::WrongKey)), "wrong key accepted");

        let plaintext = unseal(&bytes, &inspected, PASSPHRASE).expect("unseal");
        assert_eq!(sha256_hex(&plaintext), inspected.manifest.payload.sha256);
    }

    #[test]
    fn rejects_a_payload_that_does_not_match_its_hash() {
        let key = signing_key();
        let mut manifest = manifest_for(&key);
        let payload_zip = payload();
        let (sealed, seal) = seal_payload(&payload_zip, PASSPHRASE, [3u8; NONCE_BYTES], [4u8; SALT_BYTES])
            .expect("seal");
        manifest.payload = PayloadRef {
            sha256: sha256_hex(b"something else"),
            bytes: payload_zip.len() as u64,
            seal: Some(seal),
        };
        let manifest_bytes = serde_json::to_vec_pretty(&manifest).expect("json");
        let signature = key.sign(&manifest_bytes);
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default();
        for (name, data) in [
            (MANIFEST_ENTRY, manifest_bytes.as_slice()),
            (SIGNATURE_ENTRY, signature.to_bytes().as_slice()),
            (PAYLOAD_ENTRY, sealed.as_slice()),
        ] {
            writer.start_file(name, options).expect("start");
            writer.write_all(data).expect("write");
        }
        let bytes = writer.finish().expect("finish").into_inner();

        let inspected = inspect(&bytes).expect("inspect");
        assert!(matches!(
            unseal(&bytes, &inspected, PASSPHRASE),
            Err(PackageError::HashMismatch)
        ));
    }

    #[test]
    fn refuses_an_unknown_format_or_protocol_version() {
        let key = signing_key();
        for mutate in [
            (|manifest: &mut Manifest| manifest.format_version = 99) as fn(&mut Manifest),
            |manifest: &mut Manifest| manifest.entry.proto = 99,
        ] {
            let mut manifest = manifest_for(&key);
            mutate(&mut manifest);
            let manifest_bytes = serde_json::to_vec_pretty(&manifest).expect("json");
            let signature = key.sign(&manifest_bytes);
            let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
            let options = zip::write::SimpleFileOptions::default();
            for (name, data) in [
                (MANIFEST_ENTRY, manifest_bytes.as_slice()),
                (SIGNATURE_ENTRY, signature.to_bytes().as_slice()),
                (PAYLOAD_ENTRY, payload().as_slice()),
            ] {
                writer.start_file(name, options).expect("start");
                writer.write_all(data).expect("write");
            }
            let bytes = writer.finish().expect("finish").into_inner();
            assert!(matches!(inspect(&bytes), Err(PackageError::Unsupported(_))));
        }
    }

    #[test]
    fn extraction_is_confined_to_allowed_roots() {
        let mut files = BTreeMap::new();
        files.insert("bin/linux/plugin".to_string(), b"x".to_vec());
        let payload_zip = build_payload_zip(&files).expect("payload");

        let dest = std::env::temp_dir().join(format!("dfplugin-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dest);
        let written = extract_payload(&payload_zip, &dest).expect("extract");
        assert_eq!(written, vec!["bin/linux/plugin".to_string()]);
        assert!(dest.join("bin/linux/plugin").exists());
        let _ = std::fs::remove_dir_all(&dest);

        assert!(!payload_entry_allowed("../escape"));
        assert!(!payload_entry_allowed("/etc/passwd"));
        assert!(!payload_entry_allowed("bin/../../escape"));
        assert!(!payload_entry_allowed("other/file"));
        assert!(payload_entry_allowed("assets/logo.png"));
        assert!(payload_entry_allowed("README.md"));
    }

    #[test]
    fn build_refuses_a_payload_entry_outside_the_allowed_roots() {
        let mut files = BTreeMap::new();
        files.insert("elsewhere/plugin".to_string(), b"x".to_vec());
        assert!(matches!(build_payload_zip(&files), Err(PackageError::Invalid(_))));
    }
}
