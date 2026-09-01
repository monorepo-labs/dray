//! The models Dray offers, and which one it points a new reader at.
//!
//! A fixed list compiled into the binary rather than a manifest fetched at
//! runtime: the set changes about as often as a release does, and a remote
//! catalog is a network dependency on a screen whose whole point is that the
//! feature works offline once a model is down.
//!
//! Weights come from Hugging Face rather than `blob.handy.computer`, which is
//! the CDN [Handy](https://github.com/cjpais/Handy) publishes them through. The
//! files are the same — these are the `handy-computer` org's own repos — but
//! leaning on someone else's bandwidth for every Dray install is not ours to
//! spend. Pinned to a revision, so the URL keeps naming the bytes `sha256`
//! describes even if the repo moves on.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// One downloadable model.
///
/// `sha256` and `size_bytes` describe the *file*, not the repo, which is what
/// makes a half-finished download recoverable: a file on disk at the right size
/// and hash is complete whatever happened to the process that wrote it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionModel {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    /// Hugging Face repo the file lives in.
    pub repo: &'static str,
    /// Pinned commit, so the URL cannot drift onto different bytes.
    pub revision: &'static str,
    pub filename: &'static str,
    pub size_bytes: u64,
    pub sha256: &'static str,
    /// What it transcribes, ready to draw.
    ///
    /// A phrase rather than a count, because the two useful answers have
    /// different shapes: a handful of languages is worth *naming* — "4
    /// languages" tells a French speaker nothing about whether this model is
    /// for them — while ninety-nine is only ever a number. The catalog is a
    /// fixed compiled-in list, so spelling it here costs nothing and keeps the
    /// judgement beside the data it describes.
    pub languages: &'static str,
}

impl TranscriptionModel {
    /// Where the weights land once downloaded, under the models directory.
    ///
    /// Named for the model rather than the file so two models can never share a
    /// name, and flat rather than nested per repo — the whole directory is then
    /// one `read_dir` to answer "what is installed".
    pub fn file_name(&self) -> String {
        format!("{}.gguf", self.id)
    }

    /// Hugging Face's raw-file URL. `resolve/<revision>` rather than
    /// `resolve/main`, so the pinned commit is what actually gets fetched.
    pub fn url(&self) -> String {
        format!(
            "https://huggingface.co/{}/resolve/{}/{}",
            self.repo, self.revision, self.filename
        )
    }
}

/// Every model on offer, in the order the settings tab draws them.
///
/// Ordered smallest-commitment first within each tier rather than by accuracy:
/// the reader is choosing what to spend several hundred megabytes on, and the
/// list is short enough that ranking by quality would just restate the sizes.
pub const MODELS: &[TranscriptionModel] = &[
    TranscriptionModel {
        id: "parakeet-unified-en-0.6b",
        name: "Parakeet Unified EN 0.6B",
        description: "Fast and accurate English. The best pick on Apple Silicon.",
        repo: "handy-computer/parakeet-unified-en-0.6b-gguf",
        revision: "7e948f21b7bdbac698d3318db9d350f1096f3b6c",
        filename: "parakeet-unified-en-0.6b-Q8_0.gguf",
        size_bytes: 731_357_568,
        sha256: "4b50b6dd862bf6e346929aaf4f5eaacec003bfa3f56462d6c874b41ef2f38795",
        languages: "English",
    },
    TranscriptionModel {
        id: "canary-180m-flash",
        name: "Canary 180M Flash",
        description: "Tiny and instant. Runs well on any hardware.",
        repo: "handy-computer/canary-180m-flash-gguf",
        revision: "b147f9dc52b59f0998e410540a84727bd86457fd",
        filename: "canary-180m-flash-Q8_0.gguf",
        size_bytes: 218_447_552,
        sha256: "e13c7f5d0952b056a027cfffec13e3a3a134d1608babed24f983568f141e297c",
        languages: "English, German, Spanish, French",
    },
    TranscriptionModel {
        id: "whisper-small",
        name: "Whisper Small",
        description: "Broad language coverage, with automatic detection.",
        repo: "handy-computer/whisper-small-gguf",
        revision: "c0214bd34be9296695486f838e0142f900803159",
        filename: "whisper-small-Q8_0.gguf",
        size_bytes: 269_751_136,
        sha256: "9b9c8811bbcc82a7766f0fb0925614bdacb0923b2cc630daeac17108b655b860",
        languages: "99 languages",
    },
    TranscriptionModel {
        id: "whisper-large-v3-turbo",
        name: "Whisper Large v3 Turbo",
        description: "The most accurate on offer here, and the slowest.",
        repo: "handy-computer/whisper-large-v3-turbo-gguf",
        revision: "5eaf945c7978e564bae5b28a5b1639dd93c2bfb1",
        filename: "whisper-large-v3-turbo-Q8_0.gguf",
        size_bytes: 886_381_760,
        sha256: "b2e30cc286bc9f3aba4db9099fc7403543497c05ce7100d0d83091ddfd25a183",
        languages: "100 languages",
    },
];

pub fn find(id: &str) -> Option<&'static TranscriptionModel> {
    MODELS.iter().find(|m| m.id == id)
}

/// Which model to suggest on this machine.
///
/// Handy ranks its list editorially — a static `recommended_rank` in its
/// catalog, with nothing reading the hardware — and the ranking is a good one,
/// but it cannot know that Parakeet's 731MB is a poor trade on a machine that
/// will run it on four slow cores. So the arch decides: Apple Silicon has the
/// unified memory and the accelerated backend to earn the larger model,
/// everything else gets the one that "runs well on any hardware".
///
/// A suggestion only. Nothing downloads without the reader pressing something,
/// and every model stays selectable whatever this answers.
pub fn recommended() -> &'static TranscriptionModel {
    let id = if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "parakeet-unified-en-0.6b"
    } else {
        "canary-180m-flash"
    };

    find(id).expect("recommended id must name a catalog entry")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_unique() {
        let mut ids: Vec<_> = MODELS.iter().map(|m| m.id).collect();
        ids.sort_unstable();
        let count = ids.len();
        ids.dedup();

        assert_eq!(ids.len(), count, "two models share an id");
    }

    /// The hash is what makes a resumed or interrupted download safe to trust,
    /// so a malformed one must fail here rather than at the end of 700MB.
    #[test]
    fn hashes_are_well_formed() {
        for m in MODELS {
            assert_eq!(m.sha256.len(), 64, "{}: sha256 is not 32 bytes", m.id);
            assert!(
                m.sha256.chars().all(|c| c.is_ascii_hexdigit()),
                "{}: sha256 is not hex",
                m.id
            );
            assert!(m.size_bytes > 0, "{}: no size", m.id);
        }
    }

    /// A revision pinned to `main` would let the bytes move out from under the
    /// hash, which presents as every download failing verification at once.
    #[test]
    fn revisions_are_commits() {
        for m in MODELS {
            assert_eq!(m.revision.len(), 40, "{}: revision is not a commit", m.id);
            assert!(
                m.revision.chars().all(|c| c.is_ascii_hexdigit()),
                "{}: revision is not hex",
                m.id
            );
        }
    }

    /// The label is drawn verbatim, so an empty one leaves a stray separator in
    /// the row. Naming the languages is only worth doing while they fit.
    #[test]
    fn language_labels_are_drawable() {
        for m in MODELS {
            assert!(!m.languages.is_empty(), "{}: no language label", m.id);
            assert!(
                m.languages.len() < 60,
                "{}: language label too long to sit in a row",
                m.id
            );
        }
    }

    #[test]
    fn recommendation_names_a_real_model() {
        assert!(find(recommended().id).is_some());
    }

    #[test]
    fn urls_name_the_pinned_revision() {
        let m = &MODELS[0];

        assert_eq!(
            m.url(),
            format!(
                "https://huggingface.co/{}/resolve/{}/{}",
                m.repo, m.revision, m.filename
            )
        );
        assert!(!m.url().contains("/main/"));
    }
}
