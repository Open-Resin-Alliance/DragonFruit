//! Detects a dead web content process and offers to bring the window back.
//!
//! WebKit gives each content process a hard memory ceiling — 16 GB on macOS —
//! and kills it on the spot when it cannot shrink below it. The app process
//! survives, so the window stays open, empty and grey, with no error anywhere
//! the user can see. That is what a "DragonFruit just froze" report looks like
//! from the outside.
//!
//! The webview pings this module while it is alive. Silence means one of three
//! things — the process is gone, its main thread is busy in a long synchronous
//! pass, or the OS is throttling its timers. The last one is the common case:
//! on macOS a hidden window's page has its timers slowed by WebKit, on its own
//! schedule and independently of the App Nap that slows this process, so the
//! pings can stop for minutes while everything is fine (#654).
//!
//! So silence alone never raises the alarm. After the grace period the
//! watchdog asks the webview directly with an event, which arrives as a
//! message rather than a timer and gets an answer from any page that is still
//! alive. Only a probe that goes unanswered leads to the dialog — and recovery
//! is never automatic: a reload would discard the user's scene, which is the
//! wrong trade to make on a guess. A webview that speaks again cancels the
//! whole thing, closing the dialog if it is already up.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{Emitter, Manager};

/// Silence after which the webview is probed. Well above any plausible
/// main-thread stall — the island scan's synchronous passes used to hold the
/// thread for tens of seconds before they learned to yield.
const GRACE_PERIOD: Duration = Duration::from_secs(90);

/// How long a probe may go unanswered before the webview is presumed dead.
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);

/// How often the watchdog looks at the clock.
const POLL_INTERVAL: Duration = Duration::from_secs(5);

/// A poll that arrives this much later than scheduled means the machine slept
/// or the app was suspended, not that anything died. Everything stopped in that
/// window — including the webview — so the silence proves nothing.
const SUSPENSION_SLACK: Duration = Duration::from_secs(20);

/// Gaps between pings longer than this are logged when the pings resume, so
/// the log records how long the webview actually goes quiet.
const NOTABLE_GAP: Duration = Duration::from_secs(15);

/// Event the webview answers with a heartbeat. Mirrored in `webviewHeartbeat.ts`.
const PROBE_EVENT: &str = "webview-watchdog:probe";

const DIALOG_TITLE: &str = "DragonFruit stopped responding";
const DIALOG_MESSAGE: &str = "The window's display process stopped and had to be shut down. \
     Reloading brings the window back, but unsaved changes to the scene are lost.\n\n\
     Reload now?";

#[derive(Default)]
pub struct WebviewLiveness {
    /// Milliseconds since the epoch of the last ping; 0 before the first one.
    last_seen_ms: AtomicU64,
    /// When the pending probe went out; 0 when none is pending.
    probe_sent_ms: AtomicU64,
    /// Set once the user has been asked about the current silence, so a dead
    /// webview prompts only once. Cleared by the next ping.
    prompted: AtomicBool,
    /// True while the dialog is on screen. A ping clears `prompted` but cannot
    /// close the dialog on every platform, and a second one must never stack
    /// behind it.
    dialog_open: AtomicBool,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl WebviewLiveness {
    fn record_ping(&self, answering_probe: bool) {
        let now = now_ms();
        let previous = self.last_seen_ms.swap(now, Ordering::Relaxed);
        let probe_sent = self.probe_sent_ms.swap(0, Ordering::Relaxed);
        // A webview that speaks again was only busy or throttled, not dead.
        // Re-arm so a later death still prompts.
        self.prompted.store(false, Ordering::Relaxed);

        let gap_ms = now.saturating_sub(previous);
        if previous == 0 || gap_ms < NOTABLE_GAP.as_millis() as u64 {
            return;
        }
        // A hidden page's timers can stop outright. The probe wakes it, and the
        // overdue timer tends to fire in the same instant, ahead of the probe's
        // own answer. So the delay since the probe is what measures whether the
        // page was reachable, whichever ping happened to arrive first.
        let source = if answering_probe {
            "probe answer"
        } else {
            "webview timer"
        };
        if probe_sent != 0 {
            log::info!(
                "[webview-watchdog] Heartbeat back after {} s, {} ms after the probe ({source}).",
                gap_ms / 1000,
                now.saturating_sub(probe_sent)
            );
        } else {
            log::info!(
                "[webview-watchdog] Heartbeat back after {} s ({source}).",
                gap_ms / 1000
            );
        }
    }

    /// Restarts the grace period without counting as a sign of life: the
    /// dialog, if any, stays up and stays the only one.
    fn restart_grace_period(&self) {
        if self.last_seen_ms.load(Ordering::Relaxed) == 0 {
            return;
        }
        self.last_seen_ms.store(now_ms(), Ordering::Relaxed);
        self.probe_sent_ms.store(0, Ordering::Relaxed);
    }

    /// Milliseconds of silence, or None before the first ping has ever arrived
    /// (startup, or a build with the frontend half missing — neither is a
    /// crash, and neither should raise a dialog).
    fn silence_ms(&self) -> Option<u64> {
        let last = self.last_seen_ms.load(Ordering::Relaxed);
        if last == 0 {
            return None;
        }
        Some(now_ms().saturating_sub(last))
    }
}

/// Called by the webview on a timer, and in answer to a probe.
#[tauri::command]
pub async fn webview_heartbeat(
    app: crate::DragonFruitAppHandle,
    state: tauri::State<'_, WebviewLiveness>,
    answering_probe: Option<bool>,
) -> Result<(), String> {
    state.record_ping(answering_probe.unwrap_or(false));
    if state.dialog_open.load(Ordering::Relaxed) {
        dialog::dismiss(&app);
    }
    Ok(())
}

/// Starts the watchdog. Safe to call once, from `setup()`.
pub fn spawn(app: crate::DragonFruitAppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut last_poll_ms = now_ms();
        loop {
            tokio::time::sleep(POLL_INTERVAL).await;

            let Some(state) = app.try_state::<WebviewLiveness>() else {
                continue;
            };

            // The watchdog's own clock is the sleep detector: this task is
            // suspended alongside everything else, so a poll that took far
            // longer than it asked for means the machine was not running. Start
            // the grace period again rather than alarming on a gap nobody was
            // awake for.
            let polled_at = now_ms();
            let poll_gap_ms = polled_at.saturating_sub(last_poll_ms);
            last_poll_ms = polled_at;
            if poll_gap_ms > (POLL_INTERVAL + SUSPENSION_SLACK).as_millis() as u64 {
                log::info!(
                    "[webview-watchdog] Woke after {} s of suspension; restarting the grace period.",
                    poll_gap_ms / 1000
                );
                state.restart_grace_period();
                continue;
            }

            let Some(silence_ms) = state.silence_ms() else {
                continue;
            };
            if silence_ms < GRACE_PERIOD.as_millis() as u64 {
                continue;
            }
            if state.prompted.load(Ordering::Relaxed) || state.dialog_open.load(Ordering::Relaxed) {
                continue;
            }

            let probe_sent = state.probe_sent_ms.load(Ordering::Relaxed);
            if probe_sent == 0 {
                log::info!(
                    "[webview-watchdog] No heartbeat for {} s; probing the webview.",
                    silence_ms / 1000
                );
                state.probe_sent_ms.store(polled_at, Ordering::Relaxed);
                if let Err(error) = app.emit_to("main", PROBE_EVENT, ()) {
                    log::warn!("[webview-watchdog] Could not send the probe: {error}");
                }
                continue;
            }
            if polled_at.saturating_sub(probe_sent) < PROBE_TIMEOUT.as_millis() as u64 {
                continue;
            }

            state.prompted.store(true, Ordering::Relaxed);
            state.dialog_open.store(true, Ordering::Relaxed);
            log::error!(
                "[webview-watchdog] No heartbeat for {} s and no answer to the probe — the web content process is presumed dead. Offering a reload.",
                silence_ms / 1000
            );
            let asked_at = now_ms();
            dialog::ask(app.clone(), move |app, wants_reload| {
                if let Some(state) = app.try_state::<WebviewLiveness>() {
                    state.dialog_open.store(false, Ordering::Relaxed);
                    // The webview may have come back while the dialog was up,
                    // on a platform where that cannot close it. Reloading a
                    // live page would throw away the scene for nothing.
                    if wants_reload && state.last_seen_ms.load(Ordering::Relaxed) > asked_at {
                        log::info!(
                            "[webview-watchdog] The webview answered while the dialog was open; not reloading."
                        );
                        return;
                    }
                }
                if wants_reload {
                    reload(app);
                } else {
                    log::info!("[webview-watchdog] Reload declined.");
                }
            });
        }
    });
}

fn reload(app: &crate::DragonFruitAppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        log::error!("[webview-watchdog] No 'main' window to reload.");
        return;
    };
    // Navigate, never eval. With the content process gone there is no
    // JavaScript context left to run `location.reload()` in — the call
    // returns Ok and does nothing, which is exactly the false success this
    // used to report. Navigation is native and spawns a fresh process.
    let url = match window.url() {
        Ok(url) => url,
        Err(error) => {
            log::error!("[webview-watchdog] Could not read the window URL: {error}");
            return;
        }
    };
    match window.navigate(url.clone()) {
        Ok(()) => log::info!("[webview-watchdog] Reloaded via navigation to {url}."),
        Err(error) => log::error!("[webview-watchdog] Navigation failed: {error}"),
    }
}

/// On macOS the question is a sheet on the main window, which the watchdog
/// can close when the webview turns out to be alive after all.
#[cfg(all(target_os = "macos", not(feature = "tauri-cef")))]
mod dialog {
    use std::cell::RefCell;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::MainThreadMarker;
    use objc2_app_kit::{
        NSAlert, NSAlertFirstButtonReturn, NSAlertStyle, NSModalResponse, NSModalResponseAbort,
        NSWindow,
    };
    use objc2_foundation::NSString;
    use tauri::Manager;

    use super::{DIALOG_MESSAGE, DIALOG_TITLE};

    thread_local! {
        /// The sheet on screen and the window it hangs from. Main thread only.
        static OPEN_SHEET: RefCell<Option<(Retained<NSAlert>, Retained<NSWindow>)>> =
            const { RefCell::new(None) };
    }

    pub fn ask(
        app: crate::DragonFruitAppHandle,
        on_answer: impl Fn(&crate::DragonFruitAppHandle, bool) + Send + 'static,
    ) {
        let main_app = app.clone();
        let result = app.run_on_main_thread(move || {
            let Some(mtm) = MainThreadMarker::new() else {
                return;
            };
            let window = main_app
                .get_webview_window("main")
                .and_then(|window| window.ns_window().ok())
                .filter(|ptr| !ptr.is_null());
            let Some(ns_window) = window else {
                log::error!("[webview-watchdog] No 'main' window to attach the dialog to.");
                on_answer(&main_app, false);
                return;
            };
            // SAFETY: tauri hands back the NSWindow backing the main window,
            // which is alive for as long as the window is; retaining it keeps
            // it valid for as long as the sheet holds on to it.
            let Some(ns_window) = (unsafe { Retained::retain(ns_window.cast::<NSWindow>()) })
            else {
                return;
            };

            let alert = NSAlert::new(mtm);
            alert.setAlertStyle(NSAlertStyle::Critical);
            alert.setMessageText(&NSString::from_str(DIALOG_TITLE));
            alert.setInformativeText(&NSString::from_str(DIALOG_MESSAGE));
            alert.addButtonWithTitle(&NSString::from_str("Yes"));
            alert.addButtonWithTitle(&NSString::from_str("No"));

            let handler_app = main_app.clone();
            let handler = RcBlock::new(move |response: NSModalResponse| {
                OPEN_SHEET.with(|sheet| sheet.borrow_mut().take());
                if response == NSModalResponseAbort {
                    // Closed by `dismiss`: the webview answered.
                    if let Some(state) = handler_app.try_state::<super::WebviewLiveness>() {
                        state
                            .dialog_open
                            .store(false, std::sync::atomic::Ordering::Relaxed);
                    }
                    log::info!("[webview-watchdog] The webview answered; dialog withdrawn.");
                    return;
                }
                on_answer(&handler_app, response == NSAlertFirstButtonReturn);
            });
            alert.beginSheetModalForWindow_completionHandler(&ns_window, Some(&handler));
            OPEN_SHEET.with(|sheet| *sheet.borrow_mut() = Some((alert, ns_window)));
        });
        if let Err(error) = result {
            log::error!("[webview-watchdog] Could not reach the main thread: {error}");
        }
    }

    pub fn dismiss(app: &crate::DragonFruitAppHandle) {
        let _ = app.run_on_main_thread(|| {
            let open = OPEN_SHEET.with(|sheet| {
                sheet
                    .borrow()
                    .as_ref()
                    .map(|(alert, window)| (alert.window(), window.clone()))
            });
            if let Some((sheet_window, parent)) = open {
                parent.endSheet_returnCode(&sheet_window, NSModalResponseAbort);
            }
        });
    }
}

/// Elsewhere it is rfd's blocking dialog, which cannot be closed from outside;
/// the answer is checked against the heartbeat before acting on it instead.
#[cfg(not(all(target_os = "macos", not(feature = "tauri-cef"))))]
mod dialog {
    use super::{DIALOG_MESSAGE, DIALOG_TITLE};

    pub fn ask(
        app: crate::DragonFruitAppHandle,
        on_answer: impl Fn(&crate::DragonFruitAppHandle, bool) + Send + 'static,
    ) {
        let main_app = app.clone();
        let result = app.run_on_main_thread(move || {
            let choice = rfd::MessageDialog::new()
                .set_level(rfd::MessageLevel::Error)
                .set_title(DIALOG_TITLE)
                .set_description(DIALOG_MESSAGE)
                .set_buttons(rfd::MessageButtons::YesNo)
                .show();
            on_answer(&main_app, choice == rfd::MessageDialogResult::Yes);
        });
        if let Err(error) = result {
            log::error!("[webview-watchdog] Could not reach the main thread: {error}");
        }
    }

    pub fn dismiss(_app: &crate::DragonFruitAppHandle) {}
}
