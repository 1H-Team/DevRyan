//! The allocator a group's command runs with: blocks of 1 MiB or more are mapped from the kernel and unmapped when
//! freed, every other block is the system allocator's. A 4 MiB document then costs its pages only while it is
//! alive: with the system allocator alone, macOS kept the freed blocks of each such request resident for seconds
//! (BH7: 60 requests of a 4 MiB document left 250 MiB resident; a minute later half of it), which made the candidate
//! as heavy as Node at the group's limit.

use std::alloc::{GlobalAlloc, Layout, System};

/// Mapped directly from this size on.
const BIG: usize = 1024 * 1024;
const PAGE: usize = 4096;

pub struct BigBlocksMapped;

const fn big(layout: &Layout) -> bool {
    layout.size() >= BIG && layout.align() <= PAGE
}

// SAFETY: small blocks are the system allocator's, with its contract; a big block is a fresh private anonymous
// mapping of at least `size` bytes (page aligned, so any alignment up to a page holds), zero-filled, unmapped with the
// same size by `dealloc`, and never handed to the system allocator.
unsafe impl GlobalAlloc for BigBlocksMapped {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if !big(&layout) {
            // SAFETY: forwarded unchanged.
            return unsafe { System.alloc(layout) };
        }
        // SAFETY: an anonymous private mapping with no address hint; the result is checked against MAP_FAILED.
        let mapped = unsafe {
            libc::mmap(
                std::ptr::null_mut(),
                layout.size(),
                libc::PROT_READ | libc::PROT_WRITE,
                libc::MAP_PRIVATE | libc::MAP_ANON,
                -1,
                0,
            )
        };
        if mapped == libc::MAP_FAILED { std::ptr::null_mut() } else { mapped.cast() }
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        if !big(&layout) {
            // SAFETY: forwarded unchanged.
            return unsafe { System.alloc_zeroed(layout) };
        }
        // SAFETY: a fresh anonymous mapping is zero-filled.
        unsafe { self.alloc(layout) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        if big(&layout) {
            // SAFETY: `ptr` is a mapping `alloc` made with this size.
            unsafe { libc::munmap(ptr.cast(), layout.size()) };
        } else {
            // SAFETY: `ptr` came from System with this layout.
            unsafe { System.dealloc(ptr, layout) }
        }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        // SAFETY: the caller's layout and size are valid for the old block; the new layout keeps its alignment.
        let new_layout = unsafe { Layout::from_size_align_unchecked(new_size, layout.align()) };
        if !big(&layout) && !big(&new_layout) {
            // SAFETY: both blocks are the system allocator's.
            return unsafe { System.realloc(ptr, layout, new_size) };
        }
        // SAFETY: a new block, the old one's bytes copied (the smaller size), the old one freed by its own kind.
        unsafe {
            let fresh = self.alloc(new_layout);
            if !fresh.is_null() {
                std::ptr::copy_nonoverlapping(ptr, fresh, layout.size().min(new_size));
                self.dealloc(ptr, layout);
            }
            fresh
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn big_and_small_blocks() {
        let allocator = BigBlocksMapped;
        for size in [16, BIG - 1, BIG, 5 * BIG] {
            let layout = Layout::from_size_align(size, 8).unwrap();
            // SAFETY: a valid layout; the block is written within its size, grown, checked and freed with its layout.
            unsafe {
                let block = allocator.alloc_zeroed(layout);
                assert!(!block.is_null());
                assert_eq!(*block.add(size - 1), 0);
                *block = 7;
                let grown = allocator.realloc(block, layout, size * 2);
                assert_eq!(*grown, 7);
                allocator.dealloc(grown, Layout::from_size_align(size * 2, 8).unwrap());
            }
        }
    }
}
