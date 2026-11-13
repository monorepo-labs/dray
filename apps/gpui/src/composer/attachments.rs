//! The attachment tray (AttachmentTray.tsx): a thumbnail per image, a named
//! tile per file, a cross on hover.

use std::path::{Path, PathBuf};

use gpui::{
    App, ImageFormat, InteractiveElement, IntoElement, ObjectFit, ParentElement, StatefulInteractiveElement, Styled,
    StyledImage, Window, div, img, px, svg,
};

use super::colors::Colors;
use crate::theme::Theme;

/// attachments.rs's rule: these formats under 5MB travel as an image block;
/// anything else as an `@path` mention. Decided here only for the tile's look —
/// the server decides again on send.
const IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp"];
const MAX_IMAGE: u64 = 5 * 1024 * 1024;

#[derive(Clone, Debug)]
pub struct Attachment {
    pub path: PathBuf,
    pub name: String,
    pub image: bool,
}

impl Attachment {
    pub fn read(path: PathBuf) -> Attachment {
        let name = path.file_name().map_or_else(|| path.display().to_string(), |n| n.to_string_lossy().into_owned());
        let image = is_image(&path) && std::fs::metadata(&path).is_ok_and(|m| m.len() < MAX_IMAGE);
        Attachment { path, name, image }
    }
}

fn is_image(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()).is_some_and(|e| IMAGE_EXTS.contains(&e.to_ascii_lowercase().as_str()))
}

/// A pasted image written out as a file, as `paste_attachments` does, so it
/// joins the tray as a path like every other attachment.
pub fn write_pasted(image: &gpui::Image) -> anyhow::Result<PathBuf> {
    let ext = match image.format {
        ImageFormat::Png => "png",
        ImageFormat::Jpeg => "jpg",
        ImageFormat::Gif => "gif",
        ImageFormat::Webp => "webp",
        ImageFormat::Svg => "svg",
        ImageFormat::Bmp => "bmp",
        ImageFormat::Tiff => "tiff",
        _ => "img",
    };
    let dir = std::env::temp_dir().join("dray-paste");
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(format!("pasted-{}.{ext}", chrono::Local::now().format("%Y%m%d-%H%M%S%3f")));
    std::fs::write(&path, &image.bytes)?;
    Ok(path)
}

pub fn tray(
    attachments: &[Attachment],
    theme: &Theme,
    colors: &Colors,
    on_remove: impl Fn(&PathBuf, &mut Window, &mut App) + 'static,
) -> impl IntoElement {
    let on_remove = std::rc::Rc::new(on_remove);
    div().flex().flex_wrap().gap_2().children(attachments.iter().enumerate().map(|(i, a)| {
        let on_remove = on_remove.clone();
        let path = a.path.clone();
        let group: gpui::SharedString = format!("tile-{i}").into();
        let tile = if a.image {
            div()
                .size(px(56.))
                .rounded(px(8.))
                .overflow_hidden()
                .border_1()
                .border_color(colors.hairline_strong)
                .bg(colors.secondary)
                .child(img(a.path.clone()).size_full().object_fit(ObjectFit::Cover))
                .into_any_element()
        } else {
            div()
                .h(px(56.))
                .max_w(px(224.))
                .px(px(10.))
                .flex()
                .items_center()
                .gap_2()
                .rounded(px(8.))
                .border_1()
                .border_color(colors.hairline_strong)
                .bg(colors.secondary)
                .child(svg().path("icons/file.svg").size(px(20.)).flex_shrink_0().text_color(theme.muted_foreground))
                .child(div().min_w_0().truncate().text_size(px(13.)).text_color(theme.foreground).child(a.name.clone()))
                .into_any_element()
        };
        div()
            .group(group.clone())
            .relative()
            .child(tile)
            .child(
                div()
                    .id(("remove", i))
                    .absolute()
                    .top(px(-6.))
                    .right(px(-6.))
                    .p(px(2.))
                    .rounded_full()
                    .border_1()
                    .border_color(colors.border)
                    .bg(colors.secondary)
                    .cursor_pointer()
                    .opacity(0.)
                    .group_hover(group, |s| s.opacity(1.))
                    .child(svg().path("icons/x.svg").size(px(12.)).text_color(theme.foreground))
                    .on_click(move |_, window, cx| on_remove(&path, window, cx)),
            )
    }))
}
