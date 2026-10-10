//! 3MF parser. 3MF is a ZIP archive whose `3D/3dmodel.model` entry holds XML
//! with `<object>` resources (each a `<mesh>` and/or `<components>`) and a
//! `<build>` section whose `<item>` elements instance those objects.
//!
//! Bodies are resolved the way the renderer's loaders resolve them: every
//! `<build><item>` is expanded, components recurse, and each leaf mesh becomes
//! one body with its composed transform **baked into the vertices** (the
//! renderer applies `matrixWorld` to each mesh's geometry before use). The 3MF
//! `<transform>` string is a row-major 4×3 affine whose last three values are
//! the translation; [`Affine::from_3mf`] converts it to the column-vector form
//! this crate uses.
//!
//! Deliberately ignored, because the app ignores them too:
//! - **Units.** Both renderer loaders emit raw file units (three parses
//!   `unit=` but never scales; the fast loader's builder never reads it), so
//!   scaling here would change every multi-unit model's size on cutover.
//! - **Materials.** The renderer strips a mesh's `color` attribute and the app
//!   tints centrally, so a model's per-triangle materials carry no information
//!   downstream. That means one body per leaf mesh object, **not** one per
//!   `pid` group — three splits a multi-material object into a mesh per
//!   material, a rendering artifact the app would otherwise import as several
//!   bodies.
use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::path::Path;

use crate::core::mesh::{IndexedMesh, Vec3};
use crate::MeshRepairError;

/// A 3MF object resource: an indexed mesh or a list of component instances.
#[derive(Default)]
struct Object {
    mesh: Option<IndexedMesh>,
    /// `(objectid, local transform)` per `<component>`.
    components: Vec<(String, Affine)>,
}

/// Object resources in document order, addressable by id.
///
/// Order is kept for the degenerate no-`<build>` fallback: a hash map alone
/// would make body order depend on hashing, and body order is what the
/// frontend indexes split bodies by.
#[derive(Default)]
struct ObjectTable {
    order: Vec<String>,
    map: HashMap<String, Object>,
}

impl ObjectTable {
    fn insert(&mut self, id: String, object: Object) {
        if !self.map.contains_key(&id) {
            self.order.push(id.clone());
        }
        self.map.insert(id, object);
    }
}

/// Column-vector affine transform: `p' = linear · p + translation`.
///
/// 3MF stores a `transform` attribute as twelve space-separated numbers in
/// row-major 4×3 form with the translation last, and applies it to row vectors.
/// Converting to the column-vector convention transposes the linear part, which
/// is exactly what the renderer's `Matrix4.set(t0, t3, t6, t9, …)` does.
#[derive(Clone, Copy)]
struct Affine {
    linear: [[f32; 3]; 3],
    translation: [f32; 3],
}

impl Affine {
    const IDENTITY: Affine = Affine {
        linear: [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
        translation: [0.0, 0.0, 0.0],
    };

    fn from_3mf(values: &[f32; 12]) -> Self {
        Affine {
            linear: [
                [values[0], values[3], values[6]],
                [values[1], values[4], values[7]],
                [values[2], values[5], values[8]],
            ],
            translation: [values[9], values[10], values[11]],
        }
    }

    /// `parent ∘ child` — the child is applied first, then the parent, matching
    /// a build-item transform composed with the component transforms beneath it.
    fn compose(parent: Affine, child: Affine) -> Affine {
        let mut linear = [[0.0f32; 3]; 3];
        let mut translation = [0.0f32; 3];
        for row in 0..3 {
            for column in 0..3 {
                linear[row][column] = (0..3)
                    .map(|k| parent.linear[row][k] * child.linear[k][column])
                    .sum();
            }
            translation[row] = (0..3)
                .map(|k| parent.linear[row][k] * child.translation[k])
                .sum::<f32>()
                + parent.translation[row];
        }
        Affine {
            linear,
            translation,
        }
    }

    fn apply(&self, p: Vec3) -> Vec3 {
        Vec3::new(
            self.linear[0][0] * p.x + self.linear[0][1] * p.y + self.linear[0][2] * p.z
                + self.translation[0],
            self.linear[1][0] * p.x + self.linear[1][1] * p.y + self.linear[1][2] * p.z
                + self.translation[1],
            self.linear[2][0] * p.x + self.linear[2][1] * p.y + self.linear[2][2] * p.z
                + self.translation[2],
        )
    }
}

/// Parse a 3MF and return one `IndexedMesh` per body, transforms baked.
pub fn load_bodies(path: &Path) -> Result<Vec<IndexedMesh>, MeshRepairError> {
    let xml = read_model_xml(path)?;
    let objects = parse_objects(&xml)?;
    let build = parse_build(&xml)?;

    let roots: Vec<(String, Affine)> = if build.is_empty() {
        // A file with no usable `<build>` section still describes geometry;
        // import every mesh-only object as a body rather than failing. Files
        // that do have a build are never unioned this way.
        objects
            .order
            .iter()
            .filter(|id| {
                objects
                    .map
                    .get(*id)
                    .is_some_and(|o| o.mesh.is_some() && o.components.is_empty())
            })
            .map(|id| (id.clone(), Affine::IDENTITY))
            .collect()
    } else {
        build
    };

    let mut bodies = Vec::new();
    for (id, transform) in roots {
        expand_body(&objects, &id, transform, 0, &mut bodies)?;
    }
    if bodies.is_empty() {
        return Err(MeshRepairError::Parse(
            "3MF: build produced no mesh geometry".into(),
        ));
    }
    Ok(bodies)
}

/// Load a 3MF as a single mesh: every body merged, vertices offset.
pub fn load(path: &Path) -> Result<IndexedMesh, MeshRepairError> {
    let mut positions = Vec::new();
    let mut triangles = Vec::new();
    for body in load_bodies(path)? {
        let base = positions.len() as u32;
        positions.extend(body.positions);
        triangles.extend(
            body.triangles
                .iter()
                .map(|t| [t[0] + base, t[1] + base, t[2] + base]),
        );
    }
    Ok(IndexedMesh {
        positions,
        triangles,
    })
}

/// Depth cap for component recursion — a reference cycle otherwise recurses
/// until the stack dies, and a cycle is not a geometry error the caller can see.
const MAX_COMPONENT_DEPTH: usize = 64;

fn expand_body(
    objects: &ObjectTable,
    id: &str,
    world: Affine,
    depth: usize,
    out: &mut Vec<IndexedMesh>,
) -> Result<(), MeshRepairError> {
    if depth > MAX_COMPONENT_DEPTH {
        return Err(MeshRepairError::Parse(format!(
            "3MF: component nesting deeper than {MAX_COMPONENT_DEPTH} (cycle?) at object {id}"
        )));
    }
    let object = objects.map.get(id).ok_or_else(|| {
        MeshRepairError::Parse(format!("3MF: object {id} referenced but not defined"))
    })?;

    if !object.components.is_empty() {
        for (child_id, child_transform) in &object.components {
            expand_body(
                objects,
                child_id,
                Affine::compose(world, *child_transform),
                depth + 1,
                out,
            )?;
        }
        return Ok(());
    }

    if let Some(mesh) = &object.mesh {
        out.push(IndexedMesh {
            positions: mesh.positions.iter().map(|p| world.apply(*p)).collect(),
            triangles: mesh.triangles.clone(),
        });
    }
    Ok(())
}

fn read_model_xml(path: &Path) -> Result<String, MeshRepairError> {
    let file = File::open(path)?;
    let mut zip = zip::ZipArchive::new(file)
        .map_err(|e| MeshRepairError::Parse(format!("3MF zip open: {e}")))?;

    // Primary model file, found by extension rather than by rels — sufficient
    // for single-model slicer input.
    let mut model_name: Option<String> = None;
    for i in 0..zip.len() {
        let entry = zip
            .by_index(i)
            .map_err(|e| MeshRepairError::Parse(format!("3MF zip entry: {e}")))?;
        let name = entry.name().to_string();
        if name.to_ascii_lowercase().ends_with(".model") {
            model_name = Some(name);
            break;
        }
    }
    let model_name =
        model_name.ok_or_else(|| MeshRepairError::Parse("3MF: no .model entry".into()))?;

    let mut xml = String::new();
    zip.by_name(&model_name)
        .map_err(|e| MeshRepairError::Parse(format!("3MF read model: {e}")))?
        .read_to_string(&mut xml)?;
    Ok(xml)
}

fn parse_objects(xml: &str) -> Result<ObjectTable, MeshRepairError> {
    let mut table = ObjectTable::default();
    let mut cursor = 0;
    while let Some(open) = find_element(xml, cursor, "<object") {
        let open_end = tag_end(xml, open)
            .ok_or_else(|| MeshRepairError::Parse("3MF: unterminated <object>".into()))?;
        let id = parse_attr_str(&xml[open..open_end], "id")
            .ok_or_else(|| MeshRepairError::Parse("3MF: <object> without id".into()))?
            .to_string();
        let close = find_element(xml, open_end, "</object").ok_or_else(|| {
            MeshRepairError::Parse(format!("3MF: unterminated object {id}"))
        })?;
        table.insert(id, parse_object_block(&xml[open_end..close])?);
        cursor = close;
    }
    Ok(table)
}

fn parse_object_block(block: &str) -> Result<Object, MeshRepairError> {
    let mut object = Object::default();

    if let Some(open) = find_element(block, 0, "<mesh") {
        let close = find_element(block, open, "</mesh").ok_or_else(|| {
            MeshRepairError::Parse("3MF: unterminated <mesh>".into())
        })?;
        let open_end = tag_end(block, open)
            .ok_or_else(|| MeshRepairError::Parse("3MF: unterminated <mesh>".into()))?;
        object.mesh = parse_mesh_block(&block[open_end..close])?;
    }

    if let Some(open) = find_element(block, 0, "<components") {
        let close = find_element(block, open, "</components").ok_or_else(|| {
            MeshRepairError::Parse("3MF: unterminated <components>".into())
        })?;
        let open_end = tag_end(block, open)
            .ok_or_else(|| MeshRepairError::Parse("3MF: unterminated <components>".into()))?;
        object.components = parse_components_block(&block[open_end..close])?;
    }

    Ok(object)
}

fn parse_mesh_block(block: &str) -> Result<Option<IndexedMesh>, MeshRepairError> {
    let mut positions = Vec::new();
    let mut cursor = 0;
    while let Some(at) = find_element(block, cursor, "<vertex") {
        let end = tag_end(block, at)
            .ok_or_else(|| MeshRepairError::Parse("3MF: unterminated <vertex>".into()))?;
        let tag = &block[at..end];
        positions.push(Vec3::new(
            parse_attr_f32(tag, "x").unwrap_or(0.0),
            parse_attr_f32(tag, "y").unwrap_or(0.0),
            parse_attr_f32(tag, "z").unwrap_or(0.0),
        ));
        cursor = end;
    }

    let mut triangles = Vec::new();
    let mut cursor = 0;
    while let Some(at) = find_element(block, cursor, "<triangle") {
        let end = tag_end(block, at)
            .ok_or_else(|| MeshRepairError::Parse("3MF: unterminated <triangle>".into()))?;
        let tag = &block[at..end];
        let index = |name: &str| -> Result<u32, MeshRepairError> {
            parse_attr_u32(tag, name).ok_or_else(|| {
                MeshRepairError::Parse(format!("3MF: <triangle> missing {name}"))
            })
        };
        triangles.push([index("v1")?, index("v2")?, index("v3")?]);
        cursor = end;
    }

    if positions.is_empty() || triangles.is_empty() {
        return Ok(None);
    }
    let count = positions.len() as u32;
    if triangles.iter().flatten().any(|&i| i >= count) {
        return Err(MeshRepairError::Parse(
            "3MF: triangle references a vertex outside its mesh".into(),
        ));
    }
    Ok(Some(IndexedMesh {
        positions,
        triangles,
    }))
}

fn parse_components_block(block: &str) -> Result<Vec<(String, Affine)>, MeshRepairError> {
    let mut components = Vec::new();
    let mut cursor = 0;
    while let Some(at) = find_element(block, cursor, "<component") {
        let end = tag_end(block, at)
            .ok_or_else(|| MeshRepairError::Parse("3MF: unterminated <component>".into()))?;
        let tag = &block[at..end];
        if let Some(id) = parse_attr_str(tag, "objectid") {
            components.push((
                id.to_string(),
                parse_transform(tag)?.unwrap_or(Affine::IDENTITY),
            ));
        }
        cursor = end;
    }
    Ok(components)
}

fn parse_build(xml: &str) -> Result<Vec<(String, Affine)>, MeshRepairError> {
    let Some(open) = find_element(xml, 0, "<build") else {
        return Ok(Vec::new());
    };
    // A `<build/>` that closes on itself has no items; `find_element` for the
    // close otherwise scans past it.
    let Some(close) = find_element(xml, open, "</build") else {
        return Ok(Vec::new());
    };
    let Some(open_end) = tag_end(xml, open) else {
        return Ok(Vec::new());
    };
    let block = &xml[open_end..close];

    let mut items = Vec::new();
    let mut cursor = 0;
    while let Some(at) = find_element(block, cursor, "<item") {
        let Some(end) = tag_end(block, at) else {
            break;
        };
        let tag = &block[at..end];
        if let Some(id) = parse_attr_str(tag, "objectid") {
            items.push((
                id.to_string(),
                parse_transform(tag)?.unwrap_or(Affine::IDENTITY),
            ));
        }
        cursor = end;
    }
    Ok(items)
}

// ---------------------------------------------------------------------------
// Byte-level XML helpers. 3MF from slicers is regular, so a full XML parser is
// not needed; these locate tags and read attributes without allocating a DOM.
// ---------------------------------------------------------------------------

/// Is a full tag `name` (including the `<`) at `at`? Guards `find` against
/// matching a longer tag: `<mesh` must not match `<meshfoo`, and `<component`
/// must not match `<components`.
fn is_tag_at(xml: &str, at: usize, name: &str) -> bool {
    if !xml[at..].starts_with(name) {
        return false;
    }
    match xml[at + name.len()..].chars().next() {
        Some(c) => c.is_ascii_whitespace() || c == '>' || c == '/',
        None => true,
    }
}

fn find_element(xml: &str, from: usize, name: &str) -> Option<usize> {
    let mut cursor = from;
    while let Some(relative) = xml[cursor..].find(name) {
        let at = cursor + relative;
        if is_tag_at(xml, at, name) {
            return Some(at);
        }
        cursor = at + name.len();
    }
    None
}

/// Index of the `>` that closes the tag starting at `at`.
fn tag_end(xml: &str, at: usize) -> Option<usize> {
    xml[at..].find('>').map(|p| at + p)
}

/// Read a quoted attribute value, matching the name at an attribute boundary so
/// `"id"` cannot match inside `objectid`.
fn parse_attr_str<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let mut search = 0;
    while let Some(relative) = tag[search..].find(name) {
        let at = search + relative;
        let boundary = at == 0 || tag.as_bytes()[at - 1].is_ascii_whitespace();
        let after = &tag[at + name.len()..];
        if boundary && after.starts_with('=') {
            let rest = &after[1..];
            let quote = rest.chars().next()?;
            let rest = &rest[1..];
            return Some(&rest[..rest.find(quote)?]);
        }
        search = at + name.len();
    }
    None
}

fn parse_attr_f32(tag: &str, name: &str) -> Option<f32> {
    parse_attr_str(tag, name)?.parse().ok()
}

fn parse_attr_u32(tag: &str, name: &str) -> Option<u32> {
    parse_attr_str(tag, name)?.parse().ok()
}

/// Parse a `transform` attribute, or `None` when the tag has none.
fn parse_transform(tag: &str) -> Result<Option<Affine>, MeshRepairError> {
    let Some(value) = parse_attr_str(tag, "transform") else {
        return Ok(None);
    };
    let mut values = [0.0f32; 12];
    let mut count = 0;
    for token in value.split_ascii_whitespace() {
        if count == values.len() {
            break;
        }
        values[count] = token.parse().map_err(|_| {
            MeshRepairError::Parse(format!("3MF: malformed transform value '{token}'"))
        })?;
        count += 1;
    }
    if count != values.len() {
        return Err(MeshRepairError::Parse(format!(
            "3MF: transform has {count} values, expected 12"
        )));
    }
    Ok(Some(Affine::from_3mf(&values)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_3mf(model_xml: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "df-3mf-test-{}-{}.3mf",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let file = File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::FileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        zip.start_file("3D/3dmodel.model", options).unwrap();
        zip.write_all(model_xml.as_bytes()).unwrap();
        zip.finish().unwrap();
        path
    }

    /// A unit triangle object instanced twice by build items with different
    /// translations must come out as two bodies, each carrying its own offset —
    /// the whole point of resolving `<build>` rather than merging every `<mesh>`.
    #[test]
    fn build_items_expand_to_transformed_bodies() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources>
    <object id="1" type="model">
      <mesh>
        <vertices>
          <vertex x="0" y="0" z="0" />
          <vertex x="1" y="0" z="0" />
          <vertex x="0" y="1" z="0" />
        </vertices>
        <triangles>
          <triangle v1="0" v2="1" v3="2" />
        </triangles>
      </mesh>
    </object>
  </resources>
  <build>
    <item objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0" />
    <item objectid="1" transform="1 0 0 0 1 0 0 0 1 10 0 0" />
  </build>
</model>"#;
        let path = write_3mf(xml);
        let bodies = load_bodies(&path).unwrap();
        let _ = std::fs::remove_file(&path);

        assert_eq!(bodies.len(), 2);
        assert_eq!(bodies[0].triangles.len(), 1);
        // The first item's vertices keep origin; the second is shifted by 10mm.
        assert_eq!(bodies[0].positions[0].x, 0.0);
        assert_eq!(bodies[1].positions[0].x, 10.0);
        assert_eq!(bodies[1].positions[2].x, 10.0);
    }

    /// A component transform composes *under* the build-item transform, and the
    /// 3MF row-vector convention (translation last) must survive the conversion.
    #[test]
    fn component_transforms_compose_with_build_items() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter">
  <resources>
    <object id="1">
      <mesh>
        <vertices>
          <vertex x="0" y="0" z="0" />
          <vertex x="1" y="0" z="0" />
          <vertex x="0" y="1" z="0" />
        </vertices>
        <triangles><triangle v1="0" v2="1" v3="2" /></triangles>
      </mesh>
    </object>
    <object id="2">
      <components>
        <component objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 5" />
      </components>
    </object>
  </resources>
  <build>
    <item objectid="2" transform="1 0 0 0 1 0 0 0 1 100 0 0" />
  </build>
</model>"#;
        let path = write_3mf(xml);
        let bodies = load_bodies(&path).unwrap();
        let _ = std::fs::remove_file(&path);

        assert_eq!(bodies.len(), 1);
        // Component lifts z by 5 inside an object the item shifts x by 100.
        let origin = bodies[0].positions[0];
        assert_eq!(origin.x, 100.0);
        assert_eq!(origin.z, 5.0);
    }

    /// `id="1"` must not be read out of `objectid="1"` — the attribute-boundary
    /// guard is what keeps `<object>` ids from picking up a reference's digits.
    #[test]
    fn object_id_is_not_read_from_objectid_attribute() {
        let tag = r#"<component objectid="7" transform="1 0 0 0 1 0 0 0 1 0 0 0" />"#;
        assert_eq!(parse_attr_str(tag, "objectid"), Some("7"));
        assert_eq!(parse_attr_str(tag, "id"), None);
    }

    #[test]
    fn missing_object_reference_is_an_error() {
        let xml = r#"<model><resources></resources>
<build><item objectid="9" /></build></model>"#;
        let path = write_3mf(xml);
        let result = load_bodies(&path);
        let _ = std::fs::remove_file(&path);
        assert!(result.is_err());
    }
}
