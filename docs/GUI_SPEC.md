# GUI specification — v0.1

## Shell

The shell has one stable coordinate system:

- top bar: target process, run status, global search;
- left rail: Overview, Timeline, Flow, State, I/O, Compare;
- centre: the selected lens;
- right inspector: selected event, explanation and evidence links;
- bottom: an execution timeline that never disappears.

The screen is dark and information-dense, but a person can read the first answer without knowing ETW, stacks or profilers. Amber means selection, cyan means a navigable evidence link, red means a fault, and grey means unavailable rather than zero.

## Interaction contract

- Clicking an event in any lens selects the same event everywhere.
- Clicking **Trace value origin** opens State and follows reverse `CAUSES` edges.
- Clicking **Open divergence** opens Compare at the first event whose outcome differs.
- Clicking a timeline lane filters the centre lens without changing the capture.
- Search is global across functions, threads, values, files and endpoints.
- Capture mode is chosen before a session starts: Observe, Deep Trace or Time Travel.

## Human language rules

The UI leads with a sentence such as “The program is waiting for a device response.” It then offers the exact event, timestamp, thread, caller and evidence. Derived summaries (for example, “wait accounts for 63%”) are visually marked as derived. Missing capabilities are shown as “Unavailable — requires …”, never as empty data or a guessed value.

