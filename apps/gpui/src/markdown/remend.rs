//! A port of `remend` 1.4.0, the step Streamdown runs over a message while it
//! streams: it closes what the text has opened and not yet closed (`**bold`,
//! `` `code ``, `[label](partial`), so half-arrived markdown renders as it will
//! once finished instead of flashing literal markers.
//!
//! Ported rule for rule, defaults included, so a partial message draws here
//! what it draws in the React app. `reply.remend.json` is remend's own answer
//! for every prefix of `reply.md`, and the test holds this port to it. Indices
//! are chars where remend's are UTF-16 units; they differ only past the BMP,
//! where both sides treat the character as a non-word one.

/// What remend puts in an unfinished link's href. The renderer draws such a
/// link as its plain label, which is what harden's `text-only` policy leaves of
/// it in the React app.
pub const INCOMPLETE_LINK: &str = "streamdown:incomplete-link";
/// The same for an unfinished image's src; the renderer draws nothing for it.
pub const INCOMPLETE_IMAGE: &str = "streamdown:incomplete-image";

/// `text` with every construct it leaves open closed, as remend does with its
/// default options (inline `$` math off, everything else on).
pub fn remend(text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }
    let mut r: Vec<char> = text.chars().collect();
    trim_one_space(&mut r);
    let handlers: [fn(&[char]) -> Vec<char>; 13] = [
        single_tilde,
        comparison_operators,
        html_tags,
        setext_headings,
        links,
        bold_italic,
        bold,
        italic_double_underscore,
        italic_single_asterisk,
        italic_single_underscore,
        inline_code,
        strikethrough,
        katex,
    ];
    for (i, handle) in handlers.iter().enumerate() {
        r = handle(&r);
        // The links handler (index 4) ends the run once it has written a
        // placeholder, skipping the final trim too.
        if i == 4 && (ends_with(&r, &format!("]({INCOMPLETE_LINK})")) || ends_with(&r, &format!("]({INCOMPLETE_IMAGE})"))) {
            return r.into_iter().collect();
        }
    }
    trim_one_space(&mut r);
    r.into_iter().collect()
}

/// One trailing space goes, two stay: two are a hard line break.
fn trim_one_space(r: &mut Vec<char>) {
    if r.last() == Some(&' ') && !(r.len() >= 2 && r[r.len() - 2] == ' ') {
        r.pop();
    }
}

// ---------------------------------------------------------------------------
// Where code is: every char classed as prose, fence or code span.

#[derive(Clone, Copy, PartialEq, Eq)]
enum Region {
    Prose,
    FenceMarker,
    FenceInfo,
    FenceBody,
    CodeSpan,
    CodeSpanOpen,
}

struct Fence {
    ch: char,
    len: usize,
    list_indent: usize,
    quote_depth: usize,
}

struct Ctx<'a> {
    text: &'a [char],
    regions: Vec<Region>,
    open_fence: bool,
    open_span: Option<(usize, usize)>,
    math: std::cell::OnceCell<Vec<bool>>,
    link_url: std::cell::OnceCell<Vec<bool>>,
    html_tag: std::cell::OnceCell<Vec<bool>>,
}

impl<'a> Ctx<'a> {
    fn new(text: &'a [char]) -> Ctx<'a> {
        let mut regions = vec![Region::Prose; text.len()];
        let open_fence = scan_fences(text, &mut regions).is_some();
        let open_span = scan_spans(text, &mut regions);
        Ctx {
            text,
            regions,
            open_fence,
            open_span,
            math: Default::default(),
            link_url: Default::default(),
            html_tag: Default::default(),
        }
    }

    /// remend's `isWithinCodeBlockOrInlineCode`; past the end it answers
    /// whether anything is still open.
    fn in_code(&self, i: isize) -> bool {
        if i >= self.regions.len() as isize {
            return self.open_fence || self.open_span.is_some();
        }
        i >= 0 && self.regions[i as usize] != Region::Prose
    }

    fn in_span(&self, i: isize) -> bool {
        i >= 0 && (i as usize) < self.regions.len() && self.regions[i as usize] == Region::CodeSpan
    }

    fn prose(&self, i: usize) -> bool {
        self.regions.get(i) == Some(&Region::Prose)
    }

    fn in_math(&self, i: usize) -> bool {
        if i >= self.text.len() {
            return false;
        }
        self.math
            .get_or_init(|| {
                let t = self.text;
                let has = t.contains(&'$') || contains(t, &['\\', '(']) || contains(t, &['\\', '[']);
                if has { math_mask(self) } else { Vec::new() }
            })
            .get(i)
            .copied()
            .unwrap_or(false)
    }

    fn in_link_url(&self, i: usize) -> bool {
        if i >= self.text.len() {
            return false;
        }
        self.link_url
            .get_or_init(|| if contains(self.text, &[']', '(']) { link_url_mask(self) } else { Vec::new() })
            .get(i)
            .copied()
            .unwrap_or(false)
    }

    fn in_html_tag(&self, i: usize) -> bool {
        if i >= self.text.len() {
            return false;
        }
        self.html_tag
            .get_or_init(|| if self.text.contains(&'<') { html_tag_mask(self) } else { Vec::new() })
            .get(i)
            .copied()
            .unwrap_or(false)
    }
}

fn at(t: &[char], i: isize) -> Option<char> {
    if i < 0 { None } else { t.get(i as usize).copied() }
}

fn index_of(t: &[char], c: char, from: usize) -> Option<usize> {
    t.get(from..)?.iter().position(|&x| x == c).map(|p| p + from)
}

fn index_of_seq(t: &[char], pat: &[char], from: usize) -> Option<usize> {
    if pat.len() > t.len() {
        return None;
    }
    (from..=t.len() - pat.len()).find(|&i| &t[i..i + pat.len()] == pat)
}

/// JS `lastIndexOf(pat, from)`: the last match starting at or before `from`.
fn last_index_of_seq(t: &[char], pat: &[char], from: Option<usize>) -> Option<usize> {
    if pat.len() > t.len() {
        return None;
    }
    let max = (t.len() - pat.len()).min(from.unwrap_or(usize::MAX));
    (0..=max).rev().find(|&i| &t[i..i + pat.len()] == pat)
}

fn contains(t: &[char], pat: &[char]) -> bool {
    index_of_seq(t, pat, 0).is_some()
}

fn ends_with(t: &[char], s: &str) -> bool {
    let s: Vec<char> = s.chars().collect();
    t.len() >= s.len() && t[t.len() - s.len()..] == s[..]
}

fn starts_with(t: &[char], s: &[char]) -> bool {
    t.len() >= s.len() && &t[..s.len()] == s
}

fn line_end(t: &[char], from: usize) -> usize {
    index_of(t, '\n', from).unwrap_or(t.len())
}

/// The length of a list marker and its space at `e`, or `None`.
fn list_marker(t: &[char], e: usize) -> Option<usize> {
    let mut r = e;
    match at(t, r as isize) {
        Some('-' | '*' | '+') => r += 1,
        _ => {
            while at(t, r as isize).is_some_and(|c| c.is_ascii_digit()) && r - e < 9 {
                r += 1;
            }
            if r == e || !matches!(at(t, r as isize), Some('.' | ')')) {
                return None;
            }
            r += 1;
        }
    }
    (at(t, r as isize) == Some(' ')).then_some(r + 1)
}

/// Where a line's content starts past its quote markers and list markers.
fn line_content(t: &[char], e: usize, r: usize) -> (usize, usize, usize) {
    let (mut depth, mut i, mut listed, mut s) = (0, e, false, e);
    loop {
        while s < r && t[s] == ' ' {
            s += 1;
        }
        if at(t, s as isize) == Some('>') {
            depth += 1;
            s += if at(t, s as isize + 1) == Some(' ') { 2 } else { 1 };
            i = s;
            listed = false;
            continue;
        }
        let l = if s < r { list_marker(t, s) } else { None };
        match l {
            None => return (s, if listed { s - i } else { 0 }, depth),
            Some(l) => {
                s = l;
                listed = true;
            }
        }
    }
}

fn skip_quotes(t: &[char], e: usize, r: usize, depth: usize) -> Option<usize> {
    let mut i = e;
    for _ in 0..depth {
        while i < r && t[i] == ' ' {
            i += 1;
        }
        if at(t, i as isize) != Some('>') {
            return None;
        }
        i += 1;
        if at(t, i as isize) == Some(' ') {
            i += 1;
        }
    }
    Some(i)
}

fn fence_content(t: &[char], e: usize, r: usize, f: &Fence) -> Option<usize> {
    let i = skip_quotes(t, e, r, f.quote_depth)?;
    if f.list_indent == 0 {
        return Some(i);
    }
    let mut o = i;
    while o < r && t[o] == ' ' {
        o += 1;
    }
    (o == r || (t.get(o) == Some(&'\r') && o + 1 == r) || o - i >= f.list_indent).then_some(i)
}

fn closes_fence(t: &[char], e: usize, r: usize, f: &Fence) -> bool {
    let mut i = e;
    while i < r && t[i] == ' ' {
        i += 1;
    }
    let mut n = 0;
    while i < r && t[i] == f.ch {
        i += 1;
        n += 1;
    }
    n >= f.len && t[i..r].iter().all(|&c| c == ' ' || c == '\t' || c == '\r')
}

fn opens_fence(t: &[char], regions: &mut [Region], start: usize, end: usize) -> Option<Fence> {
    let i = if end > start && t[end - 1] == '\r' { end - 1 } else { end };
    let (content, list_indent, quote_depth) = line_content(t, start, i);
    let line = &t[content.min(i)..i];
    let ch = *line.first()?;
    if ch != '`' && ch != '~' {
        return None;
    }
    let len = line.iter().take_while(|&&c| c == ch).count();
    if len < 3 {
        return None;
    }
    if ch == '`' && line[len..].contains(&'`') {
        return None;
    }
    let o = content;
    regions[o..o + len].fill(Region::FenceMarker);
    regions[o + len..(end + 1).min(t.len())].fill(Region::FenceInfo);
    Some(Fence { ch, len, list_indent, quote_depth })
}

fn scan_fences(t: &[char], regions: &mut [Region]) -> Option<Fence> {
    let (r, mut open, mut i) = (t.len(), None::<Fence>, 0);
    while i < r {
        let o = line_end(t, i);
        let s = open.as_ref().and_then(|f| fence_content(t, i, o, f));
        if s.is_none() {
            open = None;
        }
        match (&open, s) {
            (Some(f), Some(s)) => {
                if closes_fence(t, s, o, f) {
                    regions[i..o].fill(Region::FenceMarker);
                    open = None;
                } else {
                    regions[i..(o + 1).min(r)].fill(Region::FenceBody);
                }
            }
            _ => open = opens_fence(t, regions, i, o),
        }
        i = o + 1;
    }
    open
}

fn run_end(t: &[char], e: usize) -> usize {
    let mut r = e + 1;
    while r < t.len() && t[r] == '`' {
        r += 1;
    }
    r
}

fn blank_line_follows(t: &[char], e: usize) -> bool {
    let mut r = e + 1;
    while r < t.len() && matches!(t[r], ' ' | '\t' | '\r') {
        r += 1;
    }
    r < t.len() && t[r] == '\n'
}

fn next_backtick(t: &[char], regions: &[Region], from: usize) -> Option<usize> {
    let mut s = from;
    loop {
        let i = index_of(t, '`', s)?;
        let escaped = i > s && t[i - 1] == '\\' && regions[i - 1] == Region::Prose;
        if regions[i] == Region::Prose && !escaped {
            return Some(i);
        }
        s = i + 1;
    }
}

fn scan_spans(t: &[char], regions: &mut [Region]) -> Option<(usize, usize)> {
    let r = t.len();
    let (mut open, mut run, mut o) = (None::<usize>, 0, 0);
    while o < r {
        let Some(start) = open else {
            let Some(b) = next_backtick(t, regions, o) else { break };
            let l = run_end(t, b);
            open = Some(b);
            run = l - b;
            o = l;
            continue;
        };
        if regions[o] != Region::Prose {
            regions[start..o].fill(Region::CodeSpanOpen);
            open = None;
            o += 1;
            continue;
        }
        if t[o] == '\n' && blank_line_follows(t, o) {
            open = None;
            o += 1;
            continue;
        }
        if t[o] != '`' {
            o += 1;
            continue;
        }
        let s = run_end(t, o);
        if s - o == run {
            regions[start..s].fill(Region::CodeSpan);
            open = None;
        }
        o = s;
    }
    let start = open?;
    regions[start..r].fill(Region::CodeSpanOpen);
    Some((start, run))
}

#[derive(Clone, Copy, PartialEq)]
enum Math {
    None,
    InlineLatex,
    BlockLatex,
    InlineDollar,
    BlockDollar,
}

fn math_mask(ctx: &Ctx) -> Vec<bool> {
    let t = ctx.text;
    let mut mask = vec![false; t.len()];
    let (mut state, mut s) = (Math::None, 0);
    while s < t.len() {
        mask[s] = state != Math::None;
        let step = if ctx.regions[s] == Region::Prose { math_step(t, s, state) } else { None };
        let Some((next, len)) = step else {
            s += 1;
            continue;
        };
        state = next;
        if len == 2 && s + 1 < t.len() {
            mask[s + 1] = state != Math::None;
        }
        s += len;
    }
    mask
}

fn math_step(t: &[char], e: usize, state: Math) -> Option<(Math, usize)> {
    let next = at(t, e as isize + 1);
    if t[e] == '\\' {
        if next == Some('$') {
            return Some((state, 2));
        }
        let to = match (next, state) {
            (Some('['), Math::None) => Math::BlockLatex,
            (Some(']'), Math::BlockLatex) => Math::None,
            (Some('('), Math::None) => Math::InlineLatex,
            (Some(')'), Math::InlineLatex) => Math::None,
            _ => return None,
        };
        return Some((to, 2));
    }
    if t[e] == '$' && !matches!(state, Math::InlineLatex | Math::BlockLatex) {
        let double = next == Some('$');
        let to = if double {
            if state == Math::BlockDollar { Math::None } else { Math::BlockDollar }
        } else {
            match state {
                Math::BlockDollar => state,
                Math::InlineDollar => Math::None,
                _ => Math::InlineDollar,
            }
        };
        return Some((to, if double { 2 } else { 1 }));
    }
    None
}

fn link_url_mask(ctx: &Ctx) -> Vec<bool> {
    let t = ctx.text;
    let mut mask = vec![false; t.len()];
    let mut i = 0;
    while i < t.len() {
        let end = line_end(t, i);
        let mut closes_later = vec![false; end - i];
        let mut seen = false;
        for u in (i..end).rev() {
            if t[u] == ')' && ctx.prose(u) {
                seen = true;
            }
            closes_later[u - i] = seen;
        }
        let mut inside = false;
        for u in i..end {
            if inside && closes_later[u - i] {
                mask[u] = true;
            }
            if ctx.prose(u) {
                if t[u] == ')' {
                    inside = false;
                } else if t[u] == '(' {
                    inside = u > 0 && t[u - 1] == ']';
                }
            }
        }
        i = end + 1;
    }
    mask
}

fn html_tag_mask(ctx: &Ctx) -> Vec<bool> {
    let t = ctx.text;
    let mut mask = vec![false; t.len()];
    let mut inside = false;
    for s in 0..t.len() {
        if t[s] == '\n' {
            inside = false;
            continue;
        }
        mask[s] = inside;
        if ctx.prose(s) {
            if t[s] == '>' {
                inside = false;
            } else if t[s] == '<' {
                inside = at(t, s as isize + 1).is_some_and(|c| c.is_ascii_alphabetic() || c == '/');
            }
        }
    }
    mask
}

/// How many times `cc` appears in prose, counted without overlap.
fn count_double(ctx: &Ctx, c: char) -> usize {
    let pat = [c, c];
    let (mut n, mut o) = (0, index_of_seq(ctx.text, &pat, 0));
    while let Some(i) = o {
        let next = if ctx.prose(i) {
            n += 1;
            i + 2
        } else {
            i + 1
        };
        o = index_of_seq(ctx.text, &pat, next);
    }
    n
}

fn is_word(c: Option<char>) -> bool {
    c.is_some_and(|c| c == '_' || c.is_alphanumeric())
}

fn is_space(c: Option<char>) -> bool {
    matches!(c, Some(' ' | '\t' | '\n'))
}

/// `/^[\s_~*`]*$/`: nothing but whitespace and markers.
fn only_markers(s: &[char]) -> bool {
    s.iter().all(|&c| c.is_whitespace() || matches!(c, '_' | '~' | '*' | '`'))
}

/// `/^[\s]*[-*+][\s]+$/`: a list marker and nothing after it.
fn bare_list_marker(s: &[char]) -> bool {
    let i = s.iter().take_while(|c| c.is_whitespace()).count();
    if !matches!(s.get(i), Some('-' | '*' | '+')) {
        return false;
    }
    let rest = &s[i + 1..];
    !rest.is_empty() && rest.iter().all(|c| c.is_whitespace())
}

/// Whether the line holding `e` is a thematic break drawn with `c`.
fn is_rule_line(t: &[char], e: usize, c: char) -> bool {
    let start = t[..e].iter().rposition(|&x| x == '\n').map_or(0, |p| p + 1);
    let end = index_of(t, '\n', e).unwrap_or(t.len());
    let mut n = 0;
    for &x in &t[start..end] {
        if x == c {
            n += 1;
        } else if x != ' ' && x != '\t' {
            return false;
        }
    }
    n >= 3
}

/// remend's trailing-marker lookup: the leftmost place in the text's tail
/// where `marker` opens and `rest` holds to the end. Returns that rest.
fn tail_match<'t>(t: &'t [char], delim: char, marker_len: usize, rest_ok: impl Fn(&[char]) -> bool, marker: &[char]) -> Option<&'t [char]> {
    let from = if t.len() >= 2 { Some(t.len() - 2) } else { None };
    let o = from.and_then(|f| last_index_of_seq(t, &[delim], Some(f))).unwrap_or(t.len().saturating_sub(1));
    let slice = &t[(o + 1).saturating_sub(marker_len)..];
    (0..slice.len()).find_map(|i| {
        let rest = slice.get(i + marker.len()..)?;
        (starts_with(&slice[i..], marker) && rest_ok(rest)).then_some(rest)
    })
}

fn no(c: char) -> impl Fn(&[char]) -> bool {
    move |rest: &[char]| !rest.contains(&c)
}

fn append(t: &[char], s: &str) -> Vec<char> {
    t.iter().copied().chain(s.chars()).collect()
}

// ---------------------------------------------------------------------------
// The handlers, in remend's priority order.

/// `20~25` is a range, not the start of a strikethrough.
fn single_tilde(t: &[char]) -> Vec<char> {
    if !t.contains(&'~') {
        return t.to_vec();
    }
    let ctx = Ctx::new(t);
    let mut out = Vec::with_capacity(t.len() + 2);
    let mut i = 0;
    while i < t.len() {
        if i + 2 < t.len() + 1
            && is_word(Some(t[i]))
            && at(t, i as isize + 1) == Some('~')
            && at(t, i as isize + 2) != Some('~')
            && is_word(at(t, i as isize + 2))
        {
            out.push(t[i]);
            if !ctx.in_code(i as isize + 1) {
                out.push('\\');
            }
            out.push('~');
            i += 2;
            continue;
        }
        out.push(t[i]);
        i += 1;
    }
    out
}

/// `- > 25` is a comparison in a list item, not a quote inside it.
fn comparison_operators(t: &[char]) -> Vec<char> {
    if !t.contains(&'>') {
        return t.to_vec();
    }
    let ctx = Ctx::new(t);
    let mut inserts = Vec::new();
    let mut p = 0;
    while p < t.len() {
        if p == 0 || matches!(t[p - 1], '\n' | '\r') {
            if let Some((gt, end)) = comparison_at(t, p) {
                if !ctx.in_code(p as isize) {
                    inserts.push(gt);
                }
                p = end;
                continue;
            }
        }
        p += 1;
    }
    let mut out = t.to_vec();
    for gt in inserts.into_iter().rev() {
        out.insert(gt, '\\');
    }
    out
}

/// `^(\s*(?:[-*+]|\d+[.)]) +)>(=?\s*[$]?\d)` at `p`: the `>` and the match end.
fn comparison_at(t: &[char], p: usize) -> Option<(usize, usize)> {
    let mut j = p;
    while j < t.len() && t[j].is_whitespace() {
        j += 1;
    }
    match t.get(j)? {
        '-' | '*' | '+' => j += 1,
        c if c.is_ascii_digit() => {
            while t.get(j).is_some_and(|c| c.is_ascii_digit()) {
                j += 1;
            }
            if !matches!(t.get(j)?, '.' | ')') {
                return None;
            }
            j += 1;
        }
        _ => return None,
    }
    let spaces = t[j..].iter().take_while(|&&c| c == ' ').count();
    if spaces == 0 {
        return None;
    }
    j += spaces;
    if t.get(j) != Some(&'>') {
        return None;
    }
    let gt = j;
    j += 1;
    let try_from = |mut k: usize| -> Option<usize> {
        while t.get(k).is_some_and(|c| c.is_whitespace()) {
            k += 1;
        }
        if t.get(k) == Some(&'$') {
            k += 1;
        }
        t.get(k).is_some_and(|c| c.is_ascii_digit()).then_some(k + 1)
    };
    let end = if t.get(j) == Some(&'=') { try_from(j + 1).or_else(|| try_from(j)) } else { try_from(j) }?;
    Some((gt, end))
}

/// A tag still being typed (`text <div cla`) is dropped until it closes.
fn html_tags(t: &[char]) -> Vec<char> {
    // `/<[a-zA-Z/][^>]*$/`: the leftmost such `<` with no `>` after it.
    let Some(first) = (0..t.len()).find(|&i| {
        t[i] == '<' && at(t, i as isize + 1).is_some_and(|c| c.is_ascii_alphabetic() || c == '/') && !t[i + 1..].contains(&'>')
    }) else {
        return t.to_vec();
    };
    let ctx = Ctx::new(t);
    let math = t.contains(&'$') || contains(t, &['\\', '(']) || contains(t, &['\\', '[']);
    for i in first..t.len() {
        if t[i] != '<' || !at(t, i as isize + 1).is_some_and(|c| c.is_ascii_alphabetic() || c == '/') {
            continue;
        }
        if ctx.in_code(i as isize) || (math && ctx.in_math(i)) {
            continue;
        }
        let mut out = t[..i].to_vec();
        while out.last().is_some_and(|c| c.is_whitespace()) {
            out.pop();
        }
        return out;
    }
    t.to_vec()
}

/// A lone `-` or `=` under a line would make it a setext heading for a frame;
/// a zero-width space keeps it a paragraph until the line says otherwise.
///
/// Not inside an open fence, where remend adds one too: there it lands in the
/// code, and the copy control would hand the reader a character nobody wrote.
/// The one deliberate departure from remend.
fn setext_headings(t: &[char]) -> Vec<char> {
    let Some(nl) = t.iter().rposition(|&c| c == '\n') else { return t.to_vec() };
    if Ctx::new(t).open_fence {
        return t.to_vec();
    }
    let (before, last) = (&t[..nl], &t[nl + 1..]);
    let trimmed: Vec<char> = {
        let s: String = last.iter().collect();
        s.trim().chars().collect()
    };
    let prev_line_has_text = || {
        let start = before.iter().rposition(|&c| c == '\n').map_or(0, |p| p + 1);
        before[start..].iter().any(|c| !c.is_whitespace())
    };
    for c in ['-', '='] {
        let short = (1..=2).contains(&trimmed.len()) && trimmed.iter().all(|&x| x == c);
        // `/^[\s]*-{1,2}[\s]+$/`: the marker followed by whitespace is a list
        // item or nothing, not an underline.
        let lead = last.iter().take_while(|c| c.is_whitespace()).count();
        let run = last[lead..].iter().take_while(|&&x| x == c).count();
        let tail = &last[lead + run..];
        let spaced = (1..=2).contains(&run) && !tail.is_empty() && tail.iter().all(|c| c.is_whitespace());
        if short && !spaced && prev_line_has_text() {
            return append(t, "\u{200B}");
        }
    }
    t.to_vec()
}

fn matching_open_bracket(t: &[char], e: usize) -> Option<usize> {
    let mut depth = 1;
    for i in (0..e).rev() {
        if t[i] == ']' {
            depth += 1;
        } else if t[i] == '[' {
            depth -= 1;
            if depth == 0 {
                return Some(i);
            }
        }
    }
    None
}

fn matching_close_bracket(t: &[char], e: usize) -> Option<usize> {
    let mut depth = 1;
    for (i, &c) in t.iter().enumerate().skip(e + 1) {
        if c == '[' {
            depth += 1;
        } else if c == ']' {
            depth -= 1;
            if depth == 0 {
                return Some(i);
            }
        }
    }
    None
}

fn links(t: &[char]) -> Vec<char> {
    let mut r = t.to_vec();
    for _ in 0..32 {
        let next = link_pass(&r);
        if next.len() >= r.len() {
            return next;
        }
        r = next;
    }
    r
}

fn link_pass(t: &[char]) -> Vec<char> {
    let ctx = Ctx::new(t);
    if let Some(r) = last_index_of_seq(t, &[']', '('], None)
        && !ctx.in_code(r as isize)
        && let Some(out) = incomplete_url(&ctx, r)
    {
        return out;
    }
    let mut cursor = t.iter().rposition(|&c| c == '[');
    while let Some(i) = cursor {
        if !ctx.in_code(i as isize)
            && let Some(out) = incomplete_label(t, i)
        {
            return out;
        }
        cursor = if i == 0 { None } else { t[..i].iter().rposition(|&c| c == '[') };
    }
    t.to_vec()
}

/// `[label](partial`: the href is replaced by the placeholder.
fn incomplete_url(ctx: &Ctx, e: usize) -> Option<Vec<char>> {
    let t = ctx.text;
    if t[e + 2..].contains(&')') {
        return None;
    }
    let i = matching_open_bracket(t, e)?;
    if ctx.in_code(i as isize) {
        return None;
    }
    let image = i > 0 && t[i - 1] == '!';
    let s = if image { i - 1 } else { i };
    let label: String = t[i + 1..e].iter().collect();
    let head: String = t[..s].iter().collect();
    let out = if image { format!("{head}![{label}]({INCOMPLETE_IMAGE})") } else { format!("{head}[{label}]({INCOMPLETE_LINK})") };
    Some(out.chars().collect())
}

/// `[label` with no `]` yet.
fn incomplete_label(t: &[char], e: usize) -> Option<Vec<char>> {
    let image = e > 0 && t[e - 1] == '!';
    let i = if image { e - 1 } else { e };
    if t[e + 1..].contains(&']') && matching_close_bracket(t, e).is_some() {
        return None;
    }
    if image {
        let head: String = t[..i].iter().collect();
        let label: String = t[e + 1..].iter().collect();
        return Some(format!("{head}![{label}]({INCOMPLETE_IMAGE})").chars().collect());
    }
    Some(append(t, &format!("]({INCOMPLETE_LINK})")))
}

/// remend's single-`*` count, skipping escapes, `**` pairs and lone stars.
fn count_single_asterisks(ctx: &Ctx) -> usize {
    let t = ctx.text;
    let (mut n, mut chain) = (0, false);
    for o in 0..t.len() {
        if t[o] != '*' || !ctx.prose(o) {
            if !is_word(Some(t[o])) {
                chain = false;
            }
            continue;
        }
        let prev = at(t, o as isize - 1);
        let next = at(t, o as isize + 1);
        let skip = if prev == Some('\\') || ctx.in_math(o) {
            true
        } else if prev != Some('*') && next == Some('*') {
            at(t, o as isize + 2) != Some('*')
        } else {
            prev == Some('*') || ((prev.is_none() || is_space(prev)) && (next.is_none() || is_space(next)))
        };
        if skip {
            continue;
        }
        let intraword = is_word(prev) && is_word(next);
        let opens = next.is_some() && !is_space(next);
        let closes = prev.is_some() && !is_space(prev);
        if intraword && n % 2 == 0 && !chain {
            continue;
        }
        if (closes && n % 2 == 1) || opens {
            n += 1;
            chain = intraword;
        }
    }
    n
}

fn count_triple_asterisks(ctx: &Ctx) -> usize {
    let (mut n, mut run) = (0, 0);
    for (i, &c) in ctx.text.iter().enumerate() {
        if c == '*' && ctx.prose(i) {
            run += 1;
        } else {
            n += run / 3;
            run = 0;
        }
    }
    n + run / 3
}

fn bold_italic(t: &[char]) -> Vec<char> {
    if t.len() >= 4 && t.iter().all(|&c| c == '*') {
        return t.to_vec();
    }
    let Some(rest) = tail_match(t, '*', 3, no('*'), &['*', '*', '*']) else { return t.to_vec() };
    let ctx = Ctx::new(t);
    let pos = last_index_of_seq(t, &['*', '*', '*'], None).map_or(-1, |p| p as isize);
    let settled = rest.is_empty()
        || only_markers(rest)
        || ctx.in_code(pos)
        || ctx.in_span(pos)
        || is_rule_line(t, pos.max(0) as usize, '*');
    if settled || count_triple_asterisks(&ctx) % 2 == 0 {
        return t.to_vec();
    }
    if count_double(&ctx, '*') % 2 == 0 && count_single_asterisks(&ctx) % 2 == 0 {
        return t.to_vec();
    }
    append(t, "***")
}

/// Whether a trailing opener is not one: nothing after it, a list marker
/// whose item has moved on, or a thematic break.
fn opener_settled(t: &[char], rest: &[char], pos: usize, c: char) -> bool {
    if rest.is_empty() || only_markers(rest) {
        return true;
    }
    let start = t[..pos].iter().rposition(|&x| x == '\n').map_or(0, |p| p + 1);
    if bare_list_marker(&t[start..pos]) && rest.contains(&'\n') {
        return true;
    }
    is_rule_line(t, pos, c)
}

fn bold(t: &[char]) -> Vec<char> {
    let rest_ok = |rest: &[char]| {
        let n = rest.len();
        n == 0 || !rest[..n - 1].contains(&'*')
    };
    let Some(rest) = tail_match(t, '*', 2, rest_ok, &['*', '*']) else { return t.to_vec() };
    let ctx = Ctx::new(t);
    let pos = last_index_of_seq(t, &['*', '*'], None).map_or(-1, |p| p as isize);
    if ctx.in_code(pos) || ctx.in_span(pos) || opener_settled(t, rest, pos.max(0) as usize, '*') {
        return t.to_vec();
    }
    if count_double(&ctx, '*') % 2 == 1 {
        return append(t, if rest.last() == Some(&'*') { "*" } else { "**" });
    }
    t.to_vec()
}

/// Whether the `__` runs in prose leave one open.
fn double_underscore_open(ctx: &Ctx) -> bool {
    let t = ctx.text;
    let (mut open, mut o) = (false, 0);
    let mut rule_cache: (isize, bool) = (-1, false);
    while o < t.len() {
        if t[o] != '_' || !ctx.prose(o) {
            o += 1;
            continue;
        }
        let s = o;
        let mut l = o + 1;
        while l < t.len() && t[l] == '_' && ctx.prose(l) {
            l += 1;
        }
        o = l;
        if double_underscore_counts(ctx, s, l, &mut rule_cache) {
            open = !open;
        }
    }
    open
}

fn double_underscore_counts(ctx: &Ctx, e: usize, r: usize, rule_cache: &mut (isize, bool)) -> bool {
    let t = ctx.text;
    let (mut o, mut escaped) = (e, false);
    if o > 0 && t[o - 1] == '\\' {
        o += 1;
        escaped = true;
    }
    let len = r as isize - o as isize;
    if len < 2 {
        return false;
    }
    let prev = if o > 0 { at(t, o as isize - 1) } else { None };
    let before = if escaped { Some('\\') } else { prev };
    let after = at(t, r as isize);
    if is_word(before) && is_word(after) {
        return false;
    }
    let edge = |c: Option<char>| c.is_none() || is_space(c);
    if edge(before) && edge(after) {
        if o as isize > rule_cache.0 {
            rule_cache.0 = line_end(t, o) as isize;
            rule_cache.1 = is_rule_line(t, o, '_');
        }
        if rule_cache.1 {
            return false;
        }
    }
    if ctx.in_math(o) || ctx.in_link_url(o) || ctx.in_html_tag(o) {
        return false;
    }
    (len / 2) % 2 == 1
}

fn italic_double_underscore(t: &[char]) -> Vec<char> {
    let Some(rest) = tail_match(t, '_', 2, no('_'), &['_', '_']) else {
        let rest_ok = |rest: &[char]| rest.len() >= 2 && rest[rest.len() - 1] == '_' && !rest[..rest.len() - 1].contains(&'_');
        if tail_match(t, '_', 2, rest_ok, &['_', '_']).is_some() {
            let ctx = Ctx::new(t);
            let pos = last_index_of_seq(t, &['_', '_'], None).map_or(-1, |p| p as isize);
            if !(ctx.in_code(pos) || ctx.in_span(pos)) && double_underscore_open(&ctx) {
                return append(t, "_");
            }
        }
        return t.to_vec();
    };
    let ctx = Ctx::new(t);
    let pos = last_index_of_seq(t, &['_', '_'], None).map_or(-1, |p| p as isize);
    if ctx.in_code(pos) || ctx.in_span(pos) || opener_settled(t, rest, pos.max(0) as usize, '_') {
        return t.to_vec();
    }
    if double_underscore_open(&ctx) { append(t, "__") } else { t.to_vec() }
}

/// The first lone `*` that could open emphasis.
fn first_single_asterisk(ctx: &Ctx) -> Option<usize> {
    let t = ctx.text;
    (0..t.len()).find(|&r| {
        let p = at(t, r as isize - 1);
        let n = at(t, r as isize + 1);
        let lone = t[r] == '*' && ctx.prose(r) && p != Some('*') && n != Some('*') && p != Some('\\') && !ctx.in_math(r);
        if !lone {
            return false;
        }
        let before_space = p.is_none() || is_space(p);
        let after_space = n.is_none() || is_space(n);
        !(before_space && after_space) && !(is_word(p) && is_word(n)) && !after_space
    })
}

fn italic_single_asterisk(t: &[char]) -> Vec<char> {
    if tail_match(t, '*', 1, no('*'), &['*']).is_none() {
        return t.to_vec();
    }
    let ctx = Ctx::new(t);
    let Some(r) = first_single_asterisk(&ctx) else { return t.to_vec() };
    if ctx.in_code(r as isize) || ctx.in_span(r as isize) {
        return t.to_vec();
    }
    let rest = &t[r + 1..];
    if rest.is_empty() || only_markers(rest) {
        return t.to_vec();
    }
    if count_single_asterisks(&ctx) % 2 == 1 { append(t, "*") } else { t.to_vec() }
}

fn first_single_underscore(ctx: &Ctx) -> Option<usize> {
    let t = ctx.text;
    (0..t.len()).find(|&r| {
        let p = at(t, r as isize - 1);
        let n = at(t, r as isize + 1);
        t[r] == '_'
            && ctx.prose(r)
            && p != Some('_')
            && n != Some('_')
            && p != Some('\\')
            && !ctx.in_math(r)
            && !ctx.in_link_url(r)
            && !(is_word(p) && is_word(n))
    })
}

fn count_single_underscores(ctx: &Ctx) -> usize {
    let t = ctx.text;
    (0..t.len())
        .filter(|&i| {
            if t[i] != '_' || !ctx.prose(i) {
                return false;
            }
            let p = at(t, i as isize - 1);
            let n = at(t, i as isize + 1);
            let skip = p == Some('\\')
                || ctx.in_math(i)
                || ctx.in_link_url(i)
                || ctx.in_html_tag(i)
                || p == Some('_')
                || n == Some('_')
                || (is_word(p) && is_word(n));
            !skip
        })
        .count()
}

fn italic_single_underscore(t: &[char]) -> Vec<char> {
    if tail_match(t, '_', 1, no('_'), &['_']).is_none() {
        return t.to_vec();
    }
    let ctx = Ctx::new(t);
    let Some(r) = first_single_underscore(&ctx) else { return t.to_vec() };
    let rest = &t[r + 1..];
    if rest.is_empty() || only_markers(rest) || ctx.in_code(r as isize) || ctx.in_span(r as isize) {
        return t.to_vec();
    }
    if count_single_underscores(&ctx) % 2 == 0 {
        return t.to_vec();
    }
    // `**_text**`: the underscore closes inside the bold, not after it.
    if ends_with(t, "**") {
        let e = &t[..t.len() - 2];
        let inner = Ctx::new(e);
        if count_double(&inner, '*') % 2 == 1
            && let (Some(b), Some(u)) = (index_of_seq(e, &['*', '*'], 0), first_single_underscore(&inner))
            && b < u
        {
            return append(e, "_**");
        }
    }
    // Before any trailing newlines, so the closer stays on its line.
    let end = t.len() - t.iter().rev().take_while(|&&c| c == '\n').count();
    let mut out = t[..end].to_vec();
    out.push('_');
    out.extend_from_slice(&t[end..]);
    out
}

fn inline_code(t: &[char]) -> Vec<char> {
    let ctx = Ctx::new(t);
    if ctx.open_fence {
        return t.to_vec();
    }
    let Some((start, run)) = ctx.open_span else { return t.to_vec() };
    let rest = &t[start + run..];
    if rest.is_empty() || only_markers(rest) {
        return t.to_vec();
    }
    let trailing = t.iter().rev().take_while(|&&c| c == '`').count();
    if trailing >= run {
        return t.to_vec();
    }
    append(t, &"`".repeat(run - trailing))
}

fn strikethrough(t: &[char]) -> Vec<char> {
    if let Some(rest) = tail_match(t, '~', 2, no('~'), &['~', '~']) {
        if rest.is_empty() || only_markers(rest) {
            return t.to_vec();
        }
        let ctx = Ctx::new(t);
        let pos = last_index_of_seq(t, &['~', '~'], None).map_or(-1, |p| p as isize);
        if ctx.in_code(pos) || ctx.in_span(pos) {
            return t.to_vec();
        }
        if count_double(&ctx, '~') % 2 == 1 {
            return append(t, "~~");
        }
        return t.to_vec();
    }
    let rest_ok = |rest: &[char]| rest.len() >= 2 && rest[rest.len() - 1] == '~' && !rest[..rest.len() - 1].contains(&'~');
    if tail_match(t, '~', 2, rest_ok, &['~', '~']).is_some() {
        let ctx = Ctx::new(t);
        let pos = last_index_of_seq(t, &['~', '~'], None).map_or(-1, |p| p as isize);
        if ctx.in_code(pos) || ctx.in_span(pos) {
            return t.to_vec();
        }
        if count_double(&ctx, '~') % 2 == 1 {
            return append(t, "~");
        }
    }
    t.to_vec()
}

fn katex(t: &[char]) -> Vec<char> {
    let ctx = Ctx::new(t);
    if count_double(&ctx, '$') % 2 == 0 {
        return t.to_vec();
    }
    if t.last() == Some(&'$') && !ends_with(t, "$$") {
        return append(t, "$");
    }
    let opens_block = index_of_seq(t, &['$', '$'], 0).is_some_and(|e| index_of(t, '\n', e).is_some());
    if opens_block && t.last() != Some(&'\n') { append(t, "\n$$") } else { append(t, "$$") }
}

#[cfg(test)]
mod tests {
    use super::remend;

    /// remend's own answer for every prefix of `reply.md`, written by
    /// `node gen.mjs` against remend 1.4.0 (see the module docs). A prefix it
    /// leaves alone is absent and must come back unchanged.
    #[test]
    fn matches_remend_on_every_prefix() {
        let source = include_str!("fixtures/reply.md");
        let expected: Vec<(usize, String)> = serde_json::from_str(include_str!("fixtures/reply.remend.json")).unwrap();
        let expected: std::collections::HashMap<usize, String> = expected.into_iter().collect();
        let chars: Vec<char> = source.chars().collect();
        let mut failures = Vec::new();
        for n in 1..=chars.len() {
            let input: String = chars[..n].iter().collect();
            let want = expected.get(&n).cloned().unwrap_or_else(|| input.clone());
            let got = remend(&input);
            if got != want {
                failures.push(format!("prefix {n}: {:?}\n  want {:?}\n  got  {:?}", tail(&input), tail(&want), tail(&got)));
            }
        }
        assert!(failures.is_empty(), "{} of {} prefixes differ:\n{}", failures.len(), chars.len(), failures[..failures.len().min(8)].join("\n"));
    }

    fn tail(s: &str) -> String {
        let c: Vec<char> = s.chars().collect();
        c[c.len().saturating_sub(40)..].iter().collect()
    }

    #[test]
    fn closes_what_is_open() {
        assert_eq!(remend("some **bold"), "some **bold**");
        assert_eq!(remend("some *it"), "some *it*");
        assert_eq!(remend("a `code"), "a `code`");
        assert_eq!(remend("see [the docs](https://dr"), "see [the docs](streamdown:incomplete-link)");
        assert_eq!(remend("~~gone"), "~~gone~~");
        assert_eq!(remend("```rust\nfn a() { **x"), "```rust\nfn a() { **x");
    }

    #[test]
    fn a_dash_line_in_open_code_stays_code() {
        assert_eq!(remend("```\nlet a = 1;\n--"), "```\nlet a = 1;\n--");
        // Outside code it is still held off becoming an underline.
        assert_eq!(remend("text\n--"), "text\n--\u{200B}");
    }
}
