import json
import re

file_path = r"c:\Users\tyman\OneDrive\AutoSupport\Scratch\backup\scene.decrypted.json"

def analyze_file():
    print("Analyzing file...")
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            lines = f.readlines()
            
        print(f"Total lines: {len(lines)}")
        
        mini_true_lines = []
        bracing_lines = []
        types_found = set()
        
        for i, line in enumerate(lines):
            if '"mini": true' in line:
                mini_true_lines.append(i + 1)
            if 'bracing' in line.lower():
                bracing_lines.append(i + 1)
            
            type_match = re.search(r'"type":\s*(\d+)', line)
            if type_match:
                types_found.add(int(type_match.group(1)))

        print(f"Found 'mini': true at lines: {mini_true_lines[:10]}")
        print(f"Found 'bracing' at lines: {bracing_lines[:10]}")
        print(f"Found types: {sorted(list(types_found))}")
        
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    analyze_file()
