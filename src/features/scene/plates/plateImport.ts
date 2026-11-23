/**
 * Plates a scene import brings with it.
 *
 * Opening a scene merges into the current one, so the file's plates cannot
 * just take over: opening the same scene twice would land the new models on
 * the plates already here and overwrite their names (#1049). When the scene
 * already holds models the file's plates are appended as NEW plates, with
 * fresh ids the imported models are remapped onto; into an empty scene the
 * file keeps its own plate ids, as before.
 */

/** One plate as a scene file lists it. */
export type ImportedPlate = {
  id: string;
  name?: string;
};

/** What an import does with the plates its file lists. */
export type ResolvedImportedPlates = {
  /** The plates to put in the scene, in the file's order. */
  plates: { id: string; name: string }[];
  /** The scene plate id each of the file's plate ids maps to, for remapping models. */
  idMap: Map<string, string>;
  /** The plate the file had active, after remapping, if it named one. */
  activePlateId: string | undefined;
  /** Whether the plates are appended to the scene's own, rather than replacing them. */
  append: boolean;
};

export function resolveImportedPlates(
  filePlates: ImportedPlate[],
  activePlateId: string | null,
  hasExistingModels: boolean,
  generateId: () => string,
): ResolvedImportedPlates {
  if (filePlates.length === 0) {
    return { plates: [], idMap: new Map(), activePlateId: undefined, append: false };
  }
  const idMap = new Map<string, string>();
  const plates = filePlates.map((plate) => {
    const id = hasExistingModels ? generateId() : plate.id;
    idMap.set(plate.id, id);
    return { id, name: plate.name ?? '' };
  });
  return {
    plates,
    idMap,
    activePlateId: activePlateId ? idMap.get(activePlateId) ?? plates[0].id : plates[0].id,
    append: hasExistingModels,
  };
}
