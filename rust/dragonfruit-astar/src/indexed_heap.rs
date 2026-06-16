//! Indexed binary min-heap for the A* open set.
//!
//! Supports O(log n) push, pop, and decrease-key via an internal index map.
//! Equivalent to the JS `heapPushOrUpdate` / `heapPopIndexed` pattern.

use std::cmp::Ordering;

/// An entry in the A* open set.
#[derive(Debug, Clone, Copy)]
pub struct HeapEntry {
    /// Cell key (quantised 3D coordinate).
    pub key: u64,
    /// f = g + h (estimated total cost).
    pub f: f32,
    /// g = actual cost from start.
    pub g: f32,
}

impl PartialEq for HeapEntry {
    fn eq(&self, other: &Self) -> bool {
        self.f == other.f
    }
}

impl Eq for HeapEntry {}

// Natural ordering by f (smaller = better).  The heap operations use direct
// f comparisons rather than Ord, so this is for compatibility only.
impl PartialOrd for HeapEntry {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        self.f.partial_cmp(&other.f)
    }
}

impl Ord for HeapEntry {
    fn cmp(&self, other: &Self) -> Ordering {
        self.f.partial_cmp(&other.f).unwrap_or(Ordering::Equal)
    }
}

/// Indexed binary min-heap.  Tracks entry positions by key for O(1) lookups
/// and O(log n) decrease-key operations.
pub struct IndexedHeap {
    heap: Vec<HeapEntry>,
    /// Maps cell key → index in `heap`.
    index: ahash::HashMap<u64, usize>,
}

impl IndexedHeap {
    pub fn new(capacity: usize) -> Self {
        Self {
            heap: Vec::with_capacity(capacity),
            index: ahash::HashMap::with_capacity_and_hasher(
                capacity,
                ahash::RandomState::default(),
            ),
        }
    }

    pub fn len(&self) -> usize {
        self.heap.len()
    }

    pub fn is_empty(&self) -> bool {
        self.heap.is_empty()
    }

    /// Push a new entry or decrease the key of an existing entry.
    /// If the entry already exists and the new f is not better, it's a no-op.
    pub fn push_or_update(&mut self, entry: HeapEntry) {
        if let Some(&existing_idx) = self.index.get(&entry.key) {
            let existing = &self.heap[existing_idx];
            // Only update if new f is better (smaller)
            if entry.f >= existing.f {
                return;
            }
            self.heap[existing_idx] = entry;
            self.sift_up(existing_idx);
            let new_idx = self.index[&entry.key];
            self.sift_down(new_idx);
        } else {
            self.heap.push(entry);
            let idx = self.heap.len() - 1;
            self.index.insert(entry.key, idx);
            self.sift_up(idx);
        }
    }

    /// Pop the entry with the smallest f.
    pub fn pop(&mut self) -> Option<HeapEntry> {
        if self.heap.is_empty() {
            return None;
        }

        let top = self.heap[0];
        self.index.remove(&top.key);

        if self.heap.len() == 1 {
            self.heap.pop();
            return Some(top);
        }

        let last = self.heap.pop().unwrap();
        self.heap[0] = last;
        self.index.insert(last.key, 0);
        self.sift_down(0);

        Some(top)
    }

    /// Build the heap from a vector of entries.
    pub fn from_entries(entries: Vec<HeapEntry>) -> Self {
        let len = entries.len();
        let mut heap = Self {
            heap: entries,
            index: ahash::HashMap::with_capacity_and_hasher(
                len,
                ahash::RandomState::default(),
            ),
        };

        // Rebuild index
        for (i, entry) in heap.heap.iter().enumerate() {
            heap.index.insert(entry.key, i);
        }

        // Heapify
        for i in (0..len / 2).rev() {
            heap.sift_down(i);
        }

        heap
    }

    // ---- Internal ----

    fn swap(&mut self, i: usize, j: usize) {
        self.heap.swap(i, j);
        self.index.insert(self.heap[i].key, i);
        self.index.insert(self.heap[j].key, j);
    }

    fn sift_up(&mut self, start: usize) {
        let mut i = start;
        while i > 0 {
            let parent = (i - 1) >> 1;
            // Min-heap: parent should have smaller f
            if self.heap[parent].f <= self.heap[i].f {
                break;
            }
            self.swap(parent, i);
            i = parent;
        }
    }

    fn sift_down(&mut self, start: usize) {
        let len = self.heap.len();
        let mut i = start;
        loop {
            let left = i * 2 + 1;
            let right = left + 1;
            let mut smallest = i;

            if left < len && self.heap[left].f < self.heap[smallest].f {
                smallest = left;
            }
            if right < len && self.heap[right].f < self.heap[smallest].f {
                smallest = right;
            }
            if smallest == i {
                break;
            }

            self.swap(i, smallest);
            i = smallest;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_push_pop() {
        let mut heap = IndexedHeap::new(8);
        heap.push_or_update(HeapEntry { key: 1, f: 5.0, g: 0.0 });
        heap.push_or_update(HeapEntry { key: 2, f: 3.0, g: 0.0 });
        heap.push_or_update(HeapEntry { key: 3, f: 7.0, g: 0.0 });

        assert_eq!(heap.pop().unwrap().f, 3.0);
        assert_eq!(heap.pop().unwrap().f, 5.0);
        assert_eq!(heap.pop().unwrap().f, 7.0);
        assert!(heap.is_empty());
    }

    #[test]
    fn test_decrease_key() {
        let mut heap = IndexedHeap::new(8);
        heap.push_or_update(HeapEntry { key: 1, f: 10.0, g: 0.0 });
        heap.push_or_update(HeapEntry { key: 2, f: 8.0, g: 0.0 });
        // Decrease key 1
        heap.push_or_update(HeapEntry { key: 1, f: 3.0, g: 0.0 });

        assert_eq!(heap.pop().unwrap().key, 1);
        assert_eq!(heap.pop().unwrap().key, 2);
    }

    #[test]
    fn test_no_update_worse() {
        let mut heap = IndexedHeap::new(8);
        heap.push_or_update(HeapEntry { key: 1, f: 5.0, g: 0.0 });
        // Try to set worse f
        heap.push_or_update(HeapEntry { key: 1, f: 10.0, g: 0.0 });

        assert_eq!(heap.pop().unwrap().f, 5.0);
    }
}
