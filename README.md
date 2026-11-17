# Tower of Hanoi: Beyond Infinity — Browser + Prolog Edition

This is a browser-based rewrite of the supplied Pygame game. The game board, menus, controls and visual effects are built with **HTML, CSS and vanilla JavaScript**. The puzzle rules, legal-move checks, optimal solver, search and score calculation are handled by the original **SWI-Prolog** engine in `prolog/hanoi_core.pl`.

There is no Python runtime, Pygame dependency, Node.js dependency, database or external service. The SWI-Prolog process serves the web files and exposes a small JSON API on the same local origin.

## Requirements

- SWI-Prolog 9.x (`swipl` on your PATH)
- A modern browser (Chrome, Edge, Firefox or Safari)

## Run it

### Windows

1. Install SWI-Prolog 9.x from <https://www.swi-prolog.org/Download.html>.
2. Extract this folder.
3. Double-click `run.bat`.
4. Open <http://localhost:8080> if the browser does not open automatically.

### Linux / macOS

```sh
chmod +x run.sh
./run.sh
```

Then open <http://localhost:8080>.

You can also start it directly from the project folder:

```sh
swipl -q -s prolog/web_server.pl
```

To choose another port, set `PORT` before launching:

```sh
PORT=8090 swipl -q -s prolog/web_server.pl
```

On Windows PowerShell:

```powershell
$env:PORT = "8090"
swipl -q -s prolog/web_server.pl
```

Press `Ctrl+C` in the server terminal to stop the game server.

## Browser edition features

- **Classic:** 3 towers, 2–10 disks, configurable start and goal towers.
- **Zen:** a relaxed version with no time pressure and free hints.
- **Infinity Towers:** 4–6 towers with Open, Line, Ring and Star route networks. The browser edition caps this mode at 6 disks so exact solver searches remain practical.
- **Time Attack:** race a configurable countdown based on the optimal solution length.
- Click a tower to select its top disk, then click a destination, or drag the top disk to another tower. Legal destinations pulse and successful drops receive a landing highlight.
- Curved disk-flight animations with pickup, travel and landing sounds; the same motion is used for normal moves, undo, redo and Prolog auto-solve.
- Optional generated ambient music and separately controlled sound effects.
- Undo, redo, hint, automatic optimal solve, restart and move history.
- Responsive layout for desktop and mobile browsers.

The supplied Pygame edition also contains campaign progression, daily challenges, boss puzzles, Chaos mode, cosmetics, achievements, audio and profile/save systems. Those extended screens and progression systems are **not part of this first browser rewrite**; the four modes listed above are playable. The Prolog engine retains the supplied move-validation, graph-search, optimality and scoring predicates, including support for restrictions used by the original project.

## Architecture

```text
web/
  index.html       Semantic UI and screens
  styles.css       Responsive cosmic theme and disk/tower styling
  app.js           Browser interaction, state display, timer and API client
prolog/
  web_server.pl    SWI-Prolog HTTP server, static-file host and JSON API
  hanoi_core.pl    Authoritative Hanoi rules, solver, graph search and scoring
```

The browser sends a JSON request to `/api`. The Prolog server calls `hanoi_core:dispatch/2` and returns the result as JSON. In particular, `apply_move`, `legal_moves`, `solver_best_move`, `solver_distance` and `score` all execute in Prolog. JavaScript is responsible for input, animated DOM rendering, local undo/redo history, audio feedback and the clock display; it does not independently decide whether a disk move is legal.

## API operations

The web server accepts JSON `POST` requests at `/api`. The request object uses the same operation names and payload conventions as the original JSON-lines Prolog bridge. For example:

```json
{
  "op": "apply_move",
  "num_towers": 3,
  "num_disks": 4,
  "initial_positions": [0, 0, 0, 0],
  "target_positions": [2, 2, 2, 2],
  "closed_routes": [],
  "restrictions": [],
  "move_limit": -1,
  "pos": [0, 0, 0, 0],
  "moves": 0,
  "locked": [],
  "dynamic_closed": [],
  "src": 0,
  "dst": 1,
  "teleport": 0
}
```

The disk at index `0` is disk `1` (the smallest disk), and tower indexes are zero-based.

## Troubleshooting

- If the API previously returned `Type error: json_term expected, found @(true)`, close the old server and extract this corrected archive into a **new folder**. The API uses the dict-style JSON boolean atoms (`true` and `false`) expected by `reply_json_dict/1`.
- Keep the server terminal open while playing. If an API request fails, the browser reports the Prolog error and the server terminal prints its diagnostic.
- The engine indicator retries automatically every 4 seconds while offline. After replacing files, hard-refresh the browser (`Ctrl+F5`) so it does not keep an older cached JavaScript file.
- To test the API from PowerShell while the server is running, execute:

  ```powershell
  Invoke-RestMethod -Uri "http://127.0.0.1:8080/api" -Method POST -ContentType "application/json" -Body '{"op":"ping"}'
  ```

  A working server returns `pong : True` (or an equivalent JSON true value). If this request returns an error, read the matching exception in the `run.bat` terminal.

## Notes

- The server binds to the default local port `8080`. It is intended for local play; do not expose it to an untrusted public network without adding authentication and deployment hardening.
- The project uses no external runtime assets. Fonts fall back to system sans-serif/monospace fonts.
- The original MIT licence and attribution notice are included.


## Design and gameplay updates

- Larger, higher-contrast text across the setup and gameplay screens; decorative micro-labels and repeated helper copy are hidden to reduce clutter.
- Optional original ambient background music and synthesized sound effects are generated in the browser with the Web Audio API. Select **MUSIC ON** to start the music; use **SFX ON/OFF** to control move sounds independently. Browsers require a user interaction before audio can play. No external audio files or third-party audio service are used.
- Disk moves use a curved, glowing flight path instead of teleporting. The same animation is used for normal moves, undo, redo and Prolog auto-solve.
- Pickup, whoosh, landing and rejected-move sound effects are synthesized with the Web Audio API. **SFX ON/OFF** controls effects independently from **MUSIC ON/OFF**.
- Legal destinations pulse, the landing tower flashes, and a small impact burst confirms successful drops. Reduced-motion preferences are respected.
