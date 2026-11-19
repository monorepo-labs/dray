//! A unified diff of two texts, laid out the way `@pierre/diffs` draws one:
//! hunks with three lines of context, a separator for what is folded away,
//! deletions before additions, and the changed words of a replaced line marked.

use std::ops::Range;

use similar::{Algorithm, DiffOp, capture_diff_slices, group_diff_ops};

use super::highlight::{Lang, Span, highlight, line_ranges, spans_in};

/// Context kept round each change, as the library's default.
const CONTEXT: usize = 3;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RowKind {
    Context,
    Addition,
    Deletion,
}

#[derive(Clone, Debug)]
pub struct DiffRow {
    pub kind: RowKind,
    /// 1-based. A unified view has one number column: the old line's for a
    /// deletion, the new line's otherwise.
    pub number: usize,
    pub text: String,
    pub spans: Vec<Span>,
    /// Byte ranges of the words that changed, for a line paired with its
    /// counterpart in a replace.
    pub emphasis: Vec<Range<usize>>,
}

#[derive(Clone, Debug)]
pub enum DiffItem {
    Row(DiffRow),
    /// Unchanged lines folded away.
    Folded(usize),
}

/// Everything a diff view draws, computed once: diffing, highlighting both
/// sides and splitting them into rows. Cache it beside the event it came from.
#[derive(Clone, Debug)]
pub struct Diff {
    pub path: String,
    pub items: Vec<DiffItem>,
    pub additions: usize,
    pub deletions: usize,
}

impl Diff {
    /// `old` is `None` for a file that did not exist before (or a `Write`,
    /// which never reports what it replaced): every line is an addition.
    pub fn new(path: &str, old: Option<&str>, new: &str) -> Diff {
        let old = old.unwrap_or("");
        let lang = Lang::from_path(path);
        let old_side = Side::new(old, lang);
        let new_side = Side::new(new, lang);
        let old_lines: Vec<&str> = old_side.lines.iter().map(|r| &old[r.clone()]).collect();
        let new_lines: Vec<&str> = new_side.lines.iter().map(|r| &new[r.clone()]).collect();
        let ops = capture_diff_slices(Algorithm::Myers, &old_lines, &new_lines);

        let mut items = Vec::new();
        let (mut additions, mut deletions) = (0, 0);
        let mut shown_to = 0;
        let groups = group_diff_ops(ops, CONTEXT);
        for group in &groups {
            let Some(first) = group.first() else { continue };
            let start = first.old_range().start;
            if start > shown_to {
                items.push(DiffItem::Folded(start - shown_to));
            }
            for op in group {
                match *op {
                    DiffOp::Equal { new_index, len, .. } => {
                        for i in 0..len {
                            items.push(new_side.row(RowKind::Context, new_index + i, Vec::new()));
                        }
                    }
                    DiffOp::Delete { old_index, old_len, .. } => {
                        deletions += old_len;
                        for i in 0..old_len {
                            items.push(old_side.row(RowKind::Deletion, old_index + i, Vec::new()));
                        }
                    }
                    DiffOp::Insert { new_index, new_len, .. } => {
                        additions += new_len;
                        for i in 0..new_len {
                            items.push(new_side.row(RowKind::Addition, new_index + i, Vec::new()));
                        }
                    }
                    DiffOp::Replace { old_index, old_len, new_index, new_len } => {
                        deletions += old_len;
                        additions += new_len;
                        let pairs: Vec<_> = (0..old_len.min(new_len))
                            .map(|i| changed_words(old_lines[old_index + i], new_lines[new_index + i]))
                            .collect();
                        for i in 0..old_len {
                            let marks = pairs.get(i).map(|p| p.0.clone()).unwrap_or_default();
                            items.push(old_side.row(RowKind::Deletion, old_index + i, marks));
                        }
                        for i in 0..new_len {
                            let marks = pairs.get(i).map(|p| p.1.clone()).unwrap_or_default();
                            items.push(new_side.row(RowKind::Addition, new_index + i, marks));
                        }
                    }
                }
            }
            shown_to = group.last().map_or(shown_to, |op| op.old_range().end);
        }
        if !groups.is_empty() && shown_to < old_lines.len() {
            items.push(DiffItem::Folded(old_lines.len() - shown_to));
        }
        Diff { path: path.to_string(), items, additions, deletions }
    }
}

/// One side's lines and their highlight, split per line on demand.
struct Side<'a> {
    text: &'a str,
    lines: Vec<Range<usize>>,
    spans: Vec<Span>,
}

impl<'a> Side<'a> {
    /// The side is highlighted whole, not line by line, so a line inside a
    /// block comment or a multi-line string still colours as one.
    fn new(text: &'a str, lang: Option<Lang>) -> Side<'a> {
        let spans = lang.map(|lang| highlight(lang, text)).unwrap_or_default();
        Side { text, lines: line_ranges(text), spans }
    }

    fn row(&self, kind: RowKind, index: usize, emphasis: Vec<Range<usize>>) -> DiffItem {
        let range = self.lines[index].clone();
        DiffItem::Row(DiffRow {
            kind,
            number: index + 1,
            text: self.text[range.clone()].to_string(),
            spans: spans_in(&self.spans, &range),
            emphasis,
        })
    }
}

/// The words that differ between a deleted line and the added line it became.
/// None when more than half of either line changed: marking nearly a whole
/// line says nothing the row's own tint doesn't.
fn changed_words(old: &str, new: &str) -> (Vec<Range<usize>>, Vec<Range<usize>>) {
    let (old_words, new_words) = (words(old), words(new));
    let old_tokens: Vec<&str> = old_words.iter().map(|r| &old[r.clone()]).collect();
    let new_tokens: Vec<&str> = new_words.iter().map(|r| &new[r.clone()]).collect();
    let mut marks = (Vec::new(), Vec::new());
    for op in capture_diff_slices(Algorithm::Myers, &old_tokens, &new_tokens) {
        let (o, n) = (op.old_range(), op.new_range());
        if matches!(op, DiffOp::Equal { .. }) {
            continue;
        }
        if !o.is_empty() {
            push_merged(&mut marks.0, old_words[o.start].start..old_words[o.end - 1].end);
        }
        if !n.is_empty() {
            push_merged(&mut marks.1, new_words[n.start].start..new_words[n.end - 1].end);
        }
    }
    let covered = |m: &[Range<usize>]| m.iter().map(|r| r.len()).sum::<usize>();
    let too_much = |m: &[Range<usize>], len: usize| len > 0 && covered(m) * 2 > len;
    if too_much(&marks.0, old.trim().len()) || too_much(&marks.1, new.trim().len()) {
        return (Vec::new(), Vec::new());
    }
    marks
}

fn push_merged(marks: &mut Vec<Range<usize>>, range: Range<usize>) {
    match marks.last_mut() {
        Some(last) if last.end == range.start => last.end = range.end,
        _ => marks.push(range),
    }
}

/// Runs of word characters, runs of whitespace, and each other character alone.
fn words(line: &str) -> Vec<Range<usize>> {
    #[derive(PartialEq)]
    enum Class {
        Word,
        Space,
        Other,
    }
    let class = |c: char| {
        if c.is_alphanumeric() || c == '_' {
            Class::Word
        } else if c.is_whitespace() {
            Class::Space
        } else {
            Class::Other
        }
    };
    let mut out: Vec<Range<usize>> = Vec::new();
    let mut prev: Option<Class> = None;
    for (i, c) in line.char_indices() {
        let k = class(c);
        let joins = k != Class::Other && prev.as_ref() == Some(&k);
        match out.last_mut() {
            Some(last) if joins => last.end = i + c.len_utf8(),
            _ => out.push(i..i + c.len_utf8()),
        }
        prev = Some(k);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(diff: &Diff) -> String {
        diff.items
            .iter()
            .map(|item| match item {
                DiffItem::Row(r) => match r.kind {
                    RowKind::Context => ' ',
                    RowKind::Addition => '+',
                    RowKind::Deletion => '-',
                },
                DiffItem::Folded(_) => '~',
            })
            .collect()
    }

    #[test]
    fn a_new_file_is_all_additions() {
        let diff = Diff::new("a.rs", None, "fn a() {}\nfn b() {}\n");
        assert_eq!(kinds(&diff), "++");
        assert_eq!((diff.additions, diff.deletions), (2, 0));
    }

    #[test]
    fn a_missing_trailing_newline_is_not_a_change() {
        // Edit fragments usually arrive without one; the boundary line must not
        // read as changed on both sides.
        let diff = Diff::new("a.ts", Some("a\nb"), "a\nc");
        assert_eq!(kinds(&diff), " -+");
        assert_eq!((diff.additions, diff.deletions), (1, 1));
    }

    #[test]
    fn folds_unchanged_lines_beyond_the_context() {
        let old: String = (1..=20).map(|i| format!("line {i}\n")).collect();
        let new = old.replace("line 10\n", "line ten\n");
        let diff = Diff::new("x.txt", Some(&old), &new);
        assert_eq!(kinds(&diff), "~   -+   ~");
        let DiffItem::Folded(n) = diff.items[0] else { panic!() };
        assert_eq!(n, 6);
        let DiffItem::Row(row) = &diff.items[4] else { panic!() };
        assert_eq!((row.number, row.kind), (10, RowKind::Deletion));
    }

    #[test]
    fn marks_the_changed_word_only() {
        let (old, new) = changed_words("let count = 1;", "let total = 1;");
        assert_eq!(old, vec![4..9]);
        assert_eq!(new, vec![4..9]);
    }

    #[test]
    fn a_rewritten_line_carries_no_marks() {
        assert_eq!(changed_words("abc def", "xyz uvw"), (Vec::new(), Vec::new()));
    }
}
