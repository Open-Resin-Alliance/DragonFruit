MSLA Slicer Engine Architecture
Target Stack: Node.js, TypeScript, React, WebAssembly (WASM).

1. Core Geometry & Repair Engine: manifold-3d
https://manifoldcad.org/jsdocs/
Role: The "Construction Kernel" (Hollowing, Hole Digging, Boolean Operations, Slicing)

Why it is recommended:

Constructive Repair (The "Shrink Wrap" Method): instead of trying to stitch bad edges together (which often fails), Manifold allows you to convert the mesh into a Signed Distance Field (SDF) and reconstruct it. This effectively "shrink wraps" the geometry, guaranteeing a watertight, printable result without altering the design intent or reducing poly count unnecessarily.

Precision Hollowing: It offers the industry's most robust Offset function. It can handle complex internal geometry intersections when creating hollow shells (walls) without generating artifacts that crash other kernels.

Boolean Stability: MSLA requires merging the model with supports and subtracting drain holes. Manifold’s boolean operations are mathematically guaranteed to result in a valid "manifold" (watertight) mesh, preventing the common "non-manifold edge" errors found in other slicers.

Direct Slicing: It includes a native CrossSection feature that rapidly generates the 2D layer polygons needed for your LCD/DLP masking directly from the high-res mesh.

2. Analytical & Inspection Engine: three-mesh-bvh
Role: The "Visual Analyst" (Thickness Heatmaps, Collision, Raycasting)

Why it is recommended:

Thickness Heatmaps (MeshLab Equivalent): To replicate MeshLab’s visual analysis, you need to measure wall thickness across millions of points. This library builds a Bounding Volume Hierarchy (BVH) that accelerates raycasting by 1000x. You can cast rays inward from every vertex to instantly detect and visualize thin walls (e.g., < 1mm) in real-time in your React viewport.

Internal Island Detection: Since you are writing your own support logic, this library allows you to cast rays inside the hollowed model to detect internal islands that need internal supports—a critical feature for professional MSLA printing.

Non-Destructive: It performs all analysis on the original geometry without modifying a single vertex.

3. Scientific Geometry Toolkit: libigl.js
Role: The "Mathematician" (Curvature Analysis, Topology Repair, Hole Filling)

Why it is recommended:

Hole Filling (Cap & Stitch): For models with missing triangles (holes), libigl provides exact algorithms to identify open boundary loops and triangulate them smoothly. This is the direct equivalent to MeshLab’s "Close Holes" feature.

Curvature Analysis: If you want to visualize surface quality (like MeshLab’s "Mean Curvature" view), this library calculates the exact differential geometry needed to map curvature to a color gradient.

Winding Number Check: It can mathematically determine the "interior" of a messy mesh even if the mesh has holes. This is useful for deciding which side of a triangle is "inside" vs "outside" before you attempt to hollow it.

Summary of Workflow
Ingestion: Load the high-fidelity mesh into three-mesh-bvh for immediate visual analysis (thickness heatmaps, support requirement checks).

Repair & Prep: If the analysis detects holes, pass the data through libigl.js to topologically stitch and close gaps.

Construction: Pass the clean mesh to manifold-3d to generate the hollow shell, boolean subtract the drain holes, and merge your custom supports.

Output: Use manifold-3d to slice the final watertight assembly into 2D layers for the printer.