//! Experimental baked-support reconstruction.
//!
//! This module intentionally owns a versioned contract separate from mesh
//! repair. The first implementation provides deterministic preprocessing,
//! component provenance, and coarse axial primitive candidates for the research
//! harness. Graph construction is added incrementally as inference matures.

use std::collections::{HashMap, VecDeque};

use serde::{Deserialize, Serialize};

use crate::core::bvh::{Bvh, ClosestPointHit};
use crate::core::halfedge::Topology;
use crate::core::mesh::{Aabb, IndexedMesh, Vec3};

pub const SUPPORT_RECONSTRUCTION_SCHEMA_VERSION: u32 = 1;
pub const SUPPORT_RECONSTRUCTION_ANALYZER_VERSION: &str = "0.6.0-floor-fastpath";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct SupportReconstructionOptions {
    pub schema_version: u32,
    /// Fraction of the combined model/support bounding-box diagonal.
    pub weld_epsilon_relative: f32,
    pub plate_tolerance_mm: f32,
    pub min_component_triangles: usize,
    pub min_axial_confidence: f32,
    pub model_contact_tolerance_mm: f32,
    pub min_endpoint_confidence: f32,
    pub support_attachment_tolerance_mm: f32,
    pub min_attachment_confidence: f32,
    pub inferred_floor_tolerance_mm: f32,
}

impl Default for SupportReconstructionOptions {
    fn default() -> Self {
        Self {
            schema_version: SUPPORT_RECONSTRUCTION_SCHEMA_VERSION,
            weld_epsilon_relative: 1e-5,
            plate_tolerance_mm: 0.25,
            min_component_triangles: 8,
            min_axial_confidence: 0.55,
            model_contact_tolerance_mm: 0.75,
            min_endpoint_confidence: 0.5,
            support_attachment_tolerance_mm: 0.6,
            min_attachment_confidence: 0.55,
            inferred_floor_tolerance_mm: 0.5,
        }
    }
}

#[derive(Debug, Clone)]
pub struct SupportReconstructionRequest {
    pub model: IndexedMesh,
    pub support: IndexedMesh,
    pub plate_z_mm: f32,
    pub options: SupportReconstructionOptions,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConfidenceBreakdown {
    pub primitive_fit: f32,
    pub endpoint_classification: f32,
    pub attachment_fit: f32,
    pub topology: f32,
    pub final_confidence: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ComponentDiagnostic {
    pub id: u32,
    pub source_triangle_indices: Vec<u32>,
    pub triangle_count: usize,
    pub vertex_count: usize,
    pub bounds: Aabb,
    pub centroid: Vec3,
    pub surface_area_mm2: f32,
    pub touches_plate: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AxialCandidate {
    pub id: String,
    pub source_component_id: u32,
    pub axis: Vec3,
    pub start: Vec3,
    pub end: Vec3,
    pub shaft_start: Vec3,
    pub shaft_end: Vec3,
    pub length_mm: f32,
    pub shaft_length_mm: f32,
    pub start_transition_length_mm: f32,
    pub end_transition_length_mm: f32,
    pub start_radius_mm: f32,
    pub end_radius_mm: f32,
    pub mean_radius_mm: f32,
    pub radial_residual_mm: f32,
    pub aspect_ratio: f32,
    pub accepted: bool,
    pub confidence: ConfidenceBreakdown,
    pub rejection_codes: Vec<String>,
}

#[derive(Debug, Copy, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AxialEndpointSide {
    Start,
    End,
}

#[derive(Debug, Copy, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EndpointKind {
    Plate,
    Model,
    Support,
    Open,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EndpointCandidate {
    pub id: String,
    pub axial_candidate_id: String,
    pub source_component_id: u32,
    pub side: AxialEndpointSide,
    pub kind: EndpointKind,
    pub source_position: Vec3,
    pub resolved_position: Vec3,
    pub distance_mm: Option<f32>,
    pub surface_normal: Option<Vec3>,
    pub model_face_index: Option<u32>,
    pub confidence: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RootCandidate {
    pub id: String,
    pub axial_candidate_id: String,
    pub endpoint_id: String,
    pub source_component_id: u32,
    pub position: Vec3,
    pub diameter_mm: f32,
    pub confidence: ConfidenceBreakdown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JointCandidate {
    pub id: String,
    pub source_component_id: u32,
    pub position: Vec3,
    pub diameter_mm: f32,
    pub confidence: ConfidenceBreakdown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContactCandidate {
    pub id: String,
    pub axial_candidate_id: String,
    pub endpoint_id: String,
    pub source_component_id: u32,
    pub position: Vec3,
    pub surface_normal: Vec3,
    pub diameter_mm: f32,
    pub model_face_index: u32,
    pub distance_mm: f32,
    pub confidence: ConfidenceBreakdown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentCandidate {
    pub id: String,
    pub endpoint_id: String,
    pub guest_axial_candidate_id: String,
    pub source_component_id: u32,
    pub position: Vec3,
    pub host_axial_candidate_id: String,
    pub host_t: f32,
    pub distance_mm: f32,
    pub confidence: ConfidenceBreakdown,
}

#[derive(Debug, Copy, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SupportTopologyKind {
    Trunk,
    Branch,
    Brace,
    Unresolved,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TopologyCandidate {
    pub id: String,
    pub kind: SupportTopologyKind,
    pub axial_candidate_id: String,
    pub root_ids: Vec<String>,
    pub contact_ids: Vec<String>,
    pub attachment_ids: Vec<String>,
    pub confidence: ConfidenceBreakdown,
    pub rejection_codes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InferredGraphEdge {
    pub from: String,
    pub to: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct InferredSupportGraph {
    pub roots: Vec<RootCandidate>,
    pub axial_candidates: Vec<AxialCandidate>,
    pub endpoints: Vec<EndpointCandidate>,
    pub joints: Vec<JointCandidate>,
    pub contacts: Vec<ContactCandidate>,
    pub attachments: Vec<AttachmentCandidate>,
    pub topology_candidates: Vec<TopologyCandidate>,
    pub edges: Vec<InferredGraphEdge>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReconstructionCoverage {
    pub source_triangle_count: usize,
    pub matched_triangle_count: usize,
    pub unmatched_triangle_count: usize,
    pub surface_coverage: f32,
    pub unmatched_source_triangle_indices: Vec<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReconstructionWarning {
    pub code: String,
    pub message: String,
    pub source_component_id: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReconstructionTimings {
    pub preprocess_ms: f64,
    pub component_analysis_ms: f64,
    pub total_ms: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SupportReconstructionResult {
    pub schema_version: u32,
    pub analyzer_version: String,
    pub options: SupportReconstructionOptions,
    pub model_triangle_count: usize,
    pub support_triangle_count: usize,
    pub components: Vec<ComponentDiagnostic>,
    pub graph: InferredSupportGraph,
    pub coverage: ReconstructionCoverage,
    pub warnings: Vec<ReconstructionWarning>,
    pub timings: ReconstructionTimings,
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum SupportReconstructionError {
    #[error("unsupported support reconstruction schema version {0}")]
    UnsupportedSchema(u32),
    #[error("{mesh} mesh is empty")]
    EmptyMesh { mesh: &'static str },
    #[error("{mesh} mesh contains a non-finite vertex at index {index}")]
    NonFiniteVertex { mesh: &'static str, index: usize },
    #[error("{mesh} mesh triangle {triangle} references a missing vertex")]
    InvalidTriangleIndex { mesh: &'static str, triangle: usize },
    #[error("plate Z must be finite")]
    NonFinitePlate,
    #[error("invalid reconstruction option: {0}")]
    InvalidOption(&'static str),
}

pub fn reconstruct_supports(
    request: SupportReconstructionRequest,
) -> Result<SupportReconstructionResult, SupportReconstructionError> {
    let total_started = std::time::Instant::now();
    validate_request(&request)?;

    let preprocess_started = std::time::Instant::now();
    // Re-index from soup so the requested weld tolerance is applied uniformly
    // regardless of the source file's original indexing.
    let model = IndexedMesh::from_triangle_soup(
        &request.model.to_triangle_soup(),
        request.options.weld_epsilon_relative,
    );
    let support = IndexedMesh::from_triangle_soup(
        &request.support.to_triangle_soup(),
        request.options.weld_epsilon_relative,
    );
    let preprocess_ms = preprocess_started.elapsed().as_secs_f64() * 1000.0;

    let analysis_started = std::time::Instant::now();
    let component_faces = connected_components(&support);
    let model_bvh = Bvh::build(&model);
    let model_bounds = model.bbox();
    let inferred_floor_z = infer_support_floor_z(
        &support,
        request.plate_z_mm,
        request.options.plate_tolerance_mm,
        request.options.inferred_floor_tolerance_mm,
    );
    let mut components = Vec::with_capacity(component_faces.len());
    let mut axial_candidates = Vec::new();
    let mut endpoints = Vec::new();
    let mut roots = Vec::new();
    let mut contacts = Vec::new();
    let mut edges = Vec::new();
    let mut warnings = Vec::new();

    let mut next_axial_id = 0u32;
    for (component_index, faces) in component_faces.iter().enumerate() {
        let component_id = component_index as u32;
        let diagnostic = component_diagnostic(
            &support,
            component_id,
            faces,
            request.plate_z_mm,
            request.options.plate_tolerance_mm,
        );

        if diagnostic.triangle_count < request.options.min_component_triangles {
            warnings.push(ReconstructionWarning {
                code: "component_too_small".to_string(),
                message: format!(
                    "Component {component_id} has {} triangles; at least {} are required for axial fitting",
                    diagnostic.triangle_count, request.options.min_component_triangles
                ),
                source_component_id: Some(component_id),
            });
        } else {
            let axial_segments =
                segment_component_faces(&support, faces, request.options.min_component_triangles);
            if axial_segments.len() > 1 {
                warnings.push(ReconstructionWarning {
                    code: "component_axis_segmented".to_string(),
                    message: format!(
                        "Component {component_id} was split into {} axial face groups",
                        axial_segments.len()
                    ),
                    source_component_id: Some(component_id),
                });
            }
            for segment_faces in axial_segments {
                let axial_id = next_axial_id;
                next_axial_id += 1;
                if let Some(mut candidate) = fit_axial_candidate(
                    &support,
                    axial_id,
                    component_id,
                    &segment_faces,
                    request.options.min_axial_confidence,
                ) {
                    if candidate.accepted {
                        for side in [AxialEndpointSide::Start, AxialEndpointSide::End] {
                            let classified = classify_endpoint(
                                &candidate,
                                side,
                                &model,
                                &model_bvh,
                                model_bounds,
                                request.plate_z_mm,
                                inferred_floor_z,
                                &request.options,
                            );
                            candidate.confidence.endpoint_classification = candidate
                                .confidence
                                .endpoint_classification
                                .max(classified.endpoint.confidence);
                            if let Some(root) = classified.root {
                                edges.push(InferredGraphEdge {
                                    from: root.id.clone(),
                                    to: candidate.id.clone(),
                                    kind: "root_axis".to_string(),
                                });
                                roots.push(root);
                            }
                            if let Some(contact) = classified.contact {
                                edges.push(InferredGraphEdge {
                                    from: candidate.id.clone(),
                                    to: contact.id.clone(),
                                    kind: "axis_contact".to_string(),
                                });
                                contacts.push(contact);
                            }
                            endpoints.push(classified.endpoint);
                        }
                        candidate.confidence.final_confidence = candidate.confidence.primitive_fit
                            * 0.6
                            + candidate.confidence.endpoint_classification * 0.4;
                    } else {
                        warnings.push(ReconstructionWarning {
                            code: "low_axial_confidence".to_string(),
                            message: format!(
                                "Axial segment {axial_id} from component {component_id} produced a fit below the acceptance threshold"
                            ),
                            source_component_id: Some(component_id),
                        });
                    }
                    axial_candidates.push(candidate);
                }
            }
        }
        components.push(diagnostic);
    }

    let (attachments, attachment_edges) =
        infer_support_attachments(&mut endpoints, &axial_candidates, &request.options);
    edges.extend(attachment_edges);
    let topology_candidates =
        infer_topology_candidates(&axial_candidates, &roots, &contacts, &attachments);
    warnings.push(ReconstructionWarning {
        code: "coverage_pending".to_string(),
        message: "Native topology conversion is available for accepted simple graphs; source-surface coverage is still diagnostic-only"
            .to_string(),
        source_component_id: None,
    });

    let component_analysis_ms = analysis_started.elapsed().as_secs_f64() * 1000.0;
    let support_triangle_count = support.triangle_count();
    let unmatched_source_triangle_indices = (0..support_triangle_count as u32).collect();

    Ok(SupportReconstructionResult {
        schema_version: SUPPORT_RECONSTRUCTION_SCHEMA_VERSION,
        analyzer_version: SUPPORT_RECONSTRUCTION_ANALYZER_VERSION.to_string(),
        options: request.options,
        model_triangle_count: model.triangle_count(),
        support_triangle_count,
        components,
        graph: InferredSupportGraph {
            roots,
            axial_candidates,
            endpoints,
            contacts,
            attachments,
            topology_candidates,
            edges,
            ..InferredSupportGraph::default()
        },
        coverage: ReconstructionCoverage {
            source_triangle_count: support_triangle_count,
            matched_triangle_count: 0,
            unmatched_triangle_count: support_triangle_count,
            surface_coverage: 0.0,
            unmatched_source_triangle_indices,
        },
        warnings,
        timings: ReconstructionTimings {
            preprocess_ms,
            component_analysis_ms,
            total_ms: total_started.elapsed().as_secs_f64() * 1000.0,
        },
    })
}

fn validate_request(
    request: &SupportReconstructionRequest,
) -> Result<(), SupportReconstructionError> {
    if request.options.schema_version != SUPPORT_RECONSTRUCTION_SCHEMA_VERSION {
        return Err(SupportReconstructionError::UnsupportedSchema(
            request.options.schema_version,
        ));
    }
    if !request.plate_z_mm.is_finite() {
        return Err(SupportReconstructionError::NonFinitePlate);
    }
    if !request.options.weld_epsilon_relative.is_finite()
        || request.options.weld_epsilon_relative <= 0.0
    {
        return Err(SupportReconstructionError::InvalidOption(
            "weldEpsilonRelative must be finite and greater than zero",
        ));
    }
    if !request.options.plate_tolerance_mm.is_finite() || request.options.plate_tolerance_mm < 0.0 {
        return Err(SupportReconstructionError::InvalidOption(
            "plateToleranceMm must be finite and non-negative",
        ));
    }
    if !request.options.min_axial_confidence.is_finite()
        || !(0.0..=1.0).contains(&request.options.min_axial_confidence)
    {
        return Err(SupportReconstructionError::InvalidOption(
            "minAxialConfidence must be between zero and one",
        ));
    }
    if !request.options.model_contact_tolerance_mm.is_finite()
        || request.options.model_contact_tolerance_mm <= 0.0
    {
        return Err(SupportReconstructionError::InvalidOption(
            "modelContactToleranceMm must be finite and greater than zero",
        ));
    }
    if !request.options.min_endpoint_confidence.is_finite()
        || !(0.0..=1.0).contains(&request.options.min_endpoint_confidence)
    {
        return Err(SupportReconstructionError::InvalidOption(
            "minEndpointConfidence must be between zero and one",
        ));
    }
    if !request.options.support_attachment_tolerance_mm.is_finite()
        || request.options.support_attachment_tolerance_mm <= 0.0
    {
        return Err(SupportReconstructionError::InvalidOption(
            "supportAttachmentToleranceMm must be finite and greater than zero",
        ));
    }
    if !request.options.min_attachment_confidence.is_finite()
        || !(0.0..=1.0).contains(&request.options.min_attachment_confidence)
    {
        return Err(SupportReconstructionError::InvalidOption(
            "minAttachmentConfidence must be between zero and one",
        ));
    }
    if !request.options.inferred_floor_tolerance_mm.is_finite()
        || request.options.inferred_floor_tolerance_mm < 0.0
    {
        return Err(SupportReconstructionError::InvalidOption(
            "inferredFloorToleranceMm must be finite and non-negative",
        ));
    }

    validate_mesh("model", &request.model)?;
    validate_mesh("support", &request.support)?;
    Ok(())
}

fn validate_mesh(name: &'static str, mesh: &IndexedMesh) -> Result<(), SupportReconstructionError> {
    if mesh.positions.is_empty() || mesh.triangles.is_empty() {
        return Err(SupportReconstructionError::EmptyMesh { mesh: name });
    }
    if let Some((index, _)) = mesh
        .positions
        .iter()
        .enumerate()
        .find(|(_, position)| !position.finite())
    {
        return Err(SupportReconstructionError::NonFiniteVertex { mesh: name, index });
    }
    if let Some((triangle, _)) = mesh.triangles.iter().enumerate().find(|(_, tri)| {
        tri.iter()
            .any(|&vertex| vertex as usize >= mesh.positions.len())
    }) {
        return Err(SupportReconstructionError::InvalidTriangleIndex {
            mesh: name,
            triangle,
        });
    }
    Ok(())
}

fn connected_components(mesh: &IndexedMesh) -> Vec<Vec<u32>> {
    let topology = Topology::build(mesh);
    let mut adjacency = vec![Vec::<u32>::new(); mesh.triangle_count()];
    for edge in topology.edges.values() {
        for &left in &edge.faces {
            for &right in &edge.faces {
                if left != right {
                    adjacency[left as usize].push(right);
                }
            }
        }
    }
    for neighbours in &mut adjacency {
        neighbours.sort_unstable();
        neighbours.dedup();
    }

    let mut visited = vec![false; mesh.triangle_count()];
    let mut components = Vec::new();
    for seed in 0..mesh.triangle_count() {
        if visited[seed] {
            continue;
        }
        visited[seed] = true;
        let mut queue = VecDeque::from([seed as u32]);
        let mut faces = Vec::new();
        while let Some(face) = queue.pop_front() {
            faces.push(face);
            for &neighbour in &adjacency[face as usize] {
                if !visited[neighbour as usize] {
                    visited[neighbour as usize] = true;
                    queue.push_back(neighbour);
                }
            }
        }
        faces.sort_unstable();
        components.push(faces);
    }
    components.sort_by_key(|faces| faces[0]);
    components
}

fn face_adjacency(mesh: &IndexedMesh) -> Vec<Vec<u32>> {
    let topology = Topology::build(mesh);
    let mut adjacency = vec![Vec::<u32>::new(); mesh.triangle_count()];
    for edge in topology.edges.values() {
        for &left in &edge.faces {
            for &right in &edge.faces {
                if left != right {
                    adjacency[left as usize].push(right);
                }
            }
        }
    }
    for neighbours in &mut adjacency {
        neighbours.sort_unstable();
        neighbours.dedup();
    }
    adjacency
}

#[derive(Debug, Clone)]
struct AxisFaceGroup {
    axis: Vec3,
    faces: Vec<u32>,
}

fn segment_component_faces(
    mesh: &IndexedMesh,
    faces: &[u32],
    min_segment_triangles: usize,
) -> Vec<Vec<u32>> {
    if faces.len() < min_segment_triangles * 2 {
        return vec![faces.to_vec()];
    }

    let mut bounds = Aabb::empty();
    for &vertex in &component_vertex_indices(mesh, faces) {
        bounds.expand(mesh.positions[vertex as usize]);
    }
    let min_long_edge = bounds.diag() * 0.18;
    let mut groups: Vec<AxisFaceGroup> = Vec::new();
    const AXIS_CLUSTER_DOT: f32 = 0.85;

    for &face in faces {
        let Some(axis) = face_long_axis(mesh, face, min_long_edge) else {
            continue;
        };
        let mut matched = None;
        for (index, group) in groups.iter().enumerate() {
            if group.axis.dot(axis).abs() >= AXIS_CLUSTER_DOT {
                matched = Some(index);
                break;
            }
        }
        if let Some(index) = matched {
            let group = &mut groups[index];
            let aligned = if group.axis.dot(axis) < 0.0 {
                axis.scale(-1.0)
            } else {
                axis
            };
            let next_axis = group.axis.add(aligned);
            if next_axis.length() > 1e-6 {
                group.axis = canonical_axis(next_axis.scale(1.0 / next_axis.length()));
            }
            group.faces.push(face);
        } else {
            groups.push(AxisFaceGroup {
                axis,
                faces: vec![face],
            });
        }
    }

    let valid_axes = groups
        .iter()
        .filter(|group| group.faces.len() >= min_segment_triangles / 2)
        .map(|group| group.axis)
        .collect::<Vec<_>>();
    if valid_axes.len() < 2 {
        return vec![faces.to_vec()];
    }
    let has_distinct_axes = valid_axes.iter().enumerate().any(|(left_index, left)| {
        valid_axes
            .iter()
            .skip(left_index + 1)
            .any(|right| left.dot(*right).abs() < 0.7)
    });
    if !has_distinct_axes {
        return vec![faces.to_vec()];
    }

    let mut labels: HashMap<u32, usize> = HashMap::new();
    for &face in faces {
        if let Some(axis) = face_long_axis(mesh, face, min_long_edge) {
            let best = valid_axes
                .iter()
                .enumerate()
                .map(|(index, group_axis)| (index, group_axis.dot(axis).abs()))
                .max_by(|left, right| left.1.total_cmp(&right.1));
            if let Some((index, _score)) = best.filter(|(_, score)| *score >= AXIS_CLUSTER_DOT) {
                labels.insert(face, index);
                continue;
            }
        }
    }

    let adjacency = face_adjacency(mesh);
    let face_set: std::collections::HashSet<u32> = faces.iter().copied().collect();
    let mut changed = true;
    while changed {
        changed = false;
        for &face in faces {
            if labels.contains_key(&face) {
                continue;
            }
            let mut votes: HashMap<usize, usize> = HashMap::new();
            for &neighbour in &adjacency[face as usize] {
                if !face_set.contains(&neighbour) {
                    continue;
                }
                if let Some(&label) = labels.get(&neighbour) {
                    *votes.entry(label).or_default() += 1;
                }
            }
            if let Some((&label, _)) = votes
                .iter()
                .max_by(|left, right| left.1.cmp(right.1).then_with(|| right.0.cmp(left.0)))
            {
                labels.insert(face, label);
                changed = true;
            }
        }
    }

    let mut output = Vec::new();
    let mut visited = HashMap::<u32, bool>::new();
    for &seed in faces {
        if visited.get(&seed).copied().unwrap_or(false) {
            continue;
        }
        let Some(&label) = labels.get(&seed) else {
            continue;
        };
        visited.insert(seed, true);
        let mut queue = VecDeque::from([seed]);
        let mut segment = Vec::new();
        while let Some(face) = queue.pop_front() {
            segment.push(face);
            for &neighbour in &adjacency[face as usize] {
                if !face_set.contains(&neighbour)
                    || visited.get(&neighbour).copied().unwrap_or(false)
                    || labels.get(&neighbour).copied() != Some(label)
                {
                    continue;
                }
                visited.insert(neighbour, true);
                queue.push_back(neighbour);
            }
        }
        if segment.len() >= min_segment_triangles {
            segment.sort_unstable();
            output.push(segment);
        }
    }

    output.sort_by_key(|segment| segment[0]);
    if output.len() < 2 {
        vec![faces.to_vec()]
    } else {
        output
    }
}

fn face_long_axis(mesh: &IndexedMesh, face: u32, min_length: f32) -> Option<Vec3> {
    let [a, b, c] = mesh.tri_positions(face);
    let edges = [b.sub(a), c.sub(b), a.sub(c)];
    let longest = edges
        .into_iter()
        .max_by(|left, right| left.length().total_cmp(&right.length()))?;
    let length = longest.length();
    if length < min_length.max(1e-6) {
        return None;
    }
    Some(canonical_axis(longest.scale(1.0 / length)))
}

fn canonical_axis(axis: Vec3) -> Vec3 {
    if axis.z < -1e-6
        || (axis.z.abs() <= 1e-6 && axis.y < -1e-6)
        || (axis.z.abs() <= 1e-6 && axis.y.abs() <= 1e-6 && axis.x < 0.0)
    {
        axis.scale(-1.0)
    } else {
        axis
    }
}

fn component_vertex_indices(mesh: &IndexedMesh, faces: &[u32]) -> Vec<u32> {
    let mut vertices = Vec::with_capacity(faces.len() * 2);
    for &face in faces {
        vertices.extend_from_slice(&mesh.triangles[face as usize]);
    }
    vertices.sort_unstable();
    vertices.dedup();
    vertices
}

fn component_diagnostic(
    mesh: &IndexedMesh,
    id: u32,
    faces: &[u32],
    plate_z_mm: f32,
    plate_tolerance_mm: f32,
) -> ComponentDiagnostic {
    let vertices = component_vertex_indices(mesh, faces);
    let mut bounds = Aabb::empty();
    let mut centroid = Vec3::ZERO;
    for &vertex in &vertices {
        let position = mesh.positions[vertex as usize];
        bounds.expand(position);
        centroid = centroid.add(position);
    }
    centroid = centroid.scale(1.0 / vertices.len().max(1) as f32);
    let surface_area_mm2 = faces.iter().map(|&face| mesh.tri_area(face)).sum();

    ComponentDiagnostic {
        id,
        source_triangle_indices: faces.to_vec(),
        triangle_count: faces.len(),
        vertex_count: vertices.len(),
        bounds,
        centroid,
        surface_area_mm2,
        touches_plate: bounds.min.z <= plate_z_mm + plate_tolerance_mm
            && bounds.max.z >= plate_z_mm - plate_tolerance_mm,
    }
}

fn infer_support_floor_z(
    support: &IndexedMesh,
    plate_z_mm: f32,
    plate_tolerance_mm: f32,
    inferred_floor_tolerance_mm: f32,
) -> Option<f32> {
    if inferred_floor_tolerance_mm <= 0.0 {
        return None;
    }
    let bounds = support.bbox();
    if bounds.min.z <= plate_z_mm + plate_tolerance_mm {
        None
    } else if bounds.min.z.is_finite() {
        Some(bounds.min.z)
    } else {
        None
    }
}

fn point_aabb_distance(point: Vec3, bounds: &Aabb) -> f32 {
    let dx = if point.x < bounds.min.x {
        bounds.min.x - point.x
    } else if point.x > bounds.max.x {
        point.x - bounds.max.x
    } else {
        0.0
    };
    let dy = if point.y < bounds.min.y {
        bounds.min.y - point.y
    } else if point.y > bounds.max.y {
        point.y - bounds.max.y
    } else {
        0.0
    };
    let dz = if point.z < bounds.min.z {
        bounds.min.z - point.z
    } else if point.z > bounds.max.z {
        point.z - bounds.max.z
    } else {
        0.0
    };
    (dx * dx + dy * dy + dz * dz).sqrt()
}

struct ClassifiedEndpoint {
    endpoint: EndpointCandidate,
    root: Option<RootCandidate>,
    contact: Option<ContactCandidate>,
}

fn classify_endpoint(
    candidate: &AxialCandidate,
    side: AxialEndpointSide,
    model: &IndexedMesh,
    model_bvh: &Bvh,
    model_bounds: Aabb,
    plate_z_mm: f32,
    inferred_floor_z: Option<f32>,
    options: &SupportReconstructionOptions,
) -> ClassifiedEndpoint {
    let source_position = match side {
        AxialEndpointSide::Start => candidate.start,
        AxialEndpointSide::End => candidate.end,
    };
    let outward_axis = match side {
        AxialEndpointSide::Start => candidate.axis.scale(-1.0),
        AxialEndpointSide::End => candidate.axis,
    };
    let side_name = match side {
        AxialEndpointSide::Start => "start",
        AxialEndpointSide::End => "end",
    };
    let endpoint_id = format!("endpoint-{}-{side_name}", candidate.id);

    let floor_z = inferred_floor_z.unwrap_or(plate_z_mm);
    let floor_distance = (source_position.z - floor_z).abs();
    let floor_tolerance = if inferred_floor_z.is_some() {
        options
            .inferred_floor_tolerance_mm
            .max(options.plate_tolerance_mm)
    } else {
        options.plate_tolerance_mm
    };
    let plate_score = if floor_tolerance <= f32::EPSILON {
        if floor_distance <= f32::EPSILON {
            1.0
        } else {
            0.0
        }
    } else {
        (1.0 - floor_distance / floor_tolerance).clamp(0.0, 1.0)
    };

    if plate_score >= options.min_endpoint_confidence {
        let resolved_position = Vec3::new(source_position.x, source_position.y, floor_z);
        let confidence = endpoint_confidence(candidate.confidence.primitive_fit, plate_score);
        let root_id = format!("root-{}-{side_name}", candidate.id);
        return ClassifiedEndpoint {
            endpoint: EndpointCandidate {
                id: endpoint_id.clone(),
                axial_candidate_id: candidate.id.clone(),
                source_component_id: candidate.source_component_id,
                side,
                kind: EndpointKind::Plate,
                source_position,
                resolved_position,
                distance_mm: Some(floor_distance),
                surface_normal: Some(Vec3::new(0.0, 0.0, 1.0)),
                model_face_index: None,
                confidence: plate_score,
            },
            root: Some(RootCandidate {
                id: root_id,
                axial_candidate_id: candidate.id.clone(),
                endpoint_id,
                source_component_id: candidate.source_component_id,
                position: resolved_position,
                diameter_mm: axial_endpoint_radius(candidate, side) * 2.0,
                confidence,
            }),
            contact: None,
        };
    }

    let model_hit = if point_aabb_distance(source_position, &model_bounds)
        <= options.model_contact_tolerance_mm
    {
        model_bvh.closest_point(model, source_position, options.model_contact_tolerance_mm)
    } else {
        None
    };
    let model_score = model_hit
        .as_ref()
        .map(|hit| model_endpoint_confidence(source_position, outward_axis, hit, options))
        .unwrap_or(0.0);

    if let Some(hit) = model_hit.filter(|_| model_score >= options.min_endpoint_confidence) {
        let confidence = endpoint_confidence(candidate.confidence.primitive_fit, model_score);
        let contact_id = format!("contact-{}-{side_name}", candidate.id);
        return ClassifiedEndpoint {
            endpoint: EndpointCandidate {
                id: endpoint_id.clone(),
                axial_candidate_id: candidate.id.clone(),
                source_component_id: candidate.source_component_id,
                side,
                kind: EndpointKind::Model,
                source_position,
                resolved_position: hit.point,
                distance_mm: Some(hit.distance),
                surface_normal: Some(hit.normal),
                model_face_index: Some(hit.face),
                confidence: model_score,
            },
            root: None,
            contact: Some(ContactCandidate {
                id: contact_id,
                axial_candidate_id: candidate.id.clone(),
                endpoint_id,
                source_component_id: candidate.source_component_id,
                position: hit.point,
                surface_normal: hit.normal,
                diameter_mm: axial_endpoint_radius(candidate, side) * 2.0,
                model_face_index: hit.face,
                distance_mm: hit.distance,
                confidence,
            }),
        };
    }

    ClassifiedEndpoint {
        endpoint: EndpointCandidate {
            id: endpoint_id,
            axial_candidate_id: candidate.id.clone(),
            source_component_id: candidate.source_component_id,
            side,
            kind: EndpointKind::Open,
            source_position,
            resolved_position: source_position,
            distance_mm: model_hit.map(|hit| hit.distance),
            surface_normal: model_hit.map(|hit| hit.normal),
            model_face_index: model_hit.map(|hit| hit.face),
            confidence: plate_score.max(model_score),
        },
        root: None,
        contact: None,
    }
}

fn axial_endpoint_radius(candidate: &AxialCandidate, side: AxialEndpointSide) -> f32 {
    match side {
        AxialEndpointSide::Start => candidate.start_radius_mm,
        AxialEndpointSide::End => candidate.end_radius_mm,
    }
}

fn model_endpoint_confidence(
    source_position: Vec3,
    outward_axis: Vec3,
    hit: &ClosestPointHit,
    options: &SupportReconstructionOptions,
) -> f32 {
    let distance_score = (1.0 - hit.distance / options.model_contact_tolerance_mm).clamp(0.0, 1.0);
    let normal_alignment = outward_axis.dot(hit.normal.scale(-1.0)).clamp(0.0, 1.0);
    let toward_model = hit.point.sub(source_position);
    let approach_alignment = if toward_model.length() > 1e-6 {
        outward_axis
            .dot(toward_model.scale(1.0 / toward_model.length()))
            .clamp(0.0, 1.0)
    } else {
        normal_alignment
    };
    let direction_score = (normal_alignment + approach_alignment) * 0.5;
    distance_score * (0.5 + direction_score * 0.5)
}

fn endpoint_confidence(primitive_fit: f32, endpoint_score: f32) -> ConfidenceBreakdown {
    ConfidenceBreakdown {
        primitive_fit,
        endpoint_classification: endpoint_score,
        attachment_fit: 0.0,
        topology: 0.0,
        final_confidence: primitive_fit * 0.6 + endpoint_score * 0.4,
    }
}

fn infer_support_attachments(
    endpoints: &mut [EndpointCandidate],
    axial_candidates: &[AxialCandidate],
    options: &SupportReconstructionOptions,
) -> (Vec<AttachmentCandidate>, Vec<InferredGraphEdge>) {
    let mut attachments = Vec::new();
    let mut edges = Vec::new();

    for endpoint in endpoints.iter_mut() {
        if endpoint.kind != EndpointKind::Open {
            continue;
        }
        let Some(guest) = axial_candidates
            .iter()
            .find(|candidate| candidate.id == endpoint.axial_candidate_id && candidate.accepted)
        else {
            continue;
        };

        let mut best: Option<(&AxialCandidate, Vec3, f32, f32, f32)> = None;
        for host in axial_candidates
            .iter()
            .filter(|candidate| candidate.accepted && candidate.id != guest.id)
        {
            let (projected, host_t) = closest_point_on_segment(
                endpoint.source_position,
                host.shaft_start,
                host.shaft_end,
            );
            let distance = projected.sub(endpoint.source_position).length();
            if distance > options.support_attachment_tolerance_mm {
                continue;
            }
            let distance_score =
                (1.0 - distance / options.support_attachment_tolerance_mm).clamp(0.0, 1.0);
            let axis_separation = 1.0 - guest.axis.dot(host.axis).abs().clamp(0.0, 1.0);
            let score = distance_score * (0.5 + axis_separation * 0.5);
            if score < options.min_attachment_confidence {
                continue;
            }
            let replace = best
                .as_ref()
                .map(|(current_host, _, _, _, current_score)| {
                    score > *current_score || (score == *current_score && host.id < current_host.id)
                })
                .unwrap_or(true);
            if replace {
                best = Some((host, projected, host_t, distance, score));
            }
        }

        let Some((host, projected, host_t, distance, score)) = best else {
            continue;
        };
        endpoint.kind = EndpointKind::Support;
        endpoint.resolved_position = projected;
        endpoint.distance_mm = Some(distance);
        endpoint.surface_normal = None;
        endpoint.model_face_index = None;
        endpoint.confidence = score;

        let attachment_id = format!("attachment-{}", endpoint.id);
        attachments.push(AttachmentCandidate {
            id: attachment_id.clone(),
            endpoint_id: endpoint.id.clone(),
            guest_axial_candidate_id: guest.id.clone(),
            source_component_id: guest.source_component_id,
            position: projected,
            host_axial_candidate_id: host.id.clone(),
            host_t,
            distance_mm: distance,
            confidence: ConfidenceBreakdown {
                primitive_fit: guest.confidence.primitive_fit,
                endpoint_classification: 0.0,
                attachment_fit: score,
                topology: 0.0,
                final_confidence: guest.confidence.primitive_fit * 0.6 + score * 0.4,
            },
        });
        edges.push(InferredGraphEdge {
            from: host.id.clone(),
            to: attachment_id.clone(),
            kind: "host_attachment".to_string(),
        });
        edges.push(InferredGraphEdge {
            from: attachment_id,
            to: guest.id.clone(),
            kind: "attachment_axis".to_string(),
        });
    }

    (attachments, edges)
}

fn closest_point_on_segment(point: Vec3, start: Vec3, end: Vec3) -> (Vec3, f32) {
    let segment = end.sub(start);
    let length_sq = segment.dot(segment);
    if length_sq <= 1e-12 {
        return (start, 0.0);
    }
    let t = point.sub(start).dot(segment) / length_sq;
    let clamped_t = t.clamp(0.0, 1.0);
    (start.add(segment.scale(clamped_t)), clamped_t)
}

fn infer_topology_candidates(
    axial_candidates: &[AxialCandidate],
    roots: &[RootCandidate],
    contacts: &[ContactCandidate],
    attachments: &[AttachmentCandidate],
) -> Vec<TopologyCandidate> {
    axial_candidates
        .iter()
        .filter(|candidate| candidate.accepted)
        .map(|candidate| {
            let matching_roots: Vec<&RootCandidate> = roots
                .iter()
                .filter(|root| root.axial_candidate_id == candidate.id)
                .collect();
            let matching_contacts: Vec<&ContactCandidate> = contacts
                .iter()
                .filter(|contact| contact.axial_candidate_id == candidate.id)
                .collect();
            let matching_attachments: Vec<&AttachmentCandidate> = attachments
                .iter()
                .filter(|attachment| attachment.guest_axial_candidate_id == candidate.id)
                .collect();

            let kind = match (
                matching_roots.len(),
                matching_contacts.len(),
                matching_attachments.len(),
            ) {
                (1, 1, 0) => SupportTopologyKind::Trunk,
                (1, 0, 0) => SupportTopologyKind::Trunk,
                (0, 1, 1) => SupportTopologyKind::Branch,
                (0, 0, 2) => SupportTopologyKind::Brace,
                _ => SupportTopologyKind::Unresolved,
            };
            let topology_score = if kind == SupportTopologyKind::Unresolved {
                0.0
            } else {
                1.0
            };
            let evidence_scores = matching_roots
                .iter()
                .map(|root| root.confidence.final_confidence)
                .chain(
                    matching_contacts
                        .iter()
                        .map(|contact| contact.confidence.final_confidence),
                )
                .chain(
                    matching_attachments
                        .iter()
                        .map(|attachment| attachment.confidence.final_confidence),
                )
                .collect::<Vec<_>>();
            let evidence_score = if evidence_scores.is_empty() {
                0.0
            } else {
                evidence_scores.iter().sum::<f32>() / evidence_scores.len() as f32
            };
            let final_confidence = candidate.confidence.primitive_fit * 0.4
                + evidence_score * 0.4
                + topology_score * 0.2;

            TopologyCandidate {
                id: format!("topology-{}", candidate.id),
                kind,
                axial_candidate_id: candidate.id.clone(),
                root_ids: matching_roots.iter().map(|root| root.id.clone()).collect(),
                contact_ids: matching_contacts
                    .iter()
                    .map(|contact| contact.id.clone())
                    .collect(),
                attachment_ids: matching_attachments
                    .iter()
                    .map(|attachment| attachment.id.clone())
                    .collect(),
                confidence: ConfidenceBreakdown {
                    primitive_fit: candidate.confidence.primitive_fit,
                    endpoint_classification: candidate.confidence.endpoint_classification,
                    attachment_fit: matching_attachments
                        .iter()
                        .map(|attachment| attachment.confidence.attachment_fit)
                        .fold(0.0, f32::max),
                    topology: topology_score,
                    final_confidence,
                },
                rejection_codes: if kind == SupportTopologyKind::Unresolved {
                    vec!["unsupported_endpoint_pattern".to_string()]
                } else {
                    Vec::new()
                },
            }
        })
        .collect()
}

fn fit_axial_candidate(
    mesh: &IndexedMesh,
    axial_id: u32,
    source_component_id: u32,
    faces: &[u32],
    min_confidence: f32,
) -> Option<AxialCandidate> {
    let vertices = component_vertex_indices(mesh, faces);
    if vertices.len() < 4 {
        return None;
    }

    let mut centroid = Vec3::ZERO;
    for &vertex in &vertices {
        centroid = centroid.add(mesh.positions[vertex as usize]);
    }
    centroid = centroid.scale(1.0 / vertices.len() as f32);

    let mut covariance = [[0.0f32; 3]; 3];
    for &vertex in &vertices {
        let p = mesh.positions[vertex as usize].sub(centroid);
        let values = [p.x, p.y, p.z];
        for row in 0..3 {
            for col in row..3 {
                covariance[row][col] += values[row] * values[col];
                covariance[col][row] = covariance[row][col];
            }
        }
    }

    let diagonal = [covariance[0][0], covariance[1][1], covariance[2][2]];
    let seed_axis = diagonal
        .iter()
        .enumerate()
        .max_by(|left, right| left.1.total_cmp(right.1))
        .map(|(index, _)| index)
        .unwrap_or(2);
    let mut axis = match seed_axis {
        0 => Vec3::new(1.0, 0.0, 0.0),
        1 => Vec3::new(0.0, 1.0, 0.0),
        _ => Vec3::new(0.0, 0.0, 1.0),
    };
    for _ in 0..24 {
        let next = Vec3::new(
            covariance[0][0] * axis.x + covariance[0][1] * axis.y + covariance[0][2] * axis.z,
            covariance[1][0] * axis.x + covariance[1][1] * axis.y + covariance[1][2] * axis.z,
            covariance[2][0] * axis.x + covariance[2][1] * axis.y + covariance[2][2] * axis.z,
        );
        let length = next.length();
        if length <= 1e-8 {
            return None;
        }
        axis = next.scale(1.0 / length);
    }
    // Fix eigenvector sign so serialized output is deterministic.
    if axis.z < -1e-6
        || (axis.z.abs() <= 1e-6 && axis.y < -1e-6)
        || (axis.z.abs() <= 1e-6 && axis.y.abs() <= 1e-6 && axis.x < 0.0)
    {
        axis = axis.scale(-1.0);
    }

    let mut min_t = f32::INFINITY;
    let mut max_t = f32::NEG_INFINITY;
    let mut radii = Vec::with_capacity(vertices.len());
    let mut projected_radii = Vec::with_capacity(vertices.len());
    for &vertex in &vertices {
        let offset = mesh.positions[vertex as usize].sub(centroid);
        let t = offset.dot(axis);
        min_t = min_t.min(t);
        max_t = max_t.max(t);
        let radius = offset.sub(axis.scale(t)).length();
        radii.push(radius);
        projected_radii.push((t, radius));
    }
    let length_mm = max_t - min_t;
    // Cap-center vertices are common in exported cylinders and sit on the
    // candidate axis. Use robust medians so those expected outliers do not
    // collapse the radius estimate or inflate the fit residual.
    radii.sort_by(f32::total_cmp);
    let mean_radius_mm = median(&radii);
    if length_mm <= 1e-6 || mean_radius_mm <= 1e-6 {
        return None;
    }
    let (shaft_min_t, shaft_max_t, start_radius_mm, end_radius_mm) =
        infer_shaft_span(&mut projected_radii, min_t, max_t, mean_radius_mm);
    let shaft_length_mm = shaft_max_t - shaft_min_t;
    let mut shaft_radial_deviations: Vec<f32> = projected_radii
        .iter()
        .filter(|(t, _)| *t >= shaft_min_t - 1e-4 && *t <= shaft_max_t + 1e-4)
        .map(|(_, radius)| (radius - mean_radius_mm).abs())
        .collect();
    shaft_radial_deviations.sort_by(f32::total_cmp);
    let radial_residual_mm = if shaft_radial_deviations.is_empty() {
        0.0
    } else {
        median(&shaft_radial_deviations)
    };
    let aspect_ratio = shaft_length_mm / (mean_radius_mm * 2.0);
    let aspect_score = ((aspect_ratio - 1.0) / 4.0).clamp(0.0, 1.0);
    let residual_ratio = radial_residual_mm / mean_radius_mm;
    let residual_score = (1.0 - residual_ratio / 0.5).clamp(0.0, 1.0);
    let primitive_fit = aspect_score * residual_score;
    let confidence = ConfidenceBreakdown {
        primitive_fit,
        endpoint_classification: 0.0,
        attachment_fit: 0.0,
        topology: 0.0,
        final_confidence: primitive_fit,
    };
    let accepted = primitive_fit >= min_confidence;

    Some(AxialCandidate {
        id: format!("axial-{axial_id:06}"),
        source_component_id,
        axis,
        start: centroid.add(axis.scale(min_t)),
        end: centroid.add(axis.scale(max_t)),
        shaft_start: centroid.add(axis.scale(shaft_min_t)),
        shaft_end: centroid.add(axis.scale(shaft_max_t)),
        length_mm,
        shaft_length_mm,
        start_transition_length_mm: shaft_min_t - min_t,
        end_transition_length_mm: max_t - shaft_max_t,
        start_radius_mm,
        end_radius_mm,
        mean_radius_mm,
        radial_residual_mm,
        aspect_ratio,
        accepted,
        confidence,
        rejection_codes: if accepted {
            Vec::new()
        } else {
            vec!["low_primitive_fit".to_string()]
        },
    })
}

fn infer_shaft_span(
    projected_radii: &mut [(f32, f32)],
    min_t: f32,
    max_t: f32,
    shaft_radius: f32,
) -> (f32, f32, f32, f32) {
    projected_radii.sort_by(|left, right| left.0.total_cmp(&right.0));
    let grouping_epsilon = ((max_t - min_t) * 1e-4).max(1e-4);
    let mut sections: Vec<(f32, f32)> = Vec::new();
    let mut cursor = 0;
    while cursor < projected_radii.len() {
        let start = cursor;
        let section_t = projected_radii[cursor].0;
        cursor += 1;
        while cursor < projected_radii.len()
            && (projected_radii[cursor].0 - section_t).abs() <= grouping_epsilon
        {
            cursor += 1;
        }
        let mut section_radii: Vec<f32> = projected_radii[start..cursor]
            .iter()
            .map(|(_, radius)| *radius)
            .collect();
        section_radii.sort_by(f32::total_cmp);
        sections.push((section_t, median(&section_radii)));
    }

    let radius_tolerance = (shaft_radius * 0.25).max(0.05);
    let mut best: Option<(usize, usize, f32)> = None;
    let mut run_start: Option<usize> = None;
    for index in 0..=sections.len() {
        let matches =
            index < sections.len() && (sections[index].1 - shaft_radius).abs() <= radius_tolerance;
        if matches {
            run_start.get_or_insert(index);
            continue;
        }
        if let Some(start) = run_start.take() {
            let end = index - 1;
            if end > start {
                let span = sections[end].0 - sections[start].0;
                if best
                    .map(|(_, _, best_span)| span > best_span)
                    .unwrap_or(true)
                {
                    best = Some((start, end, span));
                }
            }
        }
    }

    let start_radius = sections
        .first()
        .map(|section| section.1)
        .unwrap_or(shaft_radius);
    let end_radius = sections
        .last()
        .map(|section| section.1)
        .unwrap_or(shaft_radius);
    best.map(|(start, end, _)| (sections[start].0, sections[end].0, start_radius, end_radius))
        .unwrap_or((min_t, max_t, start_radius, end_radius))
}

fn median(sorted_values: &[f32]) -> f32 {
    let middle = sorted_values.len() / 2;
    if sorted_values.len() % 2 == 0 {
        (sorted_values[middle - 1] + sorted_values[middle]) * 0.5
    } else {
        sorted_values[middle]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn box_mesh(min: Vec3, max: Vec3) -> IndexedMesh {
        let positions = vec![
            Vec3::new(min.x, min.y, min.z),
            Vec3::new(max.x, min.y, min.z),
            Vec3::new(max.x, max.y, min.z),
            Vec3::new(min.x, max.y, min.z),
            Vec3::new(min.x, min.y, max.z),
            Vec3::new(max.x, min.y, max.z),
            Vec3::new(max.x, max.y, max.z),
            Vec3::new(min.x, max.y, max.z),
        ];
        let triangles = vec![
            [0, 2, 1],
            [0, 3, 2],
            [4, 5, 6],
            [4, 6, 7],
            [0, 1, 5],
            [0, 5, 4],
            [3, 7, 6],
            [3, 6, 2],
            [0, 4, 7],
            [0, 7, 3],
            [1, 2, 6],
            [1, 6, 5],
        ];
        IndexedMesh {
            positions,
            triangles,
        }
    }

    fn merge_meshes(meshes: &[IndexedMesh]) -> IndexedMesh {
        let mut output = IndexedMesh::default();
        for mesh in meshes {
            let offset = output.positions.len() as u32;
            output.positions.extend_from_slice(&mesh.positions);
            output.triangles.extend(
                mesh.triangles
                    .iter()
                    .map(|tri| [tri[0] + offset, tri[1] + offset, tri[2] + offset]),
            );
        }
        output
    }

    fn cylinder_mesh(radius: f32, min_z: f32, max_z: f32, sides: usize) -> IndexedMesh {
        let mut positions = Vec::with_capacity(sides * 2 + 2);
        for z in [min_z, max_z] {
            for side in 0..sides {
                let angle = std::f32::consts::TAU * side as f32 / sides as f32;
                positions.push(Vec3::new(radius * angle.cos(), radius * angle.sin(), z));
            }
        }
        let bottom_center = positions.len() as u32;
        positions.push(Vec3::new(0.0, 0.0, min_z));
        let top_center = positions.len() as u32;
        positions.push(Vec3::new(0.0, 0.0, max_z));

        let mut triangles = Vec::with_capacity(sides * 4);
        for side in 0..sides {
            let next = (side + 1) % sides;
            let bottom = side as u32;
            let bottom_next = next as u32;
            let top = (side + sides) as u32;
            let top_next = (next + sides) as u32;
            triangles.push([bottom, bottom_next, top_next]);
            triangles.push([bottom, top_next, top]);
            triangles.push([bottom_center, bottom_next, bottom]);
            triangles.push([top_center, top, top_next]);
        }
        IndexedMesh {
            positions,
            triangles,
        }
    }

    fn translated(mut mesh: IndexedMesh, offset: Vec3) -> IndexedMesh {
        for position in &mut mesh.positions {
            *position = position.add(offset);
        }
        mesh
    }

    fn horizontal_cylinder(
        radius: f32,
        min_x: f32,
        max_x: f32,
        center_z: f32,
        sides: usize,
    ) -> IndexedMesh {
        let mut mesh = cylinder_mesh(radius, min_x, max_x, sides);
        for position in &mut mesh.positions {
            *position = Vec3::new(position.z, position.x, position.y + center_z);
        }
        mesh
    }

    fn profiled_axial_mesh(sections: &[(f32, f32)], sides: usize) -> IndexedMesh {
        let mut positions = Vec::with_capacity(sections.len() * sides + 2);
        for &(z, radius) in sections {
            for side in 0..sides {
                let angle = std::f32::consts::TAU * side as f32 / sides as f32;
                positions.push(Vec3::new(radius * angle.cos(), radius * angle.sin(), z));
            }
        }
        let bottom_center = positions.len() as u32;
        positions.push(Vec3::new(0.0, 0.0, sections[0].0));
        let top_center = positions.len() as u32;
        positions.push(Vec3::new(0.0, 0.0, sections[sections.len() - 1].0));

        let mut triangles = Vec::new();
        for section in 0..sections.len() - 1 {
            for side in 0..sides {
                let next = (side + 1) % sides;
                let lower = (section * sides + side) as u32;
                let lower_next = (section * sides + next) as u32;
                let upper = ((section + 1) * sides + side) as u32;
                let upper_next = ((section + 1) * sides + next) as u32;
                triangles.push([lower, lower_next, upper_next]);
                triangles.push([lower, upper_next, upper]);
            }
        }
        let top_offset = (sections.len() - 1) * sides;
        for side in 0..sides {
            let next = (side + 1) % sides;
            triangles.push([bottom_center, next as u32, side as u32]);
            triangles.push([
                top_center,
                (top_offset + side) as u32,
                (top_offset + next) as u32,
            ]);
        }
        IndexedMesh {
            positions,
            triangles,
        }
    }

    #[test]
    fn reports_deterministic_components_with_source_provenance() {
        let model = box_mesh(Vec3::new(-2.0, -2.0, 10.0), Vec3::new(2.0, 2.0, 14.0));
        let support = merge_meshes(&[
            box_mesh(Vec3::new(-1.0, -1.0, 0.0), Vec3::new(1.0, 1.0, 8.0)),
            box_mesh(Vec3::new(4.0, -0.5, 2.0), Vec3::new(5.0, 0.5, 7.0)),
        ]);
        let result = reconstruct_supports(SupportReconstructionRequest {
            model,
            support,
            plate_z_mm: 0.0,
            options: SupportReconstructionOptions::default(),
        })
        .unwrap();

        assert_eq!(result.components.len(), 2);
        assert_eq!(
            result.components[0].source_triangle_indices,
            (0..12).collect::<Vec<_>>()
        );
        assert_eq!(
            result.components[1].source_triangle_indices,
            (12..24).collect::<Vec<_>>()
        );
        assert!(result.components[0].touches_plate);
        assert!(!result.components[1].touches_plate);
        assert_eq!(result.graph.axial_candidates.len(), 2);
        assert_eq!(result.graph.axial_candidates[0].id, "axial-000000");
        assert_eq!(result.coverage.unmatched_triangle_count, 24);
    }

    #[test]
    fn rejects_non_finite_input_before_analysis() {
        let model = box_mesh(Vec3::ZERO, Vec3::new(1.0, 1.0, 1.0));
        let mut support = model.clone();
        support.positions[0].x = f32::NAN;
        let error = reconstruct_supports(SupportReconstructionRequest {
            model,
            support,
            plate_z_mm: 0.0,
            options: SupportReconstructionOptions::default(),
        })
        .unwrap_err();
        assert_eq!(
            error,
            SupportReconstructionError::NonFiniteVertex {
                mesh: "support",
                index: 0,
            }
        );
    }

    #[test]
    fn rejects_unknown_schema_versions() {
        let mesh = box_mesh(Vec3::ZERO, Vec3::new(1.0, 1.0, 1.0));
        let error = reconstruct_supports(SupportReconstructionRequest {
            model: mesh.clone(),
            support: mesh,
            plate_z_mm: 0.0,
            options: SupportReconstructionOptions {
                schema_version: 99,
                ..SupportReconstructionOptions::default()
            },
        })
        .unwrap_err();
        assert_eq!(error, SupportReconstructionError::UnsupportedSchema(99));
    }

    #[test]
    fn clean_cylinder_meets_initial_axis_and_diameter_targets() {
        let model = box_mesh(Vec3::new(-2.0, -2.0, 11.0), Vec3::new(2.0, 2.0, 15.0));
        let support = cylinder_mesh(1.0, 0.0, 10.0, 24);
        let result = reconstruct_supports(SupportReconstructionRequest {
            model,
            support,
            plate_z_mm: 0.0,
            options: SupportReconstructionOptions::default(),
        })
        .unwrap();

        let candidate = &result.graph.axial_candidates[0];
        let z_alignment = candidate.axis.dot(Vec3::new(0.0, 0.0, 1.0));
        let angular_error_degrees = z_alignment.clamp(-1.0, 1.0).acos().to_degrees();
        assert!(candidate.accepted);
        assert!(
            angular_error_degrees < 2.0,
            "axis error was {angular_error_degrees} degrees"
        );
        assert!((candidate.mean_radius_mm - 1.0).abs() < 0.1);
        assert!((candidate.length_mm - 10.0).abs() < 0.01);
    }

    #[test]
    fn plate_to_model_cylinder_emits_root_contact_and_edges() {
        let model = box_mesh(Vec3::new(-2.0, -2.0, 10.0), Vec3::new(2.0, 2.0, 14.0));
        let support = cylinder_mesh(0.8, 0.0, 10.0, 24);
        let result = reconstruct_supports(SupportReconstructionRequest {
            model,
            support,
            plate_z_mm: 0.0,
            options: SupportReconstructionOptions::default(),
        })
        .unwrap();

        assert_eq!(result.graph.endpoints.len(), 2);
        assert_eq!(result.graph.endpoints[0].kind, EndpointKind::Plate);
        assert_eq!(result.graph.endpoints[1].kind, EndpointKind::Model);
        assert_eq!(result.graph.roots.len(), 1);
        assert_eq!(result.graph.contacts.len(), 1);
        assert_eq!(result.graph.edges.len(), 2);
        assert_eq!(result.graph.edges[0].kind, "root_axis");
        assert_eq!(result.graph.edges[1].kind, "axis_contact");
        let contact = &result.graph.contacts[0];
        assert!(contact.distance_mm < 1e-5);
        assert!((contact.position.z - 10.0).abs() < 1e-5);
        assert!(contact.surface_normal.z < -0.99);
        assert!(contact.confidence.endpoint_classification > 0.99);
        assert_eq!(result.graph.topology_candidates.len(), 1);
        assert_eq!(
            result.graph.topology_candidates[0].kind,
            SupportTopologyKind::Trunk
        );
    }

    #[test]
    fn support_floor_above_plate_can_seed_roots() {
        let model = box_mesh(Vec3::new(-2.0, -2.0, 12.0), Vec3::new(2.0, 2.0, 16.0));
        let support = cylinder_mesh(0.8, 2.0, 12.0, 24);
        let result = reconstruct_supports(SupportReconstructionRequest {
            model,
            support,
            plate_z_mm: 0.0,
            options: SupportReconstructionOptions::default(),
        })
        .unwrap();

        assert_eq!(result.graph.roots.len(), 1);
        assert!((result.graph.roots[0].position.z - 2.0).abs() < 1e-5);
        assert_eq!(
            result.graph.topology_candidates[0].kind,
            SupportTopologyKind::Trunk
        );
    }

    #[test]
    fn floating_cylinder_keeps_unresolved_endpoints_open() {
        let model = box_mesh(Vec3::new(-2.0, -2.0, 10.0), Vec3::new(2.0, 2.0, 14.0));
        let support = cylinder_mesh(0.8, 2.0, 8.0, 24);
        let result = reconstruct_supports(SupportReconstructionRequest {
            model,
            support,
            plate_z_mm: 0.0,
            options: SupportReconstructionOptions {
                inferred_floor_tolerance_mm: 0.0,
                ..SupportReconstructionOptions::default()
            },
        })
        .unwrap();

        assert_eq!(result.graph.endpoints.len(), 2);
        assert!(result
            .graph
            .endpoints
            .iter()
            .all(|endpoint| endpoint.kind == EndpointKind::Open));
        assert!(result.graph.roots.is_empty());
        assert!(result.graph.contacts.is_empty());
        assert!(result.graph.edges.is_empty());
    }

    #[test]
    fn mixed_axis_component_faces_split_into_axial_segments() {
        let support = merge_meshes(&[
            cylinder_mesh(0.8, 0.0, 10.0, 24),
            horizontal_cylinder(0.5, 0.0, 5.0, 5.0, 24),
        ]);
        let faces = (0..support.triangle_count() as u32).collect::<Vec<_>>();
        let segments = segment_component_faces(&support, &faces, 8);

        assert_eq!(segments.len(), 2);
        assert!(segments.iter().all(|segment| segment.len() >= 8));
        assert_eq!(
            segments.iter().map(|segment| segment.len()).sum::<usize>(),
            faces.len()
        );
    }

    #[test]
    fn model_contact_shaft_attached_to_host_is_classified_as_branch() {
        let model = box_mesh(Vec3::new(5.0, -2.0, 3.0), Vec3::new(7.0, 2.0, 7.0));
        let support = merge_meshes(&[
            cylinder_mesh(0.8, 0.0, 10.0, 24),
            horizontal_cylinder(0.5, 0.0, 5.0, 5.0, 24),
        ]);
        let result = reconstruct_supports(SupportReconstructionRequest {
            model,
            support,
            plate_z_mm: 0.0,
            options: SupportReconstructionOptions::default(),
        })
        .unwrap();

        assert_eq!(result.graph.attachments.len(), 1);
        let attachment = &result.graph.attachments[0];
        assert_eq!(attachment.guest_axial_candidate_id, "axial-000001");
        assert_eq!(attachment.host_axial_candidate_id, "axial-000000");
        assert!(attachment.distance_mm < 1e-5);
        assert!(result.graph.endpoints.iter().any(|endpoint| {
            endpoint.axial_candidate_id == "axial-000001" && endpoint.kind == EndpointKind::Support
        }));
        let branch = result
            .graph
            .topology_candidates
            .iter()
            .find(|candidate| candidate.axial_candidate_id == "axial-000001")
            .unwrap();
        assert_eq!(branch.kind, SupportTopologyKind::Branch);
        let host = result
            .graph
            .topology_candidates
            .iter()
            .find(|candidate| candidate.axial_candidate_id == "axial-000000")
            .unwrap();
        assert_eq!(host.kind, SupportTopologyKind::Trunk);
    }

    #[test]
    fn shaft_between_two_hosts_is_classified_as_brace() {
        let model = box_mesh(Vec3::new(20.0, 20.0, 20.0), Vec3::new(22.0, 22.0, 22.0));
        let support = merge_meshes(&[
            cylinder_mesh(0.8, 0.0, 10.0, 24),
            translated(cylinder_mesh(0.8, 0.0, 10.0, 24), Vec3::new(5.0, 0.0, 0.0)),
            horizontal_cylinder(0.5, 0.0, 5.0, 5.0, 24),
        ]);
        let result = reconstruct_supports(SupportReconstructionRequest {
            model,
            support,
            plate_z_mm: 0.0,
            options: SupportReconstructionOptions::default(),
        })
        .unwrap();

        let brace = result
            .graph
            .topology_candidates
            .iter()
            .find(|candidate| candidate.axial_candidate_id == "axial-000002")
            .unwrap();
        assert_eq!(brace.kind, SupportTopologyKind::Brace);
        assert!(result.graph.topology_candidates.iter().all(|candidate| {
            candidate.axial_candidate_id == "axial-000002"
                || candidate.kind == SupportTopologyKind::Trunk
        }));
        assert_eq!(brace.attachment_ids.len(), 2);
        let brace_attachments: Vec<&AttachmentCandidate> = result
            .graph
            .attachments
            .iter()
            .filter(|attachment| attachment.guest_axial_candidate_id == "axial-000002")
            .collect();
        assert_eq!(brace_attachments.len(), 2);
        assert_eq!(brace_attachments[0].host_axial_candidate_id, "axial-000000");
        assert_eq!(brace_attachments[1].host_axial_candidate_id, "axial-000001");
    }

    #[test]
    fn radial_profile_recovers_shaft_span_between_transitions() {
        let model = box_mesh(Vec3::new(-2.0, -2.0, 10.0), Vec3::new(2.0, 2.0, 14.0));
        let support = profiled_axial_mesh(&[(0.0, 2.0), (1.0, 0.5), (9.0, 0.5), (10.0, 1.0)], 24);
        let result = reconstruct_supports(SupportReconstructionRequest {
            model,
            support,
            plate_z_mm: 0.0,
            options: SupportReconstructionOptions::default(),
        })
        .unwrap();

        let candidate = &result.graph.axial_candidates[0];
        assert!((candidate.shaft_start.z - 1.0).abs() < 0.05);
        assert!((candidate.shaft_end.z - 9.0).abs() < 0.05);
        assert!((candidate.shaft_length_mm - 8.0).abs() < 0.05);
        assert!((candidate.start_transition_length_mm - 1.0).abs() < 0.05);
        assert!((candidate.end_transition_length_mm - 1.0).abs() < 0.05);
        assert!((candidate.start_radius_mm - 2.0).abs() < 0.05);
        assert!((candidate.end_radius_mm - 1.0).abs() < 0.05);
        assert!((result.graph.roots[0].diameter_mm - 4.0).abs() < 0.1);
        assert!((result.graph.contacts[0].diameter_mm - 2.0).abs() < 0.1);
    }
}
