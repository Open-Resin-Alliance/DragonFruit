# File-type import

Status: **designed, and blocked on a format that does not exist yet.**

The dispatch shape below is settled. What is missing is the payload: the
compiled-in tier's `handleFileTypeImport` returns **live objects** (a
`THREE.BufferGeometry` per model, with transforms and support data), because it
runs in the webview. A sideloaded plugin is a separate process and can only send
bytes, so this capability needs a serializable scene payload: geometry buffers
(positions, normals, indices), per-model transforms, and support data in the
host's internal format.

That interchange format is a design decision, not plumbing, and per-material
geometry is about to change it, so it is deliberately not pinned here. Pinning it
before the multi-material work lands would mean pinning it twice.

`fileType` lets a plugin open a project file DragonFruit does not parse: a vendor
container, a printer's job archive, a design file that carries plates and
supports. The host asks "is this yours?" and, if so, "give me a scene".

## Messages

```json
→ {"type":"import.detect","id":4,"name":"job.apf","head":"<base64 of first 4 KiB>"}
← {"type":"import.detect.result","id":4,"match":true}

→ {"type":"import","id":5,"input":"C:\\\\…\\\\job.apf","output":"C:\\\\…\\\\scene.json"}
← {"type":"import.result","id":5,"formatId":"apf"}
```

- `detect` receives the file name and the first 4 KiB so a plugin can sniff a
  magic or an extension without opening the file. Answer `match: false` and the
  host moves on; that is not an error.
- `import` receives an input path (read it directly — do not send the file
  through the pipe) and an output path the host created. Write the scene there.
- The result names the format the host records for the imported scene; it appears
  in the scene's metadata.

## The scene payload

The constraint is the compiled-in contract: a model arrives with geometry, a
transform, and any supports that belong to it, one entry per model so supports
stay attached to the right one. Externally the same information has to be bytes,
so the payload will carry:

- geometry: positions, normals and indices, plus the index width;
- per-model: a stable `modelId`, an optional display name, a 4x4 transform;
- supports, in whatever the host's internal support format serializes to;
- optionally, hollowing or punch data the format carries.

Where it is written is already decided: a working directory the host creates per
import, with every path validated to stay inside it. The encoding is not decided,
and the page will carry the schema once the multi-material work settles what a
model carries per material.

## What it is good for

- A vendor container that holds a plate plus its supports, so a user can reopen
  their work instead of re-slicing from scratch.
- A printer job archive whose settings and layers should come back as a scene.

## What it is not

- **Not a mesh importer.** STL/OBJ/3MF go through the host's own loaders; a
  plugin that only renames a mesh has nothing to add.
- **Not a renderer.** The host builds the scene; the plugin produces data.
- **Not a path into the slicer.** An imported scene is scene data. A plugin
  cannot inject code, hooks or settings into the slicing pipeline through it.
