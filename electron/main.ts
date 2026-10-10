import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { ImportItem, LinkRecord, NoteRecord, Snapshot } from "./preload";

const UNASSIGNED = "Unassigned";
const projectRootName = "Projects";
let mainWindow: BrowserWindow | null = null;
let libraryRoot: string | null = null;
let watcher: fs.FSWatcher | null = null;
let changeTimer: NodeJS.Timeout | undefined;

function settingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function loadRoot() {
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath(), "utf8")) as {
      root?: string;
    };
    libraryRoot = settings.root && fs.existsSync(settings.root) ? settings.root : null;
  } catch {
    libraryRoot = null;
  }
  if (libraryRoot) {
    fs.mkdirSync(path.join(libraryRoot, projectRootName), { recursive: true });
    ensureProject(UNASSIGNED);
    for (const project of projectNames()) ensureProject(project);
  }
}

function setRoot(root: string) {
  libraryRoot = root;
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.join(root, projectRootName), { recursive: true });
  fs.mkdirSync(path.join(root, "Trash"), { recursive: true });
  ensureProject(UNASSIGNED);
  for (const project of projectNames()) ensureProject(project);
  fs.writeFileSync(settingsPath(), JSON.stringify({ root }, null, 2));
  watchRoot();
}

function safeName(value: string) {
  const trimmed = value.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-");
  if (!trimmed || trimmed === "." || trimmed === "..") {
    throw new Error("Enter a valid name.");
  }
  return trimmed;
}

function projectsDir() {
  if (!libraryRoot) throw new Error("Choose a library folder first.");
  return path.join(libraryRoot, projectRootName);
}

function projectDir(name: string) {
  return path.join(projectsDir(), name);
}

function ensureProject(name: string) {
  const directory = projectDir(name);
  fs.mkdirSync(directory, { recursive: true });
  const legacyNotesDirectory = path.join(directory, "Notes");
  for (const note of safeReadDir(legacyNotesDirectory)) {
    if (!note.isFile() || ![".md", ".txt"].includes(path.extname(note.name).toLowerCase())) continue;
    const source = path.join(legacyNotesDirectory, note.name);
    const destination = path.join(directory, note.name);
    if (!fs.existsSync(destination)) fs.renameSync(source, destination);
  }
  for (const legacyDirectory of [legacyNotesDirectory, path.join(directory, "Files"), path.join(directory, "Attachments")]) {
    removeEmptyDirectories(legacyDirectory);
  }
  return directory;
}

function notifyChanged() {
  if (changeTimer) clearTimeout(changeTimer);
  changeTimer = setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("workspace:changed");
    }
  }, 180);
}

function watchRoot() {
  watcher?.close();
  if (!libraryRoot) return;
  try {
    watcher = fs.watch(libraryRoot, { recursive: true }, notifyChanged);
    watcher.on("error", (error) => {
      console.error("Library watcher failed:", error);
      watcher?.close();
      watcher = null;
    });
  } catch (error) {
    console.error("Could not watch library folder:", error);
    watcher = null;
  }
}

function safeReadDir(directory: string): fs.Dirent[] {
  try {
    return fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

function removeEmptyDirectories(directory: string) {
  if (!fs.existsSync(directory)) return;
  for (const entry of safeReadDir(directory)) {
    if (entry.isDirectory()) removeEmptyDirectories(path.join(directory, entry.name));
  }
  if (safeReadDir(directory).length === 0) fs.rmdirSync(directory);
}

function filesIn(directory: string, relative = "", includeHidden = false): string[] {
  const output: string[] = [];
  for (const entry of safeReadDir(directory)) {
    if (!includeHidden && entry.name.startsWith(".")) continue;
    const childRelative = path.join(relative, entry.name);
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...filesIn(fullPath, childRelative, includeHidden));
    else output.push(childRelative);
  }
  return output;
}

function projectNames(): string[] {
  return safeReadDir(projectsDir())
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

function noteRecords(): NoteRecord[] {
  if (!libraryRoot) return [];
  const notes: NoteRecord[] = [];
  for (const project of projectNames()) {
    const directory = projectDir(project);
    const noteFiles = [directory, path.join(directory, "Notes")].flatMap((notesDirectory) =>
      safeReadDir(notesDirectory)
        .filter((file) => file.isFile() && [".md", ".txt"].includes(path.extname(file.name).toLowerCase()))
        .map((file) => path.join(notesDirectory, file.name)),
    );
    for (const fullPath of noteFiles) {
      const filename = path.basename(fullPath);
      try {
        const parsed = parseNoteFile(fs.readFileSync(fullPath, "utf8"));
        const data = parsed.data as Record<string, unknown>;
        const id = typeof data.id === "string" ? data.id : filename;
        notes.push({
          id,
          title: typeof data.title === "string" ? data.title : filename.replace(/\.(md|txt)$/i, ""),
          project,
          type: typeof data.type === "string" ? data.type : "",
          tags: Array.isArray(data.tags) ? data.tags.filter((tag): tag is string => typeof tag === "string") : [],
          status: data.status === "Completed" || data.status === "Archived" ? data.status : "Active",
          workItemId: typeof data.workItemId === "string" ? data.workItemId : "",
          branch: typeof data.branch === "string" ? data.branch : "",
          baseBranch: typeof data.baseBranch === "string" ? data.baseBranch : "",
          prs: parseLinks(data.prs),
          docs: parseLinks(data.docs),
          createdAt: typeof data.createdAt === "string" ? data.createdAt : fs.statSync(fullPath).birthtime.toISOString(),
          updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : fs.statSync(fullPath).mtime.toISOString(),
          body: parsed.content,
          path: fullPath,
          deleted: false,
          fileNameMismatch: filename !== expectedNoteFilename(
            typeof data.title === "string" ? data.title : filename.replace(/\.(md|txt)$/i, ""),
            id,
            path.extname(filename),
          ),
        });
      } catch (error) {
        console.error(`Could not read note ${fullPath}:`, error);
      }
    }
  }
  const trashDir = path.join(libraryRoot, "Trash");
  for (const folder of safeReadDir(trashDir)) {
    if (!folder.isDirectory()) continue;
    const directory = path.join(trashDir, folder.name);
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8")) as {
        originalProject: string;
      };
      const noteFile = safeReadDir(directory).find((entry) => entry.isFile() && [".md", ".txt"].includes(path.extname(entry.name).toLowerCase()));
      if (!noteFile) continue;
      const fullPath = path.join(directory, noteFile.name);
      const parsed = parseNoteFile(fs.readFileSync(fullPath, "utf8"));
      const data = parsed.data as Record<string, unknown>;
      const id = typeof data.id === "string" ? data.id : folder.name;
      notes.push({
        id,
        title: typeof data.title === "string" ? data.title : noteFile.name.replace(/\.(md|txt)$/i, ""),
        project: manifest.originalProject,
        type: typeof data.type === "string" ? data.type : "",
        tags: Array.isArray(data.tags) ? data.tags.filter((tag): tag is string => typeof tag === "string") : [],
        status: data.status === "Completed" || data.status === "Archived" ? data.status : "Active",
        workItemId: typeof data.workItemId === "string" ? data.workItemId : "",
        branch: typeof data.branch === "string" ? data.branch : "",
        baseBranch: typeof data.baseBranch === "string" ? data.baseBranch : "",
        prs: parseLinks(data.prs),
        docs: parseLinks(data.docs),
        createdAt: typeof data.createdAt === "string" ? data.createdAt : fs.statSync(fullPath).birthtime.toISOString(),
        updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : fs.statSync(fullPath).mtime.toISOString(),
        body: parsed.content,
        path: fullPath,
        deleted: true,
        originalProject: manifest.originalProject,
        fileNameMismatch: noteFile.name !== expectedNoteFilename(
          typeof data.title === "string" ? data.title : noteFile.name.replace(/\.(md|txt)$/i, ""),
          id,
          path.extname(noteFile.name),
        ),
      });
    } catch (error) {
      console.error(`Could not read trash entry ${folder.name}:`, error);
    }
  }
  return notes;
}

function parseLinks(value: unknown): LinkRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((link) => {
    if (!link || typeof link !== "object") return [];
    const item = link as Record<string, unknown>;
    return typeof item.url === "string"
      ? [{ label: typeof item.label === "string" ? item.label : "", url: item.url }]
      : [];
  });
}

function getSnapshot(): Snapshot {
  if (!libraryRoot) throw new Error("Choose a library folder first.");
  const notes = noteRecords();
  const types = notes.map((note) => note.type).filter(Boolean);
  return {
    root: libraryRoot,
    projects: projectNames().map((name) => ({
      name,
      notes: notes.filter((note) => note.project === name && !note.deleted).length,
    })),
    notes,
    noteTypes: [...new Set(["Feature", "Test", "UAT", "Fix", "Incident", "Data request", "Random", ...types])],
  };
}

function makeNoteFile(note: NoteRecord) {
  const metadata = {
    id: note.id,
    title: note.title,
    type: note.type || null,
    tags: note.tags,
    status: note.status,
    workItemId: note.workItemId,
    branch: note.branch,
    baseBranch: note.baseBranch,
    prs: note.prs,
    docs: note.docs,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
  };
  return `---\n${stringifyYaml(metadata).trimEnd()}\n---\n${note.body}`;
}

function parseNoteFile(content: string) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) return { data: {}, content };
  const data: unknown = parseYaml(match[1]);
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Note YAML frontmatter must be a mapping.");
  }
  return {
    data: data as Record<string, unknown>,
    content: content.slice(match[0].length),
  };
}

function titleSlug(title: string) {
  const slug = safeName(title.trim() || "Untitled note")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70) || "note";
  return slug;
}

function expectedNoteFilename(title: string, id: string, extension = ".txt") {
  return `${titleSlug(title)}--${id.slice(0, 8)}${extension}`;
}

function notePath(project: string, title: string, id: string) {
  return path.join(projectDir(project), expectedNoteFilename(title, id));
}

function assertUniqueNote(id: string, targetPath: string, currentPath: string) {
  const collision = noteRecords().find((note) =>
    note.id === id && note.path !== targetPath && note.path !== currentPath,
  );
  if (collision) throw new Error(`A note with id ${id} already exists.`);
}

async function chooseRoot() {
  const result = await dialog.showOpenDialog(mainWindow!, {
    title: "Choose your notes library folder",
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  setRoot(result.filePaths[0]);
  return libraryRoot;
}

function registerHandlers() {
  ipcMain.handle("workspace:get-root", () => libraryRoot);
  ipcMain.handle("workspace:choose-root", chooseRoot);
  ipcMain.handle("workspace:get-snapshot", getSnapshot);
  ipcMain.handle("project:create", (_event, rawName: string) => {
    const name = safeName(rawName);
    if (name === UNASSIGNED) throw new Error("Unassigned is already provided.");
    if (fs.existsSync(projectDir(name))) throw new Error("A Project with that name already exists.");
    ensureProject(name);
    notifyChanged();
  });
  ipcMain.handle("project:rename", (_event, oldName: string, rawName: string) => {
    if (oldName === UNASSIGNED) throw new Error("Unassigned cannot be renamed.");
    const nextName = safeName(rawName);
    if (oldName === nextName) return;
    const from = projectDir(oldName);
    const to = projectDir(nextName);
    if (!fs.existsSync(from)) throw new Error("Project not found.");
    if (fs.existsSync(to)) throw new Error("A Project with that name already exists.");
    fs.renameSync(from, to);
    notifyChanged();
  });
  ipcMain.handle("project:delete", (_event, name: string) => {
    if (name === UNASSIGNED) throw new Error("Unassigned cannot be deleted.");
    const directory = projectDir(name);
    if (!fs.existsSync(directory)) throw new Error("Project not found.");
    const notes = noteRecords().filter((note) => note.project === name && !note.deleted);
    const managedFiles = new Set(notes.map((note) => path.relative(directory, note.path)));
    const otherFiles = filesIn(directory, "", true).filter((file) => !managedFiles.has(file));
    if (otherFiles.length > 0) throw new Error("This Project contains non-note files. Move them elsewhere before deleting the Project.");

    const unassignedDirectory = ensureProject(UNASSIGNED);
    const moves: { source: string; destination: string }[] = [];
    const destinations = new Set<string>();
    const addMove = (source: string, destination: string) => {
      if (fs.existsSync(destination) || destinations.has(destination)) {
        throw new Error("A note with the same filename already exists in Unassigned.");
      }
      destinations.add(destination);
      moves.push({ source, destination });
    };
    for (const note of notes) {
      const target = path.join(unassignedDirectory, path.basename(note.path));
      assertUniqueNote(note.id, target, note.path);
      addMove(note.path, target);
    }

    const completedMoves: typeof moves = [];
    try {
      for (const move of moves) {
        fs.renameSync(move.source, move.destination);
        completedMoves.push(move);
      }
    } catch (error) {
      for (const move of completedMoves.reverse()) {
        if (fs.existsSync(move.destination) && !fs.existsSync(move.source)) {
          fs.mkdirSync(path.dirname(move.source), { recursive: true });
          fs.renameSync(move.destination, move.source);
        }
      }
      throw error;
    }
    removeEmptyDirectories(directory);
    notifyChanged();
  });
  ipcMain.handle("note:create", (_event, project: string) => {
    if (!projectNames().includes(project)) throw new Error("Choose an existing Project.");
    const now = new Date();
    const title = now.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    const note: NoteRecord = {
      id: randomUUID(),
      title,
      project,
      type: "",
      tags: [],
      status: "Active",
      workItemId: "",
      branch: "",
      baseBranch: "",
      prs: [],
      docs: [],
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      body: "",
      path: "",
      deleted: false,
      fileNameMismatch: false,
    };
    const target = notePath(project, title, note.id);
    fs.writeFileSync(target, makeNoteFile(note), { flag: "wx" });
    notifyChanged();
    return { ...note, path: target };
  });
  ipcMain.handle("note:recover", (_event, note: NoteRecord) => {
    const project = projectNames().includes(note.project) ? note.project : UNASSIGNED;
    ensureProject(project);
    const id = randomUUID();
    const now = new Date().toISOString();
    const recovered: NoteRecord = {
      ...note,
      id,
      project,
      updatedAt: now,
      path: "",
      deleted: false,
      fileNameMismatch: false,
    };
    const target = notePath(project, recovered.title, id);
    fs.writeFileSync(target, makeNoteFile(recovered), { flag: "wx" });
    notifyChanged();
    return { ...recovered, path: target };
  });
  ipcMain.handle("note:save", (_event, note: NoteRecord) => {
    if (note.deleted) throw new Error("Restore this note before editing it.");
    const current = noteRecords().find((candidate) => candidate.id === note.id && !candidate.deleted);
    if (!current) throw new Error("This note no longer exists in the library.");
    if (!projectNames().includes(note.project)) throw new Error("The note's Project no longer exists.");
    const target = notePath(note.project, note.title, note.id);
    assertUniqueNote(note.id, target, current.path);
    if (path.resolve(current.path) !== path.resolve(target)) {
      if (fs.existsSync(target)) throw new Error("A file with this title already exists.");
      fs.renameSync(current.path, target);
    }
    const updated = {
      ...note,
      updatedAt: new Date().toISOString(),
      fileNameMismatch: path.basename(target) !== expectedNoteFilename(note.title, note.id),
    };
    fs.writeFileSync(target, makeNoteFile(updated));
    notifyChanged();
    return { ...updated, path: target };
  });
  ipcMain.handle("note:delete", (_event, id: string) => {
    const note = noteRecords().find((candidate) => candidate.id === id && !candidate.deleted);
    if (!note) throw new Error("Note not found.");
    const trashEntry = path.join(libraryRoot!, "Trash", `${id}-${randomUUID().slice(0, 8)}`);
    fs.mkdirSync(trashEntry, { recursive: true });
    fs.renameSync(note.path, path.join(trashEntry, path.basename(note.path)));
    fs.writeFileSync(path.join(trashEntry, "manifest.json"), JSON.stringify({ originalProject: note.project }, null, 2));
    notifyChanged();
  });
  ipcMain.handle("note:restore", (_event, id: string) => {
    const note = noteRecords().find((candidate) => candidate.id === id && candidate.deleted);
    if (!note) throw new Error("Trashed note not found.");
    const trashEntry = path.dirname(note.path);
    const targetProject = projectNames().includes(note.originalProject || note.project)
      ? note.originalProject || note.project
      : UNASSIGNED;
    ensureProject(targetProject);
    const target = notePath(targetProject, note.title, note.id);
    if (fs.existsSync(target)) throw new Error("A note with the same filename already exists in that Project.");
    fs.renameSync(note.path, target);
    fs.rmSync(path.join(trashEntry, "manifest.json"), { force: true });
    removeEmptyDirectories(path.join(trashEntry, "Attachments"));
    if (safeReadDir(trashEntry).length === 0) fs.rmdirSync(trashEntry);
    notifyChanged();
  });
  ipcMain.handle("trash:empty", () => {
    const trashDir = path.join(libraryRoot!, "Trash");
    for (const entry of safeReadDir(trashDir)) {
      fs.rmSync(path.join(trashDir, entry.name), { recursive: true, force: true });
    }
    notifyChanged();
  });
  ipcMain.handle("import:notes", (_event, items: ImportItem[]) => {
    let imported = 0;
    for (const item of items) {
      if (!projectNames().includes(item.project)) throw new Error(`Choose a valid Project for ${path.basename(item.path)}.`);
      if (path.extname(item.path).toLowerCase() !== ".txt") {
        throw new Error(`${path.basename(item.path)} is not a text file.`);
      }
      const stat = fs.statSync(item.path);
      const date = stat.birthtimeMs > 0 ? stat.birthtime : stat.mtime;
      const id = randomUUID();
      const title = path.basename(item.path, path.extname(item.path));
      const note: NoteRecord = {
        id, title, project: item.project, type: "", tags: [], status: "Active",
        workItemId: "", branch: "", baseBranch: "", prs: [], docs: [],
        createdAt: date.toISOString(), updatedAt: date.toISOString(),
        body: fs.readFileSync(item.path, "utf8"), path: "", deleted: false,
        fileNameMismatch: false,
      };
      const target = notePath(item.project, title, id);
      fs.writeFileSync(target, makeNoteFile(note), { flag: "wx" });
      imported += 1;
    }
    notifyChanged();
    return imported;
  });
  ipcMain.handle("import:choose-files", async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: "Import notes",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Text notes", extensions: ["txt"] }],
    });
    return result.canceled ? [] : result.filePaths;
  });
  ipcMain.handle("files:open", async (_event, target: string) => {
    const resolvedRoot = libraryRoot ? path.resolve(libraryRoot) : "";
    const resolvedTarget = path.resolve(target);
    if (!resolvedRoot || (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`))) {
      throw new Error("Only files inside this library can be opened.");
    }
    const error = await shell.openPath(target);
    if (error) throw new Error(error);
  });
  ipcMain.handle("links:open-external", async (_event, value: string) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error("Enter a valid web URL first.");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error("Only HTTP and HTTPS links can be opened.");
    }
    await shell.openExternal(url.toString());
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 960,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: "#111318",
    title: "Super Weird Notes",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const developmentUrl = process.env.VITE_DEV_SERVER_URL;
    const productionUrl = pathToFileURL(path.join(__dirname, "../dist/index.html")).toString();
    if (
      (developmentUrl && (url === developmentUrl || url.startsWith(`${developmentUrl}/#`))) ||
      url === productionUrl ||
      url.startsWith(`${productionUrl}#`)
    ) return;
    event.preventDefault();
    if (url.startsWith("https://") || url.startsWith("http://")) void shell.openExternal(url);
  });
  if (process.env.VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }

}

app.whenReady().then(() => {
  loadRoot();
  if (libraryRoot) watchRoot();
  registerHandlers();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => watcher?.close());
