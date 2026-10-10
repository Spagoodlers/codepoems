const { spawn } = require("node:child_process");
const { createServer } = require("node:http");
const { randomUUID } = require("node:crypto");
const { access, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const root = __dirname;
const poemsDirectory = path.join(root, "poems");
const configDirectory = path.join(root, "config");
const poemsFile = path.join(configDirectory, "poems.json");
const runtimeConfig = require("./config/runtimes.json");
const palettes = require("./config/palettes.json");
const poems = [];
const poemsById = new Map();
// Manifest mutations are queued so simultaneous uploads/removals cannot overwrite each other.
let manifestQueue = Promise.resolve();
// Runtime launchers are code-owned; JSON config may choose only these supported runtimes.
const runtimeExecutors = new Map([
  ["javascript", { command: process.execPath, extension: ".js" }],
  ["ruby", { command: "ruby", extension: ".rb" }],
  ["racket", { command: "racket", extension: ".rkt" }],
  ["elixir", {
    command: "elixir",
    windowsCommand: "elixir.bat",
    extension: ".exs",
    executableEnvironmentVariable: "ELIXIR_PATH"
  }]
]);
if (!Array.isArray(runtimeConfig)) {
  throw new Error("config/runtimes.json must contain an array.");
}
const runtimes = new Map();
for (const configuredRuntime of runtimeConfig) {
  const executor = runtimeExecutors.get(configuredRuntime.id);
  if (!executor || typeof configuredRuntime.label !== "string"
      || !configuredRuntime.label.trim()
      || configuredRuntime.extension !== executor.extension
      || runtimes.has(configuredRuntime.id)) {
    throw new Error(`Invalid or unsupported runtime in config/runtimes.json: ${configuredRuntime.id}`);
  }
  runtimes.set(configuredRuntime.id, { ...executor, ...configuredRuntime });
}
if (!Array.isArray(palettes) || palettes.length === 0) {
  throw new Error("config/palettes.json must contain at least one palette.");
}
const paletteIds = new Set();
for (const palette of palettes) {
  if (!palette || typeof palette !== "object"
      || typeof palette.id !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(palette.id)
      || typeof palette.label !== "string" || !palette.label.trim()
      || !palette.colors || !palette.syntax
      || paletteIds.has(palette.id)
      || !["bg", "panel", "ink", "dim", "line", "term", "termink", "acc"]
        .every(key => /^#[0-9a-fA-F]{6}$/.test(palette.colors[key]))
      || !["comment", "string", "keyword", "number", "builtin", "constant", "atom", "operator"]
        .every(key => /^#[0-9a-fA-F]{6}$/.test(palette.syntax[key]))) {
    throw new Error(`Invalid palette in config/palettes.json: ${palette?.id || "unknown"}`);
  }
  paletteIds.add(palette.id);
}
const defaultPaletteId = palettes[0].id;
const staticFiles = new Map([
  ["/", "index.html"]
]);
const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".js", "text/plain; charset=utf-8"],
  [".rb", "text/plain; charset=utf-8"],
  [".rkt", "text/plain; charset=utf-8"],
  [".exs", "text/plain; charset=utf-8"]
]);

// Return plain text errors before streaming starts, or append the error to an open stream.
function sendError(response, status, message) {
  if (response.headersSent) {
    response.end(`\n${message}\n`);
    return;
  }
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  response.end(message);
}

async function savePoemManifest() {
  await mkdir(configDirectory, { recursive: true });
  const temporaryFile = `${poemsFile}.${randomUUID()}.tmp`;
  try {
    // Rename only after the complete JSON has been written to avoid partial manifests.
    await writeFile(temporaryFile, `${JSON.stringify(poems, null, 2)}\n`, "utf8");
    await rename(temporaryFile, poemsFile);
  } finally {
    await rm(temporaryFile, { force: true });
  }
}

function removePoemFromCatalog(id) {
  const operation = manifestQueue.then(async () => {
    const index = poems.findIndex(poem => poem.id === id);
    if (index === -1) return false;

    const [poem] = poems.splice(index, 1);
    poemsById.delete(id);
    try {
      await savePoemManifest();
    } catch (error) {
      // Restore in-memory state if the on-disk catalog could not be updated.
      poems.splice(index, 0, poem);
      poemsById.set(id, poem);
      throw error;
    }
    console.warn(`Removed "${id}" from ${path.relative(root, poemsFile)} because its source file is missing.`);
    return true;
  });
  manifestQueue = operation.catch(() => {});
  return operation;
}

// Load, migrate, and prune the catalog before exposing it to the browser.
async function loadPoemCatalog() {
  await mkdir(poemsDirectory, { recursive: true });
  let contents;
  try {
    contents = await readFile(poemsFile, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    contents = "";
  }
  contents = contents.replace(/^\uFEFF/, "");

  let catalog;
  if (!contents.trim()) {
    catalog = [];
    await savePoemManifest();
  } else {
    try {
      catalog = JSON.parse(contents);
    } catch (error) {
      throw new Error(`Could not parse ${poemsFile}: ${error.message}. Fix the JSON; the file was left unchanged.`);
    }
  }
  if (!Array.isArray(catalog)) {
    throw new Error(`${poemsFile} must contain a JSON array of poem entries.`);
  }

  const seenIds = new Set();
  const missingSources = [];
  let removedEntries = false;
  for (const poem of catalog) {
    if (poem && typeof poem === "object" && !Array.isArray(poem)
        && Object.keys(poem).length === 0) {
      console.warn(`Removing an empty entry from ${path.relative(root, poemsFile)}.`);
      removedEntries = true;
      continue;
    }
    if (!poem || typeof poem !== "object" || Array.isArray(poem)
        || typeof poem.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(poem.id)
        || typeof poem.runtime !== "string" || !runtimes.has(poem.runtime)
        || path.extname(poem.id).toLowerCase() !== runtimes.get(poem.runtime).extension
        || !Array.isArray(poem.controls)) {
      throw new Error(`Invalid poem entry in ${poemsFile}: ${JSON.stringify(poem)}`);
    }
    if (poem.theme === undefined) {
      // Fill fields introduced after older catalog entries may have been created.
      poem.theme = defaultPaletteId;
      removedEntries = true;
    } else if (typeof poem.theme !== "string" || !paletteIds.has(poem.theme)) {
      throw new Error(`Invalid theme "${poem.theme}" for "${poem.id}" in ${poemsFile}.`);
    }
    if (poem.fitSource === undefined) {
      poem.fitSource = true;
      removedEntries = true;
    } else if (typeof poem.fitSource !== "boolean") {
      throw new Error(`Invalid fitSource setting for "${poem.id}" in ${poemsFile}; expected true or false.`);
    }
    if (seenIds.has(poem.id)) {
      throw new Error(`Duplicate poem id "${poem.id}" in ${poemsFile}.`);
    }
    try {
      validateControls(poem.controls);
    } catch (error) {
      throw new Error(`Invalid controls for "${poem.id}" in ${poemsFile}: ${error.message}`);
    }
    seenIds.add(poem.id);
    try {
      if (!(await stat(path.join(poemsDirectory, poem.id))).isFile()) {
        missingSources.push(poem.id);
        continue;
      }
    } catch (error) {
      if (error.code === "ENOENT") {
        missingSources.push(poem.id);
        continue;
      }
      throw error;
    }
    poems.push(poem);
    poemsById.set(poem.id, poem);
  }

  if (missingSources.length || removedEntries) {
    for (const id of missingSources) {
      console.warn(`Removing "${id}" from ${path.relative(root, poemsFile)}: source file is missing from ${path.relative(root, poemsDirectory)}.`);
    }
    await savePoemManifest();
  }
  console.log(`Loaded ${poems.length} poem${poems.length === 1 ? "" : "s"}.`);
}

async function readJson(request, maximumBytes = 16_384) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBytes) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

// A private directory per run keeps concurrent executions isolated and easy to clean up.
async function writeTemporarySource(runtime, source) {
  // Give each run its own scratch directory so cleanup cannot affect another run.
  const directory = await mkdtemp(path.join(os.tmpdir(), "codepoems-runtime-"));
  const sourcePath = path.join(directory, `source${runtime.extension}`);
  try {
    await writeFile(sourcePath, source, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return { directory, sourcePath };
}

// Validate run-time values against the saved control definitions, including step alignment.
function validateSettings(poem, input) {
  const settings = {};
  for (const control of poem.controls) {
    const value = input[control.id];
    const stepsFromMinimum = (value - control.min) / control.step;
    if (typeof value !== "number" || !Number.isFinite(value)
        || value < control.min || value > control.max
        || (control.type === "number" && !Number.isInteger(value))
        || !Number.isInteger(Math.round(stepsFromMinimum))
        || Math.abs(stepsFromMinimum - Math.round(stepsFromMinimum)) > 1e-8) {
      throw new Error(`Invalid ${control.label.toLowerCase()} value.`);
    }
    settings[control.id] = value;
  }
  return settings;
}

class RequestValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// Apply the same constraints to catalog controls and controls submitted by the upload form.
function validateControls(controls) {
  if (!Array.isArray(controls) || controls.length > 12) {
    throw new RequestValidationError("Controls must be an array with no more than 12 entries.");
  }
  const ids = new Set();
  for (const control of controls) {
    if (!control || typeof control !== "object" || Array.isArray(control)
        || typeof control.id !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(control.id)
        || ids.has(control.id)
        || typeof control.label !== "string" || !control.label.trim()
        || control.label.length > 60
        || !["number", "range"].includes(control.type)
        || !Number.isFinite(control.min) || !Number.isFinite(control.max)
        || !Number.isFinite(control.step) || !Number.isFinite(control.value)
        || control.min > control.max || control.step <= 0
        || control.value < control.min || control.value > control.max
        || (control.type === "number"
          && ![control.min, control.max, control.step, control.value].every(Number.isInteger))
        || Math.abs((control.value - control.min) / control.step
          - Math.round((control.value - control.min) / control.step)) > 1e-8) {
      throw new RequestValidationError("Each control needs a unique id, label, type, and valid min, max, step, and value.");
    }
    ids.add(control.id);
  }
  return controls;
}

// Save the source first, then publish its metadata; roll both back if catalog saving fails.
async function persistUploadedPoem(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new RequestValidationError("Request body must be a JSON object.");
  }
  const { filename, runtime: runtimeName, source } = input;
  const runtime = runtimes.get(runtimeName);
  if (typeof filename !== "string"
      || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(filename)
      || path.extname(filename).toLowerCase() !== runtime?.extension) {
    throw new RequestValidationError("Choose a filename with the extension for the selected runtime.");
  }
  if (typeof source !== "string" || !source.trim()
      || Buffer.byteLength(source, "utf8") > 1_000_000) {
    throw new RequestValidationError("Source must be non-empty and no larger than 1 MB.");
  }
  if (poemsById.has(filename)) {
    throw new RequestValidationError("A poem with that filename already exists.", 409);
  }
  const controls = validateControls(input.controls);
  const theme = input.theme === undefined ? defaultPaletteId : input.theme;
  if (typeof theme !== "string" || !paletteIds.has(theme)) {
    throw new RequestValidationError("Choose a theme from the supported palettes.");
  }
  const fitSource = input.fitSource === undefined ? true : input.fitSource;
  if (typeof fitSource !== "boolean") {
    throw new RequestValidationError("fitSource must be true or false.");
  }
  const poem = { id: filename, runtime: runtimeName, controls, theme, fitSource };

  await mkdir(poemsDirectory, { recursive: true });
  // wx makes filename creation exclusive so an existing poem can never be overwritten.
  await writeFile(path.join(poemsDirectory, filename), source, {
    encoding: "utf8",
    flag: "wx"
  });
  const saveManifest = manifestQueue.then(async () => {
    if (poemsById.has(filename)) {
      throw new RequestValidationError("A poem with that filename already exists.", 409);
    }
    poemsById.set(filename, poem);
    poems.push(poem);
    await savePoemManifest();
  });
  manifestQueue = saveManifest.catch(() => {});
  try {
    await saveManifest;
  } catch (error) {
    // Keep the source file and in-memory catalog consistent when manifest persistence fails.
    if (poemsById.get(filename) === poem) {
      poemsById.delete(filename);
      poems.splice(poems.indexOf(poem), 1);
    }
    await rm(path.join(poemsDirectory, filename), { force: true });
    throw error;
  }
  return poem;
}

function stopChild(child, stopProcessTree) {
  if (!stopProcessTree || !child.pid) {
    child.kill();
    return;
  }

  // Batch launchers such as Elixir can spawn grandchildren; stop their whole tree on Windows.
  const terminator = spawn("taskkill.exe", [
    "/PID",
    String(child.pid),
    "/T",
    "/F"
  ], { stdio: "ignore", windowsHide: true });
  terminator.once("error", error => {
    console.error(`Could not stop runtime process tree: ${error.message}`);
    child.kill();
  });
  terminator.once("close", code => {
    if (code !== 0) {
      console.error(`Could not stop runtime process tree (taskkill exited with ${code}).`);
      child.kill();
    }
  });
}

function findWindowsCommand(command) {
  if (path.isAbsolute(command) || command.includes(path.sep) || command.includes("/")) {
    return access(command).then(
      () => null,
      () => new Error(`${command} does not exist or cannot be accessed`)
    );
  }

  return new Promise(resolve => {
    const lookup = spawn("where.exe", [command], {
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true
    });
    lookup.once("error", error => resolve(error));
    lookup.once("close", code => {
      resolve(code === 0 ? null : new Error(`${command} is not on PATH`));
    });
  });
}

async function isAccessible(filename) {
  try {
    await access(filename);
    return true;
  } catch {
    return false;
  }
}

function windowsProgramDirectories(name) {
  return [...new Set([
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    "C:\\Program Files",
    "C:\\Program Files (x86)"
  ].filter(Boolean).map(directory => path.join(directory, name)))];
}

// Elixir on Windows is commonly installed as a .bat launcher, not a directly executable binary.
async function resolveElixirExecutable(runtime) {
  const override = process.env[runtime.executableEnvironmentVariable]?.trim();
  if (override) {
    const location = path.resolve(override);
    const candidates = /\.(bat|cmd|exe)$/i.test(location)
      ? [location]
      : [path.join(location, runtime.windowsCommand)];
    for (const candidate of candidates) {
      if (await isAccessible(candidate)) return candidate;
    }
    throw new Error(`${runtime.executableEnvironmentVariable} does not point to an Elixir launcher: ${location}`);
  }

  for (const directory of windowsProgramDirectories("Elixir")) {
    const candidate = path.join(directory, "bin", runtime.windowsCommand);
    if (await isAccessible(candidate)) return candidate;
  }

  const pathLookup = await findWindowsCommand(runtime.windowsCommand);
  if (!pathLookup) return runtime.windowsCommand;
  throw new Error(`Could not find ${runtime.windowsCommand}. Set ELIXIR_PATH to its full path or the Elixir bin directory.`);
}

async function resolveErlangBin() {
  const override = process.env.ERLANG_PATH?.trim();
  const candidates = [];
  if (override) {
    const location = path.resolve(override);
    if (/\.exe$/i.test(location)) {
      candidates.push(path.dirname(location));
    } else {
      candidates.push(location, path.join(location, "bin"));
    }
  } else {
    for (const directory of windowsProgramDirectories("Erlang OTP")) {
      candidates.push(path.join(directory, "bin"));
    }
    for (const directory of windowsProgramDirectories("Erlang")) {
      candidates.push(path.join(directory, "bin"));
    }
  }

  for (const directory of candidates) {
    if (await isAccessible(path.join(directory, "erl.exe"))) return directory;
  }

  if (!override && !(await findWindowsCommand("erl.exe"))) return null;
  throw new Error(override
    ? `ERLANG_PATH does not point to erl.exe or its bin directory: ${override}`
    : "Could not find erl.exe. Set ERLANG_PATH to Erlang's bin directory.");
}

// Start the selected runtime and stream both output channels to the browser response.
async function executeRuntime(response, runtime, sourcePath, settings) {
  let executable = runtime.command;
  let erlangBin;
  if (runtime.executableEnvironmentVariable && process.platform === "win32") {
    try {
      executable = await resolveElixirExecutable(runtime);
      erlangBin = await resolveErlangBin();
    } catch (error) {
      sendError(response, 503, `Elixir runtime is unavailable: ${error.message}`);
      return;
    }
  } else if (runtime.executableEnvironmentVariable) {
    executable = process.env[runtime.executableEnvironmentVariable]?.trim() || runtime.command;
  }
  const usesWindowsBatch = process.platform === "win32"
    && /\.(bat|cmd)$/i.test(executable);
  if (usesWindowsBatch && !runtime.executableEnvironmentVariable) {
    const lookupError = await findWindowsCommand(executable);
    if (lookupError) {
      sendError(response, 503, `Elixir runtime is unavailable: ${lookupError.message}. Set ELIXIR_PATH to the full path of elixir.bat.`);
      return;
    }
  }

  const args = [sourcePath];
  for (const [key, value] of Object.entries(settings)) {
    args.push(`--${key}`, key === "speed" ? value.toFixed(2) : String(value));
  }

  const command = usesWindowsBatch ? process.env.ComSpec || "cmd.exe" : executable;
  const windowsCommandLine = usesWindowsBatch
    ? `"${executable}" "${args[0]}" ${args.slice(1).join(" ")}`
    : "";
  const commandArgs = usesWindowsBatch ? ["/d", "/s", "/c", `"${windowsCommandLine}"`] : args;
  const childEnv = erlangBin
    ? { ...process.env, PATH: `${erlangBin}${path.delimiter}${process.env.PATH || ""}` }
    : process.env;
  const child = spawn(command, commandArgs, {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    windowsVerbatimArguments: Boolean(usesWindowsBatch),
    env: childEnv
  });
  await new Promise(resolve => {
    let processClosed = false;
    child.once("spawn", () => {
      response.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      });
    });
    child.stdout.on("data", chunk => response.write(chunk));
    child.stderr.on("data", chunk => response.write(chunk));
    child.once("error", error => {
      sendError(response, 500, `Could not start ${runtime.command}: ${error.message}`);
    });
    child.once("close", (code, signal) => {
      processClosed = true;
      if (code !== 0 && !response.destroyed && !response.writableEnded) {
        response.write(`\n[${runtime.command} exited with ${signal || `status ${code}`}]\n`);
      }
      if (!response.writableEnded && !response.destroyed) response.end();
      resolve();
    });
    response.once("close", () => {
      // A disconnected browser is treated like pressing Stop.
      if (!processClosed) stopChild(child, Boolean(usesWindowsBatch));
    });
  });
}

async function servePoem(request, response) {
  let input;
  try {
    input = await readJson(request, 6_100_000);
  } catch (error) {
    sendError(response, 400, `Invalid request: ${error.message}`);
    return;
  }

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    sendError(response, 400, "Request body must be a JSON object.");
    return;
  }

  const poem = poemsById.get(input.poem);
  const runtime = poem && runtimes.get(poem.runtime);
  if (!poem || !runtime) {
    sendError(response, 400, "Unknown poem.");
    return;
  }
  // Execute the submitted editor buffer rather than rereading the saved poem file.
  if (typeof input.source !== "string"
      || Buffer.byteLength(input.source, "utf8") > 1_000_000) {
    sendError(response, 400, "Source must be no larger than 1 MB.");
    return;
  }

  let settings;
  try {
    settings = validateSettings(poem, input);
  } catch (error) {
    sendError(response, 400, error.message);
    return;
  }
  let temporarySource;
  try {
    temporarySource = await writeTemporarySource(runtime, input.source);
    await executeRuntime(response, runtime, temporarySource.sourcePath, settings);
  } catch (error) {
    sendError(response, 500, `Could not run poem source: ${error.message}`);
  } finally {
    // Remove the entire scratch directory as soon as the runtime exits or stops.
    if (temporarySource) {
      await rm(temporarySource.directory, { recursive: true, force: true });
    }
  }
}

async function servePreview(request, response) {
  let input;
  try {
    input = await readJson(request, 6_100_000);
  } catch (error) {
    sendError(response, 400, `Invalid request: ${error.message}`);
    return;
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    sendError(response, 400, "Request body must be a JSON object.");
    return;
  }

  // Upload previews may run before a poem exists in the saved catalog.
  const runtime = runtimes.get(input.runtime);
  if (typeof input.filename !== "string"
      || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(input.filename)
      || path.extname(input.filename).toLowerCase() !== runtime?.extension) {
    sendError(response, 400, "Choose a filename with the extension for the selected runtime.");
    return;
  }
  if (typeof input.source !== "string" || !input.source.trim()
      || Buffer.byteLength(input.source, "utf8") > 1_000_000) {
    sendError(response, 400, "Source must be non-empty and no larger than 1 MB.");
    return;
  }

  let settings;
  try {
    const controls = validateControls(input.controls);
    settings = Object.fromEntries(controls.map(control => [control.id, control.value]));
  } catch (error) {
    sendError(response, error.status || 400, error.message);
    return;
  }

  let temporarySource;
  try {
    temporarySource = await writeTemporarySource(runtime, input.source);
    await executeRuntime(response, runtime, temporarySource.sourcePath, settings);
  } catch (error) {
    sendError(response, 500, `Could not run preview: ${error.message}`);
  } finally {
    // Preview text is temporary too; never add it to the saved poem catalog.
    if (temporarySource) {
      await rm(temporarySource.directory, { recursive: true, force: true });
    }
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");

  // Read-only catalog endpoints supply the browser's tabs and configuration selectors.
  if (request.method === "GET" && url.pathname === "/api/poems") {
    response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    });
    response.end(JSON.stringify(poems));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/runtimes") {
    response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    });
    response.end(JSON.stringify([...runtimes.values()].map(({ id, label, extension }) => ({
      id,
      label,
      extension
    }))));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/themes") {
    response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    });
    response.end(JSON.stringify(palettes));
    return;
  }

  // Persist only through this explicit upload endpoint; run and preview endpoints never save source.
  if (request.method === "POST" && url.pathname === "/api/poems") {
    let input;
    try {
      input = await readJson(request, 6_100_000);
    } catch (error) {
      sendError(response, 400, `Invalid request: ${error.message}`);
      return;
    }
    try {
      const poem = await persistUploadedPoem(input);
      response.writeHead(201, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
      });
      response.end(JSON.stringify(poem));
    } catch (error) {
      const status = error instanceof RequestValidationError
        ? error.status
        : error.code === "EEXIST" ? 409 : 500;
      sendError(response, status, `Could not save poem: ${error.message}`);
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/source") {
    const poem = poemsById.get(url.searchParams.get("poem"));
    if (!poem) {
      sendError(response, 404, "Unknown poem.");
      return;
    }
    const runtime = runtimes.get(poem.runtime);
    if (!runtime) {
      sendError(response, 404, "Source is not configured.");
      return;
    }
    try {
      const source = await readFile(path.join(poemsDirectory, poem.id));
      response.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "X-Content-Type-Options": "nosniff"
      });
      response.end(source);
    } catch (error) {
      if (error.code === "ENOENT") {
        try {
          await removePoemFromCatalog(poem.id);
          sendError(response, 404, `Poem source is missing; removed "${poem.id}" from the catalog.`);
        } catch (removeError) {
          sendError(response, 500, `Poem source is missing, but its catalog entry could not be removed: ${removeError.message}`);
        }
      } else {
        sendError(response, 500, `Could not read poem source: ${error.message}`);
      }
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/run") {
    await servePoem(request, response);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/preview") {
    await servePreview(request, response);
    return;
  }

  if (request.method === "GET" && staticFiles.has(url.pathname)) {
    const filename = staticFiles.get(url.pathname);
    try {
      const content = await readFile(path.join(root, filename));
      response.writeHead(200, {
        "Content-Type": contentTypes.get(path.extname(filename)),
        "X-Content-Type-Options": "nosniff"
      });
      response.end(content);
    } catch (error) {
      sendError(response, 500, `Could not read ${filename}: ${error.message}`);
    }
    return;
  }

  sendError(response, 404, "Not found.");
});

const port = Number(process.env.PORT || 4173);
// Load and validate the catalog before accepting requests so startup failures are explicit.
loadPoemCatalog().then(() => {
  server.listen(port, "127.0.0.1", () => {
    console.log(`Poem interpreter ready at http://127.0.0.1:${port}`);
  });
}).catch(error => {
  console.error(`Could not initialize poem catalog: ${error.message}`);
  process.exitCode = 1;
});
