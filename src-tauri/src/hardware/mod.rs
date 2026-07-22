//! The hardware utilities suite: one module per utility, each exposing a
//! `status()`-style function returning its payload from types.rs. All CLI
//! spawns go through cli::run_silent_timeout; WMI goes through wmi_bridge.

pub mod battery;
pub mod disks;
pub mod gpu;
pub mod lhm_setup;
pub mod mcp;
pub mod netq;
pub mod ollama;
pub mod ports;
pub mod speedtest;
pub mod thermals;
pub mod uptime;
pub mod winget;
pub mod wsl;
