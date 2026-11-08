//! Bounded immutable JSON-field cache. No Tauri or process-global state.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};

pub const PAYLOAD_BUDGET: usize = 8 * 1024 * 1024;
pub const MAX_CHUNK_BYTES: usize = 4 * 1024 * 1024;
const MAX_ENTRIES: usize = 128;
const MAX_LEASES: usize = 16;
const FIELDS: [&str; 3] = ["metadata_json", "export_thumbnail_png_base64", "triangle_tank_index"];

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FieldSpec {
    pub field: String,
    pub hash: String,
    pub byte_len: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaseAck {
    pub lease_id: String,
    pub accepted_fields: Vec<String>,
    pub missing_fields: Vec<String>,
}

struct Entry {
    spec: FieldSpec,
    bytes: Vec<u8>,
    complete: bool,
    pins: usize,
    used: u64,
}

pub struct PayloadCache {
    entries: HashMap<String, Entry>,
    leases: HashMap<String, Vec<String>>,
    reserved: usize,
    clock: u64,
    next_id: u64,
    budget: usize,
}

impl Default for PayloadCache {
    fn default() -> Self { Self::new(PAYLOAD_BUDGET) }
}

fn key(spec: &FieldSpec) -> String { format!("{}:{}", spec.field, spec.hash) }

fn valid_spec(spec: &FieldSpec) -> bool {
    FIELDS.contains(&spec.field.as_str()) && spec.byte_len > 0
        && spec.hash.len() == 64
        && spec.hash.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn validate_value(field: &str, value: &Value) -> bool {
    match field {
        "metadata_json" => value.is_string(),
        "export_thumbnail_png_base64" => value.is_string() || value.is_null(),
        "triangle_tank_index" => value.as_array().is_some_and(|items| {
            items.iter().all(|v| v.as_u64().is_some_and(|n| n <= u32::MAX as u64))
        }),
        _ => false,
    }
}

impl PayloadCache {
    pub fn new(budget: usize) -> Self {
        Self { entries: HashMap::new(), leases: HashMap::new(), reserved: 0,
            clock: 0, next_id: 0, budget: budget.min(PAYLOAD_BUDGET) }
    }

    pub fn begin(&mut self, specs: Vec<FieldSpec>) -> Result<LeaseAck, String> {
        if specs.len() > FIELDS.len() || specs.iter().any(|s| !valid_spec(s)) {
            return Err("Invalid job payload field manifest".into());
        }
        let mut unique = std::collections::HashSet::new();
        if specs.iter().any(|s| !unique.insert(s.field.as_str())) {
            return Err("Duplicate job payload field".into());
        }
        if self.leases.len() >= MAX_LEASES { return Err("Too many job payload leases".into()); }
        // Protect all requested hits before admitting misses: one cold field must not
        // evict a later field in the same manifest. A pending upload is never shared.
        for spec in &specs {
            if let Some(entry) = self.entries.get(&key(spec)) {
                if entry.spec.byte_len != spec.byte_len { return Err("Job payload length mismatch".into()); }
            }
        }
        let wanted: std::collections::HashSet<String> = specs.iter().map(key).collect();
        let mut accepted_fields = Vec::new();
        let mut missing_fields = Vec::new();
        let mut pins = Vec::new();
        for spec in specs {
            let id = key(&spec);
            self.clock += 1;
            if let Some(entry) = self.entries.get_mut(&id) {
                if entry.complete {
                    entry.pins += 1;
                    entry.used = self.clock;
                    accepted_fields.push(spec.field);
                    pins.push(id);
                }
                continue;
            }
            if spec.byte_len > self.budget { continue; }
            while self.reserved + spec.byte_len > self.budget || self.entries.len() >= MAX_ENTRIES {
                let victim = self.entries.iter()
                    .filter(|(k, e)| e.pins == 0 && !wanted.contains(*k))
                    .min_by(|(ka, a), (kb, b)| a.used.cmp(&b.used).then_with(|| ka.cmp(kb)))
                    .map(|(k, _)| k.clone());
                let Some(victim) = victim else { break; };
                let removed = self.entries.remove(&victim).unwrap();
                self.reserved -= removed.spec.byte_len;
            }
            if self.reserved + spec.byte_len > self.budget || self.entries.len() >= MAX_ENTRIES { continue; }
            self.reserved += spec.byte_len;
            accepted_fields.push(spec.field.clone());
            missing_fields.push(spec.field.clone());
            self.entries.insert(id.clone(), Entry { bytes: Vec::new(), spec,
                complete: false, pins: 1, used: self.clock });
            pins.push(id);
        }
        self.next_id += 1;
        let lease_id = self.next_id.to_string();
        self.leases.insert(lease_id.clone(), pins);
        Ok(LeaseAck { lease_id, accepted_fields, missing_fields })
    }

    pub fn append(&mut self, lease: &str, field: &str, hash: &str, offset: usize, bytes: &[u8]) -> Result<(), String> {
        if bytes.is_empty() || bytes.len() > MAX_CHUNK_BYTES { return Err("Invalid job payload chunk length".into()); }
        let id = format!("{field}:{hash}");
        let fields = self.leases.get(lease).ok_or("Unknown job payload lease")?;
        if !fields.contains(&id) { return Err("Field is not owned by job payload lease".into()); }
        let entry = self.entries.get_mut(&id).ok_or("Missing job payload entry")?;
        if entry.complete || entry.bytes.len() != offset
            || bytes.len() > entry.spec.byte_len.saturating_sub(offset) {
            return Err("Invalid job payload chunk offset or length".into());
        }
        // Reserve exactly once rather than geometric growth beyond the payload bound.
        if entry.bytes.capacity() == 0 { entry.bytes.reserve_exact(entry.spec.byte_len); }
        entry.bytes.extend_from_slice(bytes);
        Ok(())
    }

    pub fn finish(&mut self, lease: &str) -> Result<(), String> {
        let fields = self.leases.get(lease).ok_or("Unknown job payload lease")?;
        for id in fields {
            let entry = self.entries.get_mut(id).ok_or("Missing job payload entry")?;
            if entry.complete { continue; }
            if entry.bytes.len() != entry.spec.byte_len { return Err("Incomplete job payload field".into()); }
            let hash = format!("{:x}", Sha256::digest(&entry.bytes));
            if hash != entry.spec.hash { return Err("Job payload SHA-256 mismatch".into()); }
            let value: Value = serde_json::from_slice(&entry.bytes)
                .map_err(|e| format!("Invalid job payload UTF-8/JSON: {e}"))?;
            if !validate_value(&entry.spec.field, &value) { return Err("Invalid job payload field value".into()); }
            entry.complete = true;
        }
        Ok(())
    }

    pub fn release(&mut self, lease: &str) {
        if let Some(fields) = self.leases.remove(lease) {
            for id in fields {
                if let Some(entry) = self.entries.get_mut(&id) {
                    entry.pins -= 1;
                    if entry.pins == 0 && !entry.complete {
                        self.reserved -= entry.spec.byte_len;
                        self.entries.remove(&id);
                    }
                }
            }
        }
    }

    /// Expands references and releases pins on *every* outcome, before stage take.
    pub fn resolve(&mut self, json: &str, lease: Option<&str>) -> Result<Value, String> {
        let result = self.resolve_inner(json, lease);
        if let Some(lease) = lease { self.release(lease); }
        result
    }

    fn resolve_inner(&self, json: &str, lease: Option<&str>) -> Result<Value, String> {
        let mut value: Value = serde_json::from_str(json).map_err(|e| format!("Invalid slice job JSON: {e}"))?;
        let object = value.as_object_mut().ok_or("Slice job must be an object")?;
        let refs = object.remove("_payload_refs");
        let Some(lease) = lease else {
            if refs.is_some() { return Err("Job payload references require a lease".into()); }
            return Ok(value);
        };
        let fields = self.leases.get(lease).ok_or("Unknown job payload lease")?;
        let refs: BTreeMap<String, String> = serde_json::from_value(refs.unwrap_or(serde_json::json!({})))
            .map_err(|e| format!("Invalid job payload references: {e}"))?;
        if refs.len() != fields.len() { return Err("Job payload reference manifest mismatch".into()); }
        for (field, hash) in refs {
            if !FIELDS.contains(&field.as_str()) || object.contains_key(&field) {
                return Err("Unknown or duplicate job payload field reference".into());
            }
            let id = format!("{field}:{hash}");
            if !fields.contains(&id) { return Err("Stale job payload reference".into()); }
            let entry = self.entries.get(&id).ok_or("Missing job payload reference")?;
            if !entry.complete { return Err("Unfinished job payload reference".into()); }
            let restored = serde_json::from_slice(&entry.bytes).map_err(|e| format!("Invalid cached job payload: {e}"))?;
            object.insert(field, restored);
        }
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn spec(field: &str, bytes: &[u8]) -> FieldSpec {
        FieldSpec { field: field.into(), hash: format!("{:x}", Sha256::digest(bytes)), byte_len: bytes.len() }
    }
    fn upload(cache: &mut PayloadCache, field: &str, bytes: &[u8]) -> LeaseAck {
        let s = spec(field, bytes);
        let ack = cache.begin(vec![s.clone()]).unwrap();
        cache.append(&ack.lease_id, field, &s.hash, 0, bytes).unwrap();
        cache.finish(&ack.lease_id).unwrap();
        ack
    }
    #[test]
    fn restores_semantics_and_reuses_without_upload() {
        let mut cache = PayloadCache::new(1024);
        let bytes = br#""{\"scene\":\"full attachment\",\"settings\":true}""#;
        let ack = upload(&mut cache, "metadata_json", bytes);
        let json = serde_json::json!({"output_format":"lumen", "_payload_refs":{"metadata_json":spec("metadata_json",bytes).hash}}).to_string();
        let restored = cache.resolve(&json, Some(&ack.lease_id)).unwrap();
        assert_eq!(restored["metadata_json"], serde_json::from_slice::<Value>(bytes).unwrap());
        assert_eq!(restored["output_format"], "lumen");
        let hit = cache.begin(vec![spec("metadata_json", bytes)]).unwrap();
        assert!(hit.missing_fields.is_empty());
        cache.release(&hit.lease_id);
        assert!(cache.leases.is_empty());
    }
    #[test]
    fn integrity_utf8_json_and_field_validation() {
        for bytes in [&b"\xff"[..], &b"not json"[..], &b"123"[..]] {
            let mut cache = PayloadCache::new(1024);
            let s = spec("metadata_json", bytes);
            let ack = cache.begin(vec![s.clone()]).unwrap();
            cache.append(&ack.lease_id, &s.field, &s.hash, 0, bytes).unwrap();
            assert!(cache.finish(&ack.lease_id).is_err());
            cache.release(&ack.lease_id);
            assert_eq!(cache.reserved, 0);
        }
        let mut cache = PayloadCache::new(1024);
        let s = spec("metadata_json", br#""a""#);
        let ack = cache.begin(vec![s.clone()]).unwrap();
        cache.append(&ack.lease_id, &s.field, &s.hash, 0, br#""b""#).unwrap();
        assert!(cache.finish(&ack.lease_id).unwrap_err().contains("SHA-256"));
        cache.release(&ack.lease_id);
        assert!(cache.begin(vec![spec("output_path", b"null")]).is_err());
    }
    #[test]
    fn pins_bound_budget_and_cancel_frees_pending() {
        let mut cache = PayloadCache::new(8);
        let ack = upload(&mut cache, "metadata_json", br#""1234""#);
        let rejected = cache.begin(vec![spec("export_thumbnail_png_base64", br#""abcd""#)]).unwrap();
        assert!(rejected.accepted_fields.is_empty());
        cache.release(&rejected.lease_id);
        cache.release(&ack.lease_id);
        let admitted = cache.begin(vec![spec("export_thumbnail_png_base64", br#""abcd""#)]).unwrap();
        assert_eq!(admitted.missing_fields.len(), 1);
        cache.release(&admitted.lease_id);
        assert_eq!(cache.reserved, 0);
        assert!(cache.leases.is_empty());
    }
    #[test]
    fn stale_missing_and_failed_json_release_before_consumption() {
        let mut cache = PayloadCache::new(1024);
        let ack = upload(&mut cache, "triangle_tank_index", b"[0,1,1]");
        assert!(cache.resolve(r#"{"_payload_refs":{"triangle_tank_index":"stale"}}"#, Some(&ack.lease_id)).is_err());
        assert!(cache.leases.is_empty());
        assert!(cache.resolve(r#"{"_payload_refs":{"metadata_json":"missing"}}"#, None).is_err());
        let ack = cache.begin(vec![spec("metadata_json", br#""a""#)]).unwrap();
        assert!(cache.resolve("invalid", Some(&ack.lease_id)).is_err());
        assert!(cache.leases.is_empty());
    }
    #[test]
    fn rejects_out_of_order_chunks_and_duplicate_manifest() {
        let mut cache = PayloadCache::new(1024);
        let s = spec("metadata_json", br#""abc""#);
        assert!(cache.begin(vec![s.clone(), s.clone()]).is_err());
        let ack = cache.begin(vec![s.clone()]).unwrap();
        assert!(cache.append(&ack.lease_id, &s.field, &s.hash, 1, b"x").is_err());
        cache.release(&ack.lease_id);
        assert_eq!(cache.reserved, 0);
    }
    #[test]
    fn bounds_metadata_and_rejects_oversize_admission() {
        let mut cache = PayloadCache::new(1024 * 1024);
        for i in 0..200 {
            let bytes = format!("\"value-{i}\"").into_bytes();
            let ack = upload(&mut cache, "metadata_json", &bytes);
            cache.release(&ack.lease_id);
        }
        assert_eq!(cache.entries.len(), MAX_ENTRIES);
        let mut ids = Vec::new();
        for _ in 0..MAX_LEASES { ids.push(cache.begin(Vec::new()).unwrap().lease_id); }
        assert!(cache.begin(Vec::new()).is_err());
        for id in ids { cache.release(&id); }
        let mut oversized = spec("metadata_json", b"null");
        oversized.byte_len = PAYLOAD_BUDGET + 1;
        let ack = cache.begin(vec![oversized]).unwrap();
        assert!(ack.accepted_fields.is_empty());
        cache.release(&ack.lease_id);
    }
}
