import type { AutoBracingPattern } from './settings';

export type BracePair<T> = { a: T; b: T };

export function applyInitialPattern<T>(
    pairs: BracePair<T>[],
    pattern: AutoBracingPattern,
    place: (low: T, high: T, section: 'initial') => void,
): void {
    for (const edge of pairs) {
        place(edge.a, edge.b, 'initial');
        if (pattern === 'crossDiagonal') {
            place(edge.b, edge.a, 'initial');
        }
    }
}
