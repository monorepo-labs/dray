//! Code in the transcript (#856 M1): tree-sitter highlighting in place of
//! Shiki, and unified diffs in place of `@pierre/diffs`, in Pierre's colours.
//!
//! - [`CodeBlock`] — a markdown fence. [`fence_highlights`] is the same colouring
//!   for a host that lays fences out itself (gpui-base's `TextView`).
//! - [`CodeView`] — a ranged `Read`, numbered from its offset.
//! - [`DiffView`] over a [`Diff`] — an `Edit`, a `Write` or a whole file.
//!
//! Prepare once ([`Highlighted::new`], [`Diff::new`]), render many times.
//! `examples/code.rs` draws all three in both modes.

#[path = "diff.rs"]
mod diff;
#[path = "highlight.rs"]
mod highlight;
#[path = "palette.rs"]
mod palette;
#[path = "view.rs"]
mod view;

#[allow(unused_imports)]
pub use diff::{Diff, DiffItem, DiffRow, RowKind};
#[allow(unused_imports)]
pub use highlight::Lang;
#[allow(unused_imports)]
pub use palette::CodePalette;
#[allow(unused_imports)]
pub use view::{CodeBlock, CodeView, DiffView, Highlighted, fence_highlights};
