//! A new task's picks — agent, model, effort, project, worktree, stance — and
//! the desktop composer's rules for them, restated as the Mac island and the
//! iOS app restate them (`Picks.swift`): neither side can call the other's.

use serde::Deserialize;
use std::collections::HashMap;

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Project {
    pub path: String,
    pub name: String,
    pub last_selected: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Agent {
    pub harness: String,
    pub available: bool,
    pub label: String,
    pub reason: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Model {
    pub id: String,
    pub label: String,
    pub efforts: Vec<String>,
    pub default_effort: Option<String>,
    /// Off the shortlist by default: a pinned older generation.
    pub secondary: Option<bool>,
}

/// `DEFAULT_MODEL_FOR`. Empty is "let the harness decide".
pub fn default_model(harness: &str) -> &'static str {
    match harness {
        "claude_code" => "opus",
        "codex" => "gpt-6.1-sol",
        "grok" => "grok-4.7",
        _ => "",
    }
}

const DEFAULT_EFFORT: &str = "high";

pub fn effort_label(level: &str) -> &str {
    match level {
        "low" => "Low",
        "medium" => "Medium",
        "high" => "High",
        "xhigh" => "Extra High",
        "max" => "Max",
        "ultra" => "Ultra",
        other => other,
    }
}

pub const STANCES: [(&str, &str); 4] =
    [("bypassPermissions", "Bypass permissions"), ("manual", "Ask every time"), ("plan", "Plan"), ("auto", "Auto")];

/// `HONOURED`: which stances a harness carries out; absent means all.
fn honoured(harness: &str) -> Option<&'static [&'static str]> {
    match harness {
        "codex" => Some(&["bypassPermissions", "manual", "auto"]),
        "pi" => Some(&[]),
        "fx" | "grok" => Some(&["manual", "auto", "bypassPermissions"]),
        _ => None,
    }
}

pub fn honours(harness: &str, mode: &str) -> bool {
    honoured(harness).is_none_or(|list| list.contains(&mode))
}

/// One honoured stance is not a menu, and pi honours none.
pub fn offers_stances(harness: &str) -> bool {
    STANCES.iter().filter(|(m, _)| honours(harness, m)).count() > 1
}

/// `stanceFor`: what the session will actually run, which the index records.
pub fn stance_for(harness: &str, mode: &str) -> String {
    if honours(harness, mode) {
        return mode.into();
    }
    match harness {
        "fx" | "codex" => if mode == "plan" { "manual" } else { "auto" },
        "grok" => if mode == "plan" { "manual" } else { "bypassPermissions" },
        _ => "bypassPermissions",
    }
    .into()
}

/// `usableModel`: a pick the list cannot run falls to the harness's default,
/// never to the head of the list.
pub fn usable_model(models: &[Model], picked: &str, harness: &str) -> String {
    if models.is_empty() || models.iter().any(|m| m.id == picked) {
        return picked.into();
    }
    let fallback = default_model(harness);
    if fallback.is_empty() {
        return String::new();
    }
    if models.iter().any(|m| m.id == fallback) { fallback.into() } else { models[0].id.clone() }
}

/// `usableEffort`: the pick, else the model's default, else the app's, else the top rung.
pub fn usable_effort(model: &Model, remembered: Option<&str>) -> Option<String> {
    if model.efforts.is_empty() {
        return None;
    }
    [remembered, model.default_effort.as_deref(), Some(DEFAULT_EFFORT)]
        .into_iter()
        .flatten()
        .find(|w| model.efforts.iter().any(|e| e == w))
        .map(str::to_string)
        .or_else(|| model.efforts.last().cloned())
}

/// What the bar holds: lists read from the server, picks kept in prefs.
#[derive(Default)]
pub struct Picks {
    pub projects: Vec<Project>,
    pub agents: Vec<Agent>,
    /// Per harness, once read.
    pub models: HashMap<String, Vec<Model>>,
    pub project: Option<String>,
    pub harness: String,
    pub model_picks: HashMap<String, String>,
    pub effort_picks: HashMap<String, String>,
    pub stance: String,
    pub worktree_by_project: HashMap<String, bool>,
}

impl Picks {
    pub fn load() -> Self {
        Self {
            harness: crate::prefs::get("harness").unwrap_or_else(|| "claude_code".into()),
            model_picks: crate::prefs::get("models").unwrap_or_default(),
            effort_picks: crate::prefs::get("efforts").unwrap_or_default(),
            stance: crate::prefs::get("stance").unwrap_or_else(|| "auto".into()),
            worktree_by_project: crate::prefs::get("worktreeByProject").unwrap_or_default(),
            ..Default::default()
        }
    }

    /// Takes fresh lists: the project last picked anywhere wins unless the
    /// one held is still there, and a missing agent gives way to the first
    /// installed one.
    pub fn take(&mut self, projects: Vec<Project>, agents: Vec<Agent>) {
        if !self.project.as_ref().is_some_and(|p| projects.iter().any(|x| &x.path == p)) {
            self.project = projects.iter().max_by(|a, b| a.last_selected.cmp(&b.last_selected)).map(|p| p.path.clone());
        }
        self.projects = projects;
        self.agents = agents;
        if !self.agents.iter().any(|a| a.harness == self.harness && a.available)
            && let Some(first) = self.agents.iter().find(|a| a.available)
        {
            self.harness = first.harness.clone();
        }
    }

    pub fn models(&self) -> &[Model] {
        self.models.get(&self.harness).map(Vec::as_slice).unwrap_or_default()
    }

    pub fn model_id(&self) -> String {
        let picked = self.model_picks.get(&self.harness).map(String::as_str).unwrap_or(default_model(&self.harness));
        usable_model(self.models(), picked, &self.harness)
    }

    pub fn model(&self) -> Option<&Model> {
        let id = self.model_id();
        self.models().iter().find(|m| m.id == id)
    }

    /// The effort a row would run at if picked: the live pick for the model
    /// already chosen, else that model's remembered or default level.
    pub fn effort_of(&self, model: &Model) -> Option<String> {
        usable_effort(model, self.effort_picks.get(&model.id).map(String::as_str))
    }

    pub fn effort(&self) -> Option<String> {
        self.model().and_then(|m| self.effort_of(m))
    }

    /// The desktop's shortlist: every row not marked secondary, and the pick.
    pub fn shortlist(&self) -> Vec<&Model> {
        let id = self.model_id();
        self.models().iter().filter(|m| m.secondary != Some(true) || m.id == id).collect()
    }

    pub fn project_name(&self) -> Option<&str> {
        let path = self.project.as_ref()?;
        self.projects.iter().find(|p| &p.path == path).map(|p| p.name.as_str())
    }

    /// A project never toggled takes a worktree, as the desktop's does.
    pub fn worktree(&self) -> bool {
        self.project.as_ref().and_then(|p| self.worktree_by_project.get(p)).copied().unwrap_or(true)
    }

    pub fn stance(&self) -> String {
        stance_for(&self.harness, &self.stance)
    }

    pub fn pick_harness(&mut self, harness: &str) {
        self.harness = harness.into();
        crate::prefs::set("harness", &self.harness);
    }

    pub fn pick_model(&mut self, id: &str) {
        self.model_picks.insert(self.harness.clone(), id.into());
        crate::prefs::set("models", &self.model_picks);
    }

    pub fn pick_effort(&mut self, model: &str, level: &str) {
        self.effort_picks.insert(model.into(), level.into());
        crate::prefs::set("efforts", &self.effort_picks);
    }

    pub fn pick_stance(&mut self, mode: &str) {
        self.stance = mode.into();
        crate::prefs::set("stance", &self.stance);
    }

    pub fn toggle_worktree(&mut self) {
        let Some(project) = self.project.clone() else { return };
        let on = !self.worktree();
        self.worktree_by_project.insert(project, on);
        crate::prefs::set("worktreeByProject", &self.worktree_by_project);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model(id: &str, efforts: &[&str], default: Option<&str>) -> Model {
        Model {
            id: id.into(),
            label: id.into(),
            efforts: efforts.iter().map(|e| e.to_string()).collect(),
            default_effort: default.map(str::to_string),
            secondary: None,
        }
    }

    #[test]
    fn a_pick_the_list_cannot_run_falls_to_the_default() {
        let list = [model("opus", &[], None), model("sonnet", &[], None)];
        assert_eq!(usable_model(&list, "sonnet", "claude_code"), "sonnet");
        assert_eq!(usable_model(&list, "gone", "claude_code"), "opus");
        assert_eq!(usable_model(&list[1..], "gone", "claude_code"), "sonnet");
        assert_eq!(usable_model(&list, "gone", "pi"), "");
        assert_eq!(usable_model(&[], "anything", "claude_code"), "anything");
    }

    #[test]
    fn effort_falls_back_in_the_desktop_s_order() {
        let m = model("m", &["low", "medium", "high", "max"], Some("medium"));
        assert_eq!(usable_effort(&m, Some("max")).as_deref(), Some("max"));
        assert_eq!(usable_effort(&m, Some("ultra")).as_deref(), Some("medium"));
        let m = model("m", &["low", "high"], None);
        assert_eq!(usable_effort(&m, None).as_deref(), Some("high"));
        let m = model("m", &["low", "medium"], None);
        assert_eq!(usable_effort(&m, None).as_deref(), Some("medium"));
        assert_eq!(usable_effort(&model("m", &[], None), None), None);
    }

    #[test]
    fn a_stance_a_harness_cannot_carry_out_is_mapped() {
        assert_eq!(stance_for("claude_code", "plan"), "plan");
        assert_eq!(stance_for("codex", "plan"), "manual");
        assert_eq!(stance_for("grok", "plan"), "manual");
        assert_eq!(stance_for("pi", "auto"), "bypassPermissions");
        assert!(offers_stances("claude_code"));
        assert!(!offers_stances("pi"));
    }

    #[test]
    fn fresh_lists_keep_the_project_held_and_an_installed_agent() {
        let mut picks = Picks { harness: "codex".into(), ..Default::default() };
        let projects = vec![
            Project { path: "/a".into(), name: "a".into(), last_selected: "2026-01-01".into() },
            Project { path: "/b".into(), name: "b".into(), last_selected: "2026-02-01".into() },
        ];
        let agents = vec![
            Agent { harness: "claude_code".into(), available: true, ..Default::default() },
            Agent { harness: "codex".into(), available: false, ..Default::default() },
        ];
        picks.take(projects.clone(), agents.clone());
        assert_eq!(picks.project.as_deref(), Some("/b"));
        assert_eq!(picks.harness, "claude_code");
        picks.project = Some("/a".into());
        picks.take(projects, agents);
        assert_eq!(picks.project.as_deref(), Some("/a"));
    }
}
