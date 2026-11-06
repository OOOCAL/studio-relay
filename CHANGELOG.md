# Changelog

## 0.2.0
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
- First version: `list_apps`, `app_state`, `run_script`, `export_frame` for After Effects, Premiere Pro, Photoshop, Illustrator and InDesign.
