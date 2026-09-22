// This is a plain script (not a module) so it can be loaded with a normal
// <script src="config.js"></script> tag — no build step needed.
//
// The URLs below are safe to commit to a PUBLIC repo. That sounds wrong for
// a URL that talks to your private task data, but it's true here BECAUSE
// every single request the server accepts must include a "device key" —
// a long random password that is NEVER stored in this repo (see
// docs/RUNBOOK.md). Anyone who finds this URL can reach the server, but
// without the device key the server refuses to do anything for them.
//
// (This is also why the OLD version of this app was insecure: its URL was
// public AND it had no device key, so the URL alone was enough to read and
// change every task.)
window.PLANNER_CONFIG = {
  prodUrl: "https://script.google.com/macros/s/AKfycbw8fHeY0u5Yg-CUAj3DW6Hx-G2_e_XmiyUQyViKsgdasmCKjy1u2dxIXVVgd17mSU_Zsg/exec",
  stagingUrl: "",
};
