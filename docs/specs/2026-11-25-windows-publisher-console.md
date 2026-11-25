# Windows publisher: hide background Herdr CLI consoles

The laptop reported intermittent console flashes while the publisher was online.
The Windows publisher already hides its own worker, but background snapshot
reads launch the console executable with Node's default `windowsHide: false`.
This is a plausible cause, not a confirmed attribution on Windows.

- Launch piped Herdr CLI calls from the host plugin with `windowsHide: true`,
  preserving argv, timeout, output limits, parsing, and read fallback.
- Do not alter the polling cadence, user terminal attaches, or publisher mode.
- Regression: intercept the actual `execFile` invocation on any OS; assert the
  flag for snapshot, pane list and both sides of the screen-read fallback.
- Laptop acceptance: after applying the updated publisher, observe across
  several snapshot ticks with the local Herdr App still running. If flashes
  persist, capture the process and its parent before claiming a cause.
