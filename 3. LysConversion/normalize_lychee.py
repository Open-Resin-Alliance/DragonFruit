import json
import argparse
import math
from pathlib import Path
from typing import Dict, List, Any, Tuple

# --- Data Structures for Dragonfruit Format ---

def create_vec3(x, y, z):
    return {"x": x, "y": y, "z": z}

def add_vec3(v1, v2):
    return {"x": v1["x"] + v2["x"], "y": v1["y"] + v2["y"], "z": v1["z"] + v2["z"]}

class DragonfruitBuilder:
    def __init__(self):
        self.roots = []
        self.trunks = []
        self.branches = []
        self.braces = []
        self.knots = []
        self.object_center = {"x": 0, "y": 0, "z": 0}
        self.stats = {"roots": 0, "trunks": 0, "branches": 0, "braces": 0, "orphans": 0}

    def set_object_center(self, center: Dict[str, float]):
        self.object_center = center

    def to_world(self, local_pos: Dict[str, float]) -> Dict[str, float]:
        return add_vec3(self.object_center, local_pos)

    def add_root(self, id: str, base_pos: Dict[str, float], diameter: float):
        world_pos = self.to_world(base_pos)
        self.roots.append({
            "id": id,
            "transform": {"pos": world_pos, "rot": {"x": 0, "y": 0, "z": 0, "w": 1}},
            "diameter": diameter
        })
        self.stats["roots"] += 1

    def add_trunk(self, id: str, root_id: str, tip_pos: Dict[str, float], diameter: float):
        world_tip = self.to_world(tip_pos)
        # Simplified segment for now: just one segment from root to tip
        self.trunks.append({
            "id": id,
            "rootId": root_id,
            "segments": [
                {
                    "id": f"{id}_seg0",
                    "diameter": diameter,
                    "topJoint": {"pos": world_tip, "diameter": diameter}, # Simplified
                    # Bottom joint is implicitly at the Root
                }
            ]
        })
        self.stats["trunks"] += 1

    def add_branch(self, id: str, parent_id: str, base_pos: Dict[str, float], tip_pos: Dict[str, float], diameter: float):
        world_base = self.to_world(base_pos)
        world_tip = self.to_world(tip_pos)
        
        # In a real app, we'd calculate the exact 't' on the parent shaft.
        # For now, we store the world position of the knot.
        knot_id = f"k_{id}"
        self.knots.append({
            "id": knot_id,
            "parentShaftId": parent_id, # Simplified: pointing to parent support ID for now
            "pos": world_base 
        })

        self.branches.append({
            "id": id,
            "parentKnotId": knot_id,
            "segments": [
                {
                    "id": f"{id}_seg0",
                    "diameter": diameter,
                    "topJoint": {"pos": world_tip, "diameter": diameter}
                }
            ]
        })
        self.stats["branches"] += 1

    def add_brace(self, id: str, start_parent_id: str, end_parent_id: str, start_pos: Dict[str, float], end_pos: Dict[str, float], diameter: float):
        world_start = self.to_world(start_pos)
        world_end = self.to_world(end_pos)

        knot_a_id = f"k_{id}_a"
        knot_b_id = f"k_{id}_b"

        self.knots.append({"id": knot_a_id, "parentShaftId": start_parent_id, "pos": world_start})
        self.knots.append({"id": knot_b_id, "parentShaftId": end_parent_id, "pos": world_end})

        self.braces.append({
            "id": id,
            "startKnotId": knot_a_id,
            "endKnotId": knot_b_id,
            "profile": {"diameter": diameter}
        })
        self.stats["braces"] += 1

    def export(self) -> Dict[str, Any]:
        return {
            "version": 1,
            "meta": {
                "source": "Lychee Slicer",
                "objectCenter": self.object_center
            },
            "roots": self.roots,
            "trunks": self.trunks,
            "branches": self.branches,
            "braces": self.braces,
            "knots": self.knots # Included for debugging/completeness
        }

# --- Main Logic ---

def normalize_lychee(input_path: str, output_path: str):
    print(f"Loading {input_path}...")
    with open(input_path, 'r', encoding='utf-8') as f:
        data = json.load(f)

    builder = DragonfruitBuilder()

    # 1. Find Object Center
    # We look for 'o5' or the first object that has 'supportsBase'
    objects = data.get("objects", {}).get("present", {}).get("byId", {})
    target_obj = None
    
    # Try to find o5 specifically first, as per our analysis
    if "o5" in objects:
        target_obj = objects["o5"]
    else:
        # Fallback: find first object with supports
        for obj in objects.values():
            if obj.get("supportsBase") and len(obj["supportsBase"]) > 0:
                target_obj = obj
                break
    
    if target_obj:
        center = target_obj.get("center", {"x": 0, "y": 0, "z": 0})
        # Lychee 'center' seems to be the visual center in world space?
        # Let's verify with the logic bible hypothesis: World = Center + Local
        # Actually, let's use the 'center' field.
        print(f"Found Target Object: {target_obj.get('name', 'Unknown')}")
        print(f"Object Center: {center}")
        builder.set_object_center(center)
    else:
        print("WARNING: Could not find a target object with supports. Assuming Center=(0,0,0).")

    # 2. Process Supports
    supports = data.get("supports", {}).get("present", {}).get("byId", {})
    
    # Sort by ID to ensure some determinism, though topological sort is better
    # For this pass, we just process.
    
    for s_id, s in supports.items():
        s_type = s.get("type", 1)
        is_mini = s.get("mini", False)
        
        # Coordinates
        base = s.get("base", {"x": 0, "y": 0, "z": 0})
        tip = s.get("tip", {"x": 0, "y": 0, "z": 0})
        
        # Settings (Diameters)
        settings = s.get("settings", {})
        base_dia = settings.get("base", {}).get("diameter", 5)
        tip_dia = settings.get("tip", {}).get("diameter", 1)
        
        # Hierarchy
        parent_base_id = s.get("parentBaseId")
        parent_tip_id = s.get("parentTipId") # Used for braces (Type 0) usually

        # --- Mapping Logic ---
        
        if s_type == 0:
            # Type 0: Brace (Connecting two supports)
            # Usually has parentBaseId AND parentTipId
            if parent_base_id and parent_tip_id:
                builder.add_brace(s_id, parent_base_id, parent_tip_id, base, tip, (base_dia + tip_dia)/2)
            else:
                # Fallback or weird Type 0
                print(f"Skipping Type 0 support {s_id}: Missing parent links.")
                
        elif s_type == 1:
            # Type 1: Standard Support (Trunk or Branch)
            if parent_base_id:
                # It's a Branch (Child)
                builder.add_branch(s_id, parent_base_id, base, tip, tip_dia)
            else:
                # It's a Root (Trunk)
                # Note: In our new model, Root and Trunk are separate but linked.
                # We create both for a "Rooted Trunk".
                builder.add_root(s_id, base, base_dia) # Using same ID for root? Maybe suffix it.
                builder.add_trunk(s_id, s_id, tip, tip_dia)

    # 3. Export
    out_data = builder.export()
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(out_data, f, indent=2)
    
    print(f"Normalization Complete.")
    print(f"Stats: {builder.stats}")
    print(f"Saved to: {output_path}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Normalize Lychee Slicer JSON to Dragonfruit Format")
    parser.add_argument("input", help="Path to scene.decrypted.json")
    parser.add_argument("--out", help="Output path", default="dragonfruit_supports.json")
    args = parser.parse_args()
    
    normalize_lychee(args.input, args.out)
