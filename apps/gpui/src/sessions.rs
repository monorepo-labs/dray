//! The sidebar's order, ported from `sessionRows` and `sessionGroups` in
//! apps/desktop/src/components/Sidebar.tsx, with the tests that pin them
//! (lib/sessionOrder.test.ts). The reasoning lives there; this is the same
//! rules in Rust and should change only when they do.
//!
//! Not yet here: split groups (no split view in milestone 1) and the PR stages,
//! which read the sidebar's PR marks and arrive with them.

use std::collections::{HashMap, HashSet};

use dray_core::store::{SessionIndexItem, SessionStatus};

/// One drawn row: the session, how deep it sits, and the flags its rails are
/// drawn from. See `SessionListRow`.
#[derive(Clone, Debug)]
pub struct ListRow<'a> {
    pub item: &'a SessionIndexItem,
    pub depth: usize,
    /// One per level above this row: whether that level's rail carries on.
    pub guides: Vec<bool>,
    /// This row opens a rail for the rows under it.
    pub opens: bool,
}

/// What a run of rows is waiting on, strongest first — the order runs draw in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Stage {
    Asking,
    Completed,
    Idle,
    Aside,
}

#[derive(Clone, Debug)]
pub enum Group<'a> {
    Pinned(Vec<ListRow<'a>>),
    Stage(Stage, Vec<ListRow<'a>>),
}

impl<'a> Group<'a> {
    pub fn rows(&self) -> &[ListRow<'a>] {
        match self {
            Group::Pinned(rows) | Group::Stage(_, rows) => rows,
        }
    }
}

/// What the app has heard about every session this run. Live status wins over
/// the item's own field, which carries a `completed` across a restart.
#[derive(Default)]
pub struct Live {
    pub status: HashMap<String, SessionStatus>,
    pub asking: HashSet<String>,
}

/// Three untouched days set a session aside without being asked.
const ASIDE_AFTER_MS: i64 = 3 * 24 * 60 * 60 * 1000;

/// How many rows a list needs before it is split into stages at all.
const STATE_SPLIT_MIN: usize = 3;

/// Stages whose single-row runs share one break.
const SHARED_BREAKS: &[&[Stage]] = &[&[Stage::Asking, Stage::Completed]];

/// `Date.parse` for the index's RFC3339 stamps; an unreadable one sorts last.
pub fn millis(iso: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(iso).map(|t| t.timestamp_millis()).unwrap_or(i64::MIN)
}

/// The list in drawn order, each spawned session directly under its parent.
pub fn session_rows<'a>(items: &[&'a SessionIndexItem]) -> Vec<ListRow<'a>> {
    let by_recency = |a: &&SessionIndexItem, b: &&SessionIndexItem| millis(&b.modified).cmp(&millis(&a.modified));
    let present: HashSet<&str> = items.iter().map(|i| i.session_id.as_str()).collect();
    fn parent_in<'i>(i: &'i SessionIndexItem, present: &HashSet<&str>) -> Option<&'i str> {
        i.parent_session_id.as_deref().filter(|p| present.contains(p))
    }
    let parent_of = |i: &'a SessionIndexItem| parent_in(i, &present);
    let mut children: HashMap<&str, Vec<&'a SessionIndexItem>> = HashMap::new();
    for item in items {
        if let Some(parent) = parent_of(item) {
            children.entry(parent).or_default().push(item);
        }
    }

    struct Walk<'a, 'b> {
        rows: Vec<ListRow<'a>>,
        seen: HashSet<&'a str>,
        children: &'b HashMap<&'b str, Vec<&'a SessionIndexItem>>,
    }
    fn walk<'a>(w: &mut Walk<'a, '_>, item: &'a SessionIndexItem, depth: usize, guides: Vec<bool>) {
        if !w.seen.insert(item.session_id.as_str()) {
            return;
        }
        let at = w.rows.len();
        w.rows.push(ListRow { item, depth, guides: guides.clone(), opens: false });
        let mut kids: Vec<&'a SessionIndexItem> = w
            .children
            .get(item.session_id.as_str())
            .map(|k| k.iter().copied().filter(|c| !w.seen.contains(c.session_id.as_str())).collect())
            .unwrap_or_default();
        kids.sort_by(|a, b| millis(&b.modified).cmp(&millis(&a.modified)));
        let before = w.rows.len();
        let last = kids.len().saturating_sub(1);
        for (i, child) in kids.into_iter().enumerate() {
            let mut g = guides.clone();
            g.push(i < last);
            walk(w, child, depth + 1, g);
        }
        w.rows[at].opens = w.rows.len() > before;
    }

    let mut w = Walk { rows: Vec::new(), seen: HashSet::new(), children: &children };
    let mut roots: Vec<&'a SessionIndexItem> = items.iter().copied().filter(|i| parent_of(i).is_none()).collect();
    roots.sort_by(by_recency);
    for root in roots {
        walk(&mut w, root, 0, Vec::new());
    }
    // A cycle reaches no root; its rows are appended rather than lost.
    let mut stranded = items.to_vec();
    stranded.sort_by(by_recency);
    for item in stranded {
        walk(&mut w, item, 0, Vec::new());
    }
    w.rows
}

/// Pinned-side when it or an ancestor is pinned, unless set aside.
fn split_pinned<'a>(items: &[&'a SessionIndexItem]) -> (Vec<&'a SessionIndexItem>, Vec<&'a SessionIndexItem>) {
    let by_id: HashMap<&str, &SessionIndexItem> = items.iter().map(|i| (i.session_id.as_str(), *i)).collect();
    let under_pin = |item: &SessionIndexItem| {
        if item.aside {
            return false;
        }
        let mut seen = HashSet::new();
        let mut at = Some(item);
        while let Some(i) = at {
            if !seen.insert(i.session_id.as_str()) {
                break;
            }
            if i.pinned {
                return true;
            }
            at = i.parent_session_id.as_deref().and_then(|p| by_id.get(p).copied());
        }
        false
    };
    items.iter().partition(|i| under_pin(i))
}

/// Set aside by the reader, or stale with nothing below it still moving.
fn split_aside<'a>(items: &[&'a SessionIndexItem], now: i64) -> (Vec<&'a SessionIndexItem>, Vec<&'a SessionIndexItem>) {
    let mut kids: HashMap<&str, Vec<&SessionIndexItem>> = HashMap::new();
    for item in items {
        if let Some(p) = item.parent_session_id.as_deref() {
            kids.entry(p).or_default().push(item);
        }
    }
    let stale = |i: &SessionIndexItem| now.saturating_sub(millis(&i.modified)) > ASIDE_AFTER_MS;
    fn moving<'a>(
        item: &'a SessionIndexItem,
        kids: &HashMap<&str, Vec<&'a SessionIndexItem>>,
        memo: &mut HashMap<&'a str, bool>,
        stale: &dyn Fn(&SessionIndexItem) -> bool,
    ) -> bool {
        if let Some(&known) = memo.get(item.session_id.as_str()) {
            return known;
        }
        // Seeded false first, so a cycle answers rather than recursing forever.
        memo.insert(&item.session_id, false);
        let v = (!item.aside && !stale(item))
            || kids.get(item.session_id.as_str()).is_some_and(|k| k.iter().any(|c| moving(c, kids, memo, stale)));
        memo.insert(&item.session_id, v);
        v
    }
    let mut memo = HashMap::new();
    let (mut aside, mut rest) = (Vec::new(), Vec::new());
    for item in items {
        if !item.aside && moving(item, &kids, &mut memo, &stale) {
            rest.push(*item);
        } else {
            aside.push(*item);
        }
    }
    (aside, rest)
}

fn stage_of(item: &SessionIndexItem, live: &Live) -> Stage {
    if live.asking.contains(&item.session_id) {
        return Stage::Asking;
    }
    match live.status.get(&item.session_id).copied().unwrap_or(item.status) {
        SessionStatus::Completed => Stage::Completed,
        _ => Stage::Idle,
    }
}

/// The live list: Pinned first, then one run per stage across every project.
pub fn session_groups<'a>(items: &[&'a SessionIndexItem], live: &Live, now: i64) -> Vec<Group<'a>> {
    let (pinned, rest) = split_pinned(items);
    let (aside_items, active_items) = split_aside(&rest, now);

    let nests_of = |list: &[&'a SessionIndexItem]| {
        let mut nests: Vec<Vec<ListRow<'a>>> = Vec::new();
        for row in session_rows(list) {
            if row.depth == 0 || nests.is_empty() {
                nests.push(Vec::new());
            }
            nests.last_mut().unwrap().push(row);
        }
        nests
    };
    // A nest takes the strongest stage anything in it holds.
    let nest_stage = |nest: &[ListRow]| nest.iter().map(|r| stage_of(r.item, live)).min().unwrap_or(Stage::Idle);

    let mut out = Vec::new();
    let pinned_rows = session_rows(&pinned);
    if !pinned_rows.is_empty() {
        out.push(Group::Pinned(pinned_rows));
    }

    let mut by_stage: HashMap<Stage, Vec<ListRow<'a>>> = HashMap::new();
    let held = nests_of(&active_items);
    let flat: Vec<ListRow<'a>> = held.iter().flatten().cloned().collect();
    if flat.len() < STATE_SPLIT_MIN {
        if !flat.is_empty() {
            let stage = nest_stage(&flat);
            by_stage.entry(stage).or_default().extend(flat);
        }
    } else {
        for nest in held {
            let stage = nest_stage(&nest);
            by_stage.entry(stage).or_default().extend(nest);
        }
        for family in SHARED_BREAKS {
            let mut into: Option<Stage> = None;
            for &stage in *family {
                let Some(len) = by_stage.get(&stage).map(Vec::len) else {
                    continue;
                };
                if len > 1 {
                    into = None;
                } else if let Some(target) = into {
                    let rows = by_stage.remove(&stage).unwrap();
                    by_stage.get_mut(&target).unwrap().extend(rows);
                } else {
                    into = Some(stage);
                }
            }
        }
    }
    let aside: Vec<ListRow<'a>> = nests_of(&aside_items).into_iter().flatten().collect();
    if !aside.is_empty() {
        by_stage.entry(Stage::Aside).or_default().extend(aside);
    }
    for stage in [Stage::Asking, Stage::Completed, Stage::Idle, Stage::Aside] {
        if let Some(rows) = by_stage.remove(&stage) {
            out.push(Group::Stage(stage, rows));
        }
    }
    out
}

/// Compact relative time for a row — "now", "4m", "3h", "2d", then a date.
pub fn relative_time(iso: &str, now: i64) -> String {
    let then = millis(iso);
    if then == i64::MIN {
        return String::new();
    }
    let secs = ((now - then) as f64 / 1000.).round() as i64;
    match secs {
        s if s < 60 => "now".into(),
        s if s < 3600 => format!("{}m", s / 60),
        s if s < 86400 => format!("{}h", s / 3600),
        s if s < 604800 => format!("{}d", s / 86400),
        _ => chrono::DateTime::from_timestamp_millis(then)
            .map(|t| t.with_timezone(&chrono::Local).format("%b %-d").to_string())
            .unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const NOW: &str = "2026-11-10T12:00:00Z";

    fn item(id: &str, modified: &str, parent: Option<&str>, project: &str, pinned: bool) -> SessionIndexItem {
        serde_json::from_value(json!({
            "sessionId": id, "harness": "claude_code", "cwd": project, "projectPath": project,
            "branch": id, "worktreeName": null, "title": id, "created": modified,
            "modified": modified, "archived": false, "pinned": pinned, "parentSessionId": parent,
        }))
        .unwrap()
    }

    fn at(minute: u32) -> String {
        format!("2026-11-10T10:{minute:02}:00Z")
    }

    fn s(id: &str, minute: u32) -> SessionIndexItem {
        item(id, &at(minute), None, "/repo", false)
    }

    fn child(id: &str, minute: u32, parent: &str) -> SessionIndexItem {
        item(id, &at(minute), Some(parent), "/repo", false)
    }

    fn pin(id: &str, minute: u32) -> SessionIndexItem {
        item(id, &at(minute), None, "/repo", true)
    }

    fn refs(items: &[SessionIndexItem]) -> Vec<&SessionIndexItem> {
        items.iter().collect()
    }

    fn order(items: &[SessionIndexItem]) -> Vec<String> {
        let live = Live::default();
        session_groups(&refs(items), &live, millis(NOW))
            .iter()
            .flat_map(|g| g.rows().iter().map(|r| r.item.session_id.clone()).collect::<Vec<_>>())
            .collect()
    }

    fn ids(rows: &[ListRow]) -> Vec<String> {
        rows.iter().map(|r| r.item.session_id.clone()).collect()
    }

    // sortSessions

    #[test]
    fn orders_top_level_sessions_newest_first() {
        assert_eq!(order(&[s("a", 1), s("b", 3), s("c", 2)]), ["b", "c", "a"]);
    }

    #[test]
    fn puts_a_spawned_session_directly_under_the_one_that_spawned_it() {
        let items = [s("a", 1), s("b", 5), child("a1", 9, "a")];
        assert_eq!(order(&items), ["b", "a", "a1"]);
    }

    #[test]
    fn keeps_a_child_whose_parent_is_not_on_screen() {
        let items = [s("a", 1), child("orphan", 2, "gone")];
        assert_eq!(order(&items), ["orphan", "a"]);
    }

    #[test]
    fn still_draws_every_row_when_the_index_holds_a_cycle() {
        let items = [child("x", 1, "y"), child("y", 2, "x"), s("z", 3)];
        let mut got = order(&items);
        got.sort();
        assert_eq!(got, ["x", "y", "z"]);
    }

    // sessionRows

    #[test]
    fn draws_a_grandchild_one_step_further_in_than_its_parent() {
        let items = [s("root", 1), child("kid", 2, "root"), child("grandkid", 3, "kid")];
        let rows = session_rows(&refs(&items));
        assert_eq!(ids(&rows), ["root", "kid", "grandkid"]);
        assert_eq!(rows.iter().map(|r| r.depth).collect::<Vec<_>>(), [0, 1, 2]);
    }

    #[test]
    fn keeps_an_ancestors_rail_open_past_its_later_descendants() {
        let items = [s("root", 1), child("k1", 5, "root"), child("g", 6, "k1"), child("k2", 2, "root")];
        let rows = session_rows(&refs(&items));
        assert_eq!(ids(&rows), ["root", "k1", "g", "k2"]);
        assert_eq!(rows[2].guides, [true, false]);
        assert_eq!(rows[3].guides, [false]);
    }

    #[test]
    fn opens_no_rail_on_a_row_with_nothing_drawn_under_it() {
        let items = [s("root", 1), child("kid", 2, "root")];
        let rows = session_rows(&refs(&items));
        assert!(rows[0].opens);
        assert!(!rows[1].opens);
    }

    // sessionGroups

    #[test]
    fn leads_with_the_pinned_group() {
        let items = [s("a", 9), pin("p", 1)];
        let groups = session_groups(&refs(&items), &Live::default(), millis(NOW));
        assert!(matches!(&groups[0], Group::Pinned(rows) if ids(rows) == ["p"]));
        assert_eq!(order(&items), ["p", "a"]);
    }

    #[test]
    fn takes_a_pinned_sessions_children_with_it() {
        let items = [pin("p", 1), child("k", 2, "p"), s("a", 9)];
        assert_eq!(order(&items), ["p", "k", "a"]);
    }

    #[test]
    fn opens_no_pinned_group_when_nothing_is_pinned() {
        let items = [s("a", 1)];
        let groups = session_groups(&refs(&items), &Live::default(), millis(NOW));
        assert!(groups.iter().all(|g| !matches!(g, Group::Pinned(_))));
    }

    fn stages(items: &[SessionIndexItem], live: &Live) -> Vec<(Stage, Vec<String>)> {
        session_groups(&refs(items), live, millis(NOW))
            .into_iter()
            .filter_map(|g| match g {
                Group::Stage(stage, rows) => Some((stage, ids(&rows))),
                Group::Pinned(_) => None,
            })
            .collect()
    }

    #[test]
    fn splits_the_list_into_stages_strongest_first() {
        let items = [s("idle1", 9), s("idle2", 8), s("done1", 7), s("done2", 6), s("ask1", 1), s("ask2", 2)];
        let live = Live {
            status: HashMap::from([
                ("done1".into(), SessionStatus::Completed),
                ("done2".into(), SessionStatus::Completed),
            ]),
            asking: HashSet::from(["ask1".into(), "ask2".into()]),
        };
        assert_eq!(
            stages(&items, &live),
            [
                (Stage::Asking, vec!["ask2".into(), "ask1".into()]),
                (Stage::Completed, vec!["done1".into(), "done2".into()]),
                (Stage::Idle, vec!["idle1".into(), "idle2".into()]),
            ]
        );
    }

    #[test]
    fn shares_one_break_where_asking_and_unread_are_a_single_row_each() {
        let items = [s("idle1", 9), s("idle2", 8), s("done", 7), s("ask", 1)];
        let live = Live {
            status: HashMap::from([("done".into(), SessionStatus::Completed)]),
            asking: HashSet::from(["ask".into()]),
        };
        assert_eq!(
            stages(&items, &live),
            [(Stage::Asking, vec!["ask".into(), "done".into()]), (Stage::Idle, vec!["idle1".into(), "idle2".into()]),]
        );
    }

    #[test]
    fn sinks_set_aside_and_stale_rows_to_the_end() {
        let mut aside = s("aside", 9);
        aside.aside = true;
        let stale = item("stale", "2026-11-01T00:00:00Z", None, "/repo", false);
        let items = [aside, stale, s("a", 1), s("b", 2), s("c", 3)];
        let got = stages(&items, &Live::default());
        assert_eq!(got.last().unwrap(), &(Stage::Aside, vec!["aside".into(), "stale".into()]));
    }

    #[test]
    fn carries_a_whole_nest_into_the_strongest_stage_anything_in_it_holds() {
        let items = [s("root", 1), child("kid", 2, "root"), s("x", 8), s("y", 9)];
        let live = Live { asking: HashSet::from(["kid".into()]), ..Live::default() };
        assert_eq!(stages(&items, &live)[0], (Stage::Asking, vec!["root".into(), "kid".into()]));
    }

    #[test]
    fn falls_back_to_the_items_own_status_where_the_live_map_is_empty() {
        let mut done = s("done", 1);
        done.status = SessionStatus::Completed;
        let items = [done, s("a", 2), s("b", 3)];
        assert_eq!(stages(&items, &Live::default())[0], (Stage::Completed, vec!["done".into()]));
    }

    #[test]
    fn leaves_a_list_under_three_rows_as_one_run() {
        let mut done = s("done", 1);
        done.status = SessionStatus::Completed;
        let items = [done, s("a", 2)];
        assert_eq!(stages(&items, &Live::default()), [(Stage::Completed, vec!["a".into(), "done".into()])]);
    }

    #[test]
    fn says_how_long_ago_compactly() {
        let now = millis(NOW);
        assert_eq!(relative_time("2026-11-10T11:59:30Z", now), "now");
        assert_eq!(relative_time("2026-11-10T11:56:00Z", now), "4m");
        assert_eq!(relative_time("2026-11-10T09:00:00Z", now), "3h");
        assert_eq!(relative_time("2026-11-08T12:00:00Z", now), "2d");
        assert_eq!(relative_time("garbage", now), "");
    }
}
