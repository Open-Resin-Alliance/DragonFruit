import type { AutoBracingPattern } from './settings';
import type { BracePair } from './initialPattern';

export function applyRepeatingPattern<T>(
    pairs: BracePair<T>[],
    pattern: AutoBracingPattern,
    place: (low: T, high: T, section: 'repeating') => void,
): void {
    for (const edge of pairs) {
        place(edge.a, edge.b, 'repeating');
        if (pattern === 'crossDiagonal') {
            place(edge.b, edge.a, 'repeating');
        }
    }
}
