# Changelog

## 0.3.0
- **Media Encoder and Bridge** support. Both are reached through BridgeTalk from any app that has the panel open (Premiere first, then After Effects, Photoshop…), and the panel is also offered to them directly.
- **Relay for every app**: when an app's own panel is not loaded (for example a new Illustrator or InDesign version), scripts for it go through another connected app instead of failing.
- `run_script` has a new `launch` option that starts a closed app (Media Encoder, Bridge, …) before running the script.
- `list_apps` now returns `connected`, `relayed` and `installed`: which Adobe apps are on this computer and how each one is reached; apps with no scripting interface (Lightroom, Character Animator, XD, Dimension, Acrobat) are listed with the reason.
- `app_state` for Media Encoder (version, batch status) and Bridge (folder, selection).
- Unsigned-panel setting is written for CSXS 9–17, so 2027 apps load the panel too.
- A clearer error when an old `adobe-bridge` server still holds the port.

## 0.2.0
- **Renamed from `adobe-bridge` to Studio Relay** (`studio-relay`), so it is not confused with Adobe's own Adobe Bridge app. The installers and the server remove the old panel and the old Claude Desktop entry; an old panel that is still loaded cannot take the connection from the new one.
- Long scripts run as **jobs**: a call waits up to `wait_ms` (default 45 s) and then returns a job id instead of timing out. New `job_result` tool. A retry never runs a script twice.
- Scripts for one app run **one at a time, in order** (parallel frame exports used to crash Premiere).
- **Heartbeat** on both sides: silent connections (sleeping Mac, crashed app) are dropped and reconnected automatically.
- The panel keeps finished results in an **outbox** and delivers them after a reconnect.
- **Hub take-over**: when the Claude window that owned the hub closes, another one takes over and the panels reconnect to it.
- The panel **loads when the app starts**, even if it was never opened from the Window menu; stays alive in Photoshop when hidden.
- `export_frame` also works in Photoshop, Illustrator and InDesign.
- **Audition** support.
- The `.mcpb` installs and updates the panel by itself on first start.
- Windows installer (`install.ps1`), uninstallers, GitHub Actions CI and release builds.

## 0.1.0
- First version, released as `adobe-bridge`: `list_apps`, `app_state`, `run_script`, `export_frame` for After Effects, Premiere Pro, Photoshop, Illustrator and InDesign.
