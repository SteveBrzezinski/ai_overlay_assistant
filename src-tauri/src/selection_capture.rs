use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureOptions {
    pub copy_delay_ms: Option<u64>,
    pub restore_clipboard: Option<bool>,
}

impl Default for CaptureOptions {
    fn default() -> Self {
        Self { copy_delay_ms: Some(100), restore_clipboard: Some(true) }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureResult {
    pub text: String,
    pub restored_clipboard: bool,
    pub note: Option<String>,
}

#[cfg(target_os = "windows")]
mod windows_impl {
    use super::{CaptureOptions, CaptureResult};
    use std::{process::Command, thread, time::Duration};

    fn run_powershell(script: &str) -> Result<String, String> {
        let output = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .output()
            .map_err(|err| format!("Failed to launch PowerShell: {err}"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if stderr.is_empty() {
                format!("PowerShell script failed with status {}", output.status)
            } else {
                stderr
            });
        }

        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    }

    fn get_clipboard_text() -> Result<Option<String>, String> {
        let result = run_powershell(
            r#"
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationCore
if ([Windows.Clipboard]::ContainsText()) {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  [Windows.Clipboard]::GetText()
}
"#,
        )?;

        if result.is_empty() {
            Ok(None)
        } else {
            Ok(Some(result))
        }
    }

    fn set_clipboard_text(text: &str) -> Result<(), String> {
        let escaped = text.replace("'", "''");
        run_powershell(&format!(
            r#"
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationCore
[Windows.Clipboard]::SetText('{escaped}')
"#
        ))?;
        Ok(())
    }

    fn clear_clipboard() -> Result<(), String> {
        run_powershell(
            r#"
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationCore
[Windows.Clipboard]::Clear()
"#,
        )?;
        Ok(())
    }

    fn send_ctrl_c() -> Result<(), String> {
        run_powershell(
            r#"
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('^c')
"#,
        )?;
        Ok(())
    }

    pub fn capture_selected_text(options: Option<CaptureOptions>) -> Result<CaptureResult, String> {
        let options = options.unwrap_or_default();
        let restore = options.restore_clipboard.unwrap_or(true);
        let delay = Duration::from_millis(options.copy_delay_ms.unwrap_or(100));

        let previous = get_clipboard_text().ok().flatten();
        let _ = clear_clipboard();
        send_ctrl_c()?;
        thread::sleep(delay);

        let captured = get_clipboard_text()?.unwrap_or_default();
        let mut restored_clipboard = false;
        let mut note = None;

        if restore {
            match previous {
                Some(value) => {
                    if let Err(err) = set_clipboard_text(&value) {
                        note = Some(format!("Text captured, but clipboard restore failed: {err}"));
                    } else {
                        restored_clipboard = true;
                    }
                }
                None => {
                    restored_clipboard = clear_clipboard().is_ok();
                }
            }
        }

        if captured.trim().is_empty() && note.is_none() {
            note = Some(
                "No text captured. Check that text is selected and the target app accepts background copy."
                    .to_string(),
            );
        }

        Ok(CaptureResult { text: captured, restored_clipboard, note })
    }
}

#[cfg(target_os = "windows")]
pub use windows_impl::capture_selected_text;

#[cfg(not(target_os = "windows"))]
pub fn capture_selected_text(_options: Option<CaptureOptions>) -> Result<CaptureResult, String> {
    Err("Selection capture MVP is currently implemented for Windows only".into())
}
