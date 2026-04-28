#[cfg(target_os = "windows")]
mod platform {
    use std::{mem::size_of, ptr, thread, time::Duration};
    use windows::Win32::{
        Foundation::{GlobalFree, HANDLE, HWND},
        System::{
            DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData},
            Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE},
        },
        UI::Input::KeyboardAndMouse::{
            keybd_event, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, VK_CONTROL, VK_V,
        },
    };

    const CF_UNICODETEXT_FORMAT: u32 = 13;

    pub fn set_clipboard_text(text: &str) -> Result<(), String> {
        let mut wide: Vec<u16> = text.encode_utf16().collect();
        wide.push(0);
        let byte_len = wide.len() * size_of::<u16>();

        unsafe {
            let handle = GlobalAlloc(GMEM_MOVEABLE, byte_len)
                .map_err(|error| format!("Failed to allocate clipboard memory: {error}"))?;
            let locked = GlobalLock(handle);
            if locked.is_null() {
                let _ = GlobalFree(handle);
                return Err("Failed to lock clipboard memory.".to_string());
            }

            ptr::copy_nonoverlapping(wide.as_ptr(), locked.cast::<u16>(), wide.len());
            let _ = GlobalUnlock(handle);

            OpenClipboard(HWND(std::ptr::null_mut()))
                .map_err(|error| format!("Failed to open Windows clipboard: {error}"))?;

            let mut ownership_transferred = false;
            let result = (|| {
                EmptyClipboard()
                    .map_err(|error| format!("Failed to clear Windows clipboard: {error}"))?;
                SetClipboardData(CF_UNICODETEXT_FORMAT, HANDLE(handle.0)).map_err(|error| {
                    format!("Failed to write text to Windows clipboard: {error}")
                })?;
                ownership_transferred = true;
                Ok(())
            })();

            let _ = CloseClipboard();
            if !ownership_transferred {
                let _ = GlobalFree(handle);
            }

            result
        }
    }

    pub fn paste_clipboard() -> Result<(), String> {
        unsafe {
            keybd_event(VK_CONTROL.0 as u8, 0, KEYBD_EVENT_FLAGS(0), 0);
            keybd_event(VK_V.0 as u8, 0, KEYBD_EVENT_FLAGS(0), 0);
            thread::sleep(Duration::from_millis(20));
            keybd_event(VK_V.0 as u8, 0, KEYEVENTF_KEYUP, 0);
            keybd_event(VK_CONTROL.0 as u8, 0, KEYEVENTF_KEYUP, 0);
        }
        Ok(())
    }
}

#[cfg(target_os = "windows")]
pub use platform::{paste_clipboard, set_clipboard_text};

#[cfg(not(target_os = "windows"))]
pub fn set_clipboard_text(_text: &str) -> Result<(), String> {
    Err("Clipboard insertion is currently implemented for Windows only.".to_string())
}

#[cfg(not(target_os = "windows"))]
pub fn paste_clipboard() -> Result<(), String> {
    Err("Clipboard paste insertion is currently implemented for Windows only.".to_string())
}
