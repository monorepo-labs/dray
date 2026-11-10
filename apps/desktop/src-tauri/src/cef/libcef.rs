//! libcef.so, loaded at run time rather than linked.
//!
//! `cef-dll-sys` links `-lcef` on Linux, which makes libcef.so a `DT_NEEDED`
//! of the app's binary: no Chromium on disk, no app at all. But Chromium is
//! downloaded after install (`chromium.rs`), so the binary has to start
//! without it. Every function the bindings declare is therefore defined here
//! as a trampoline — one indirect jump through a slot `load` fills from
//! `dlsym` — and since the binary then takes nothing from libcef.so, the
//! linker's `--as-needed` drops the dependency. A jump is signature-blind,
//! so one stub serves every function.
//!
//! **The list must name every `cef_*` function the bindings declare.** One
//! missing binds straight to libcef.so and puts the `DT_NEEDED` back, which
//! fails loudly: the app refuses to start on a machine without Chromium.
//! `readelf -d target/debug/dray | grep libcef` is the check; regenerate from
//! `cef-dll-sys`'s `src/bindings/x86_64_unknown_linux_gnu.rs` on a version bump.

use std::ffi::{c_void, CString};
use std::path::Path;

macro_rules! trampolines {
    ($($name:ident),* $(,)?) => {
        #[allow(non_snake_case, non_upper_case_globals)]
        mod slots {
            $(pub static mut $name: usize = 0;)*
        }

        $(
            #[cfg(target_arch = "x86_64")]
            core::arch::global_asm!(
                concat!(".globl ", stringify!($name), "\n.type ", stringify!($name), ",@function\n", stringify!($name), ":\n"),
                "jmp qword ptr [rip + {slot}]",
                slot = sym slots::$name,
            );
            #[cfg(target_arch = "aarch64")]
            core::arch::global_asm!(
                concat!(".globl ", stringify!($name), "\n.type ", stringify!($name), ",%function\n", stringify!($name), ":\n"),
                "adrp x16, {slot}",
                "ldr x16, [x16, :lo12:{slot}]",
                "br x16",
                slot = sym slots::$name,
            );
        )*

        /// Fills every slot from `lib`. A name libcef.so does not export
        /// stays null and crashes only if called, which the bindings never
        /// do for a function this CEF version lacks.
        unsafe fn fill(lib: *mut c_void) {
            $(
                let sym = libc::dlsym(lib, concat!(stringify!($name), "\0").as_ptr().cast());
                *std::ptr::addr_of_mut!(slots::$name) = sym as usize;
            )*
        }
    };
}

/// Opens libcef.so from `dir` and points every trampoline at it. Once per
/// process; the library is never closed, as on the Mac.
pub fn load(dir: &Path) -> Result<(), String> {
    let path = dir.join("libcef.so");
    let c_path = CString::new(path.as_os_str().as_encoded_bytes()).map_err(|e| e.to_string())?;
    let lib = unsafe { libc::dlopen(c_path.as_ptr(), libc::RTLD_NOW | libc::RTLD_LOCAL) };
    if lib.is_null() {
        let why = unsafe { std::ffi::CStr::from_ptr(libc::dlerror()) };
        return Err(format!("could not load {}: {}", path.display(), why.to_string_lossy()));
    }
    unsafe { fill(lib) };
    Ok(())
}

trampolines! {
    cef_add_cross_origin_whitelist_entry,
    cef_api_hash,
    cef_api_version,
    cef_base64_decode,
    cef_base64_encode,
    cef_basetime_now,
    cef_begin_tracing,
    cef_binary_value_create,
    cef_browser_host_create_browser,
    cef_browser_host_create_browser_sync,
    cef_browser_host_get_browser_by_identifier,
    cef_browser_view_create,
    cef_browser_view_get_for_browser,
    cef_clear_cross_origin_whitelist,
    cef_clear_scheme_handler_factories,
    cef_command_line_create,
    cef_command_line_get_global,
    cef_component_updater_get,
    cef_cookie_manager_get_global_manager,
    cef_crash_reporting_enabled,
    cef_create_directory,
    cef_create_new_temp_directory,
    cef_create_temp_directory_in_directory,
    cef_create_url,
    cef_currently_on,
    cef_delete_file,
    cef_dictionary_value_create,
    cef_directory_exists,
    cef_display_convert_screen_point_from_pixels,
    cef_display_convert_screen_point_to_pixels,
    cef_display_convert_screen_rect_from_pixels,
    cef_display_convert_screen_rect_to_pixels,
    cef_display_get_alls,
    cef_display_get_count,
    cef_display_get_matching_bounds,
    cef_display_get_nearest_point,
    cef_display_get_primary,
    cef_do_message_loop_work,
    cef_drag_data_create,
    cef_end_tracing,
    cef_execute_process,
    cef_format_url_for_security_display,
    cef_get_current_platform_thread_handle,
    cef_get_current_platform_thread_id,
    cef_get_exit_code,
    cef_get_extensions_for_mime_type,
    cef_get_mime_type,
    cef_get_path,
    cef_get_temp_directory,
    cef_get_xdisplay,
    cef_id_for_command_id_name,
    cef_id_for_pack_resource_name,
    cef_id_for_pack_string_name,
    cef_image_create,
    cef_initialize,
    cef_is_cert_status_error,
    cef_is_rtl,
    cef_label_button_create,
    cef_launch_process,
    cef_list_value_create,
    cef_load_crlsets_file,
    cef_media_router_get_global,
    cef_menu_button_create,
    cef_menu_model_create,
    cef_now_from_system_trace_time,
    cef_panel_create,
    cef_parse_json,
    cef_parse_jsonand_return_error,
    cef_parse_json_buffer,
    cef_parse_url,
    cef_post_data_create,
    cef_post_data_element_create,
    cef_post_delayed_task,
    cef_post_task,
    cef_preference_manager_get_chrome_variations_as_strings,
    cef_preference_manager_get_chrome_variations_as_switches,
    cef_preference_manager_get_global,
    cef_print_settings_create,
    cef_process_message_create,
    cef_quit_message_loop,
    cef_register_scheme_handler_factory,
    cef_remove_cross_origin_whitelist_entry,
    cef_request_context_cef_create_context_shared,
    cef_request_context_create_context,
    cef_request_context_get_global_context,
    cef_request_create,
    cef_resolve_url,
    cef_resource_bundle_get_global,
    cef_response_create,
    cef_run_message_loop,
    cef_scroll_view_create,
    cef_server_create,
    cef_set_crash_key_value,
    cef_set_nestable_tasks_allowed,
    cef_shared_process_message_builder_create,
    cef_shutdown,
    cef_stream_reader_create_for_data,
    cef_stream_reader_create_for_file,
    cef_stream_reader_create_for_handler,
    cef_stream_writer_create_for_file,
    cef_stream_writer_create_for_handler,
    cef_string_ascii_to_utf16,
    cef_string_ascii_to_wide,
    cef_string_list_alloc,
    cef_string_list_append,
    cef_string_list_clear,
    cef_string_list_copy,
    cef_string_list_free,
    cef_string_list_size,
    cef_string_list_value,
    cef_string_map_alloc,
    cef_string_map_append,
    cef_string_map_clear,
    cef_string_map_find,
    cef_string_map_free,
    cef_string_map_key,
    cef_string_map_size,
    cef_string_map_value,
    cef_string_multimap_alloc,
    cef_string_multimap_append,
    cef_string_multimap_clear,
    cef_string_multimap_enumerate,
    cef_string_multimap_find_count,
    cef_string_multimap_free,
    cef_string_multimap_key,
    cef_string_multimap_size,
    cef_string_multimap_value,
    cef_string_userfree_utf16_alloc,
    cef_string_userfree_utf16_free,
    cef_string_userfree_utf8_alloc,
    cef_string_userfree_utf8_free,
    cef_string_userfree_wide_alloc,
    cef_string_userfree_wide_free,
    cef_string_utf16_clear,
    cef_string_utf16_cmp,
    cef_string_utf16_set,
    cef_string_utf16_to_lower,
    cef_string_utf16_to_upper,
    cef_string_utf16_to_utf8,
    cef_string_utf16_to_wide,
    cef_string_utf8_clear,
    cef_string_utf8_cmp,
    cef_string_utf8_set,
    cef_string_utf8_to_utf16,
    cef_string_utf8_to_wide,
    cef_string_wide_clear,
    cef_string_wide_cmp,
    cef_string_wide_set,
    cef_string_wide_to_utf16,
    cef_string_wide_to_utf8,
    cef_task_manager_get,
    cef_task_runner_get_for_current_thread,
    cef_task_runner_get_for_thread,
    cef_textfield_create,
    cef_thread_create,
    cef_time_delta,
    cef_time_from_basetime,
    cef_time_from_doublet,
    cef_time_from_timet,
    cef_time_now,
    cef_time_to_basetime,
    cef_time_to_doublet,
    cef_time_to_timet,
    cef_uridecode,
    cef_uriencode,
    cef_urlrequest_create,
    cef_v8_backing_store_create,
    cef_v8_context_get_current_context,
    cef_v8_context_get_entered_context,
    cef_v8_context_in_context,
    cef_v8_stack_trace_get_current,
    cef_v8_value_create_array,
    cef_v8_value_create_array_buffer,
    cef_v8_value_create_array_buffer_from_backing_store,
    cef_v8_value_create_array_buffer_with_copy,
    cef_v8_value_create_bool,
    cef_v8_value_create_date,
    cef_v8_value_create_double,
    cef_v8_value_create_function,
    cef_v8_value_create_int,
    cef_v8_value_create_null,
    cef_v8_value_create_object,
    cef_v8_value_create_promise,
    cef_v8_value_create_string,
    cef_v8_value_create_uint,
    cef_v8_value_create_undefined,
    cef_value_create,
    cef_waitable_event_create,
    cef_window_create_top_level,
    cef_write_json,
    cef_xml_reader_create,
    cef_zip_directory,
    cef_zip_reader_create,
}
