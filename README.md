# Code poems

A local web gallery for executable poems. Browse and edit source in the
browser, run it with an installed language runtime, and add poems with their
runtime, controls, and theme configuration.

## Project layout

- `index.html` is the browser interface.
- `server.js` serves the interface and API, validates configuration, and starts
  local runtime processes.
- `poems\` stores the saved source files.
- `config\poems.json` registers poem filenames, runtimes, controls, themes, and
  source-display settings.
- `config\runtimes.json` lists runtime IDs, labels, and source extensions
  offered by the upload form.
- `config\palettes.json` defines app colors and syntax-highlighting colors.

The poem catalog refers to files by name; settings and source code are kept
separately.

## Requirements and startup

Install Node.js and any language runtimes you want to use. The app supports:

- JavaScript (`.js`), using the Node.js executable running the server.
- Ruby (`.rb`), using `ruby` on `PATH`.
- Racket (`.rkt`), using `racket` on `PATH`.
- Elixir (`.exs`), using the Elixir and Erlang installations on the host.

Elixir and Erlang are detected in standard Windows install directories. If
they are installed elsewhere, set `ELIXIR_PATH` to the Elixir launcher or its
`bin` directory and `ERLANG_PATH` to the Erlang `bin` directory. For example:

```powershell
$env:ELIXIR_PATH = 'C:\Program Files\Elixir\bin\elixir.bat'
$env:ERLANG_PATH = 'C:\Program Files\Erlang OTP\bin'
node .\server.js
```

From the project folder, start the app:

```powershell
node .\server.js
```

Then open <http://127.0.0.1:4173>. The server listens on loopback only; it is
not exposed to the local network.

If `config\poems.json` is missing or blank, startup initializes an empty list.
The app removes empty placeholders and catalog entries whose source files are
missing. Invalid non-empty JSON is left untouched and reported as a startup
error so it can be repaired without losing its contents. Older entries without
a theme or `fitSource` setting receive defaults at startup.

## Reading, editing, and running poems

Select a poem tab to open its source and controls. Source is syntax-highlighted
and editable in the browser. **Run** sends the current editor contents and
control values to the selected runtime; the app does not save editor changes
back to `poems\` or compile them separately. The runtime executes the text from
a temporary source file in the system temp area. That file is removed as soon
as the run ends or is stopped. Saved poem files are not changed by a run.

Use **Stop** to terminate a running program. Standard output and errors are
streamed into the playback window. Programs can emit a form-feed (`\f`) or a
terminal clear sequence to replace the displayed frame instead of accumulating
output.

The included `moon_mailbox.exs` poem types its lines character by character,
holds the completed page for three seconds, then removes one line per second
until the page is empty and starts again. Its speed control changes the
character delay. It accepts the old `iterations` argument for compatibility,
but deliberately repeats until stopped.

## Adding a poem

Choose **+ upload**, select a source file, then choose its runtime, theme, and
controls. The file extension must match the runtime, and source uploads are
limited to 1 MB. Existing filenames are never overwritten.

The right-hand window has **source** and **playback** tabs. The source tab
previews the selected file with syntax highlighting and allows temporary
editing. **Preview** executes the current editor contents. **Save poem**
stores the original selected file, not edits made in the browser, and adds its
settings to `config\poems.json`.

The upload form starts with `iterations` (1–1000, default 100) and `speed`
(0.25–4, default 1) controls. Each configured control is passed as a
`--<id> <value>` command-line argument. A poem should parse and validate the
arguments it uses; it may ignore controls it does not use. The server checks
control values against the configured bounds before starting the runtime.

**Shrink source to fit window** controls whether the saved poem's source
preview automatically reduces its font size to fit. The setting is stored as
`fitSource` in the poem catalog and defaults to `true` for older entries.

## Configuration

Each `config\poems.json` entry identifies a file under `poems\` and configures
its runtime, controls, theme, and source fitting. A control has this shape:

```json
{
  "id": "speed",
  "label": "Speed",
  "type": "range",
  "min": 0.25,
  "max": 4,
  "step": 0.25,
  "value": 1
}
```

The supported control types are `number` and `range`. Control IDs become
command-line option names, such as `speed` becoming `--speed`.

Themes are selected by palette ID and defined in `config\palettes.json`.
Available themes are Monochrome, Ember, Paper, Slate, Wood, Nature, Neon,
Midnight, UGGO, Lava, and Spearmint. A theme controls both the app colors and
source syntax colors. The first palette is used for older catalog entries
without a theme.

The upload runtime choices come from `config\runtimes.json`; a new runtime also
needs a corresponding supported launcher in `server.js`. Do not add a runtime
to the JSON file unless its process-launch configuration is implemented.

## Safety

Programs run locally with the permissions of the account running the server.
Source edits execute as code and can read or modify files accessible to that
account. Only run poems you trust. The app does not sandbox runtime processes.
