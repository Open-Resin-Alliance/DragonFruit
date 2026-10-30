# File-type import

Status: **designed**. The dispatch shape is fixed; the scene payload schema the
plugin returns is the piece that still needs pinning before this can be built.

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

The host consumes the same scene document its own importers produce
(`docs/dev/formats.md` describes the runtime shape). Until that schema is pinned
for external plugins, treat this capability as unreleased: the dispatch works,
the document it hands back does not have a stable contract yet.

The intended contract, when it lands:

```json
{
  "schemaVersion": 1,
  "plates": [
    {
      "name": "Plate 1",
      "printer": { "presetId": "alphabeta.alpha-4k" },
      "models": [
        { "path": "models/part-1.stl", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1] }
      ],
      "supports": null
    }
  ]
}
```

Model paths are relative to the import's working directory, which the host
creates and removes; the plugin is expected to write the geometry it extracts
there. That is the one place a plugin writes outside the single output file, and
the host validates every path stays inside it.

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
