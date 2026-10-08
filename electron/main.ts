import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { ImportItem, LinkRecord, NoteRecord, Snapshot } from "./preload";

protocol.registerSchemesAsPrivileged([
  { scheme: "ferretation-attachment", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

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
}

function setRoot(root: string) {
  libraryRoot = root;
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.join(root, projectRootName), { recursive: true });
  fs.mkdirSync(path.join(root, "Trash"), { recursive: true });
  ensureProject(UNASSIGNED);
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
  fs.mkdirSync(path.join(directory, "Notes"), { recursive: true });
  fs.mkdirSync(path.join(directory, "Files"), { recursive: true });
  fs.mkdirSync(path.join(directory, "Attachments"), { recursive: true });
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

function filesIn(directory: string, relative = ""): string[] {
  const output: string[] = [];
  for (const entry of safeReadDir(directory)) {
    if (entry.name.startsWith(".")) continue;
    const childRelative = path.join(relative, entry.name);
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...filesIn(fullPath, childRelative));
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
    const notesDir = path.join(projectDir(project), "Notes");
    for (const file of safeReadDir(notesDir)) {
      if (!file.isFile() || !file.name.toLowerCase().endsWith(".md")) continue;
      const fullPath = path.join(notesDir, file.name);
      try {
        const parsed = parseNoteFile(fs.readFileSync(fullPath, "utf8"));
        const data = parsed.data as Record<string, unknown>;
        const id = typeof data.id === "string" ? data.id : file.name;
        const attachmentPath = path.join(projectDir(project), "Attachments", id);
        notes.push({
          id,
          title: typeof data.title === "string" ? data.title : file.name.replace(/\.md$/i, ""),
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
          attachmentsPath: attachmentPath,
          attachments: filesIn(attachmentPath),
          fileNameMismatch: file.name !== expectedNoteFilename(
            typeof data.title === "string" ? data.title : file.name.replace(/\.md$/i, ""),
            id,
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
      const noteFile = safeReadDir(directory).find((entry) => entry.isFile() && entry.name.endsWith(".md"));
      if (!noteFile) continue;
      const fullPath = path.join(directory, noteFile.name);
      const parsed = parseNoteFile(fs.readFileSync(fullPath, "utf8"));
      const data = parsed.data as Record<string, unknown>;
      const id = typeof data.id === "string" ? data.id : folder.name;
      notes.push({
        id,
        title: typeof data.title === "string" ? data.title : noteFile.name,
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
        attachmentsPath: path.join(directory, "Attachments"),
        attachments: filesIn(path.join(directory, "Attachments")),
        fileNameMismatch: noteFile.name !== expectedNoteFilename(
          typeof data.title === "string" ? data.title : noteFile.name.replace(/\.md$/i, ""),
          id,
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
  const indexedFiles = projectNames().flatMap((project) => {
    const filesRoot = path.join(projectDir(project), "Files");
    return filesIn(filesRoot).map((relativePath) => {
      const fullPath = path.join(filesRoot, relativePath);
      const extension = path.extname(relativePath).toLowerCase();
      let content = "";
      let contentTruncated = false;
      if ([".txt", ".md", ".log", ".json", ".csv", ".yaml", ".yml"].includes(extension)) {
        let fileDescriptor: number | undefined;
        try {
          const stat = fs.statSync(fullPath);
          fileDescriptor = fs.openSync(fullPath, "r");
          const size = Math.min(stat.size, 500_000);
          const buffer = Buffer.alloc(size);
          fs.readSync(fileDescriptor, buffer, 0, size, 0);
          content = buffer.toString("utf8");
          contentTruncated = stat.size > size;
        } catch (error) {
          console.error(`Could not index file ${fullPath}:`, error);
        } finally {
          if (fileDescriptor !== undefined) fs.closeSync(fileDescriptor);
        }
      }
      return { project, path: relativePath, content, contentTruncated };
    });
  });
  return {
    root: libraryRoot,
    projects: projectNames().map((name) => ({
      name,
      notes: notes.filter((note) => note.project === name && !note.deleted).length,
      files: filesIn(path.join(projectDir(name), "Files")),
    })),
    notes,
    noteTypes: [...new Set(["Feature", "Test", "UAT", "Fix", "Incident", "Data request", "Random", ...types])],
    indexedFiles,
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

function expectedNoteFilename(title: string, id: string) {
  return `${titleSlug(title)}--${id.slice(0, 8)}.md`;
}

function notePath(project: string, title: string, id: string) {
  return path.join(projectDir(project), "Notes", expectedNoteFilename(title, id));
}

function assertUniqueNote(id: string, targetPath: string) {
  const collision = noteRecords().find((note) => note.id === id && note.path !== targetPath);
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
    if (filesIn(directory).length > 0) throw new Error("Move or delete all Project files before deleting this Project.");
    fs.rmSync(directory, { recursive: true });
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
      attachments: [],
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
    const attachmentSource = path.join(projectDir(project), "Attachments", note.id);
    const attachmentTarget = path.join(projectDir(project), "Attachments", id);
    if (fs.existsSync(attachmentSource)) {
      const staging = `${attachmentTarget}.recover-${randomUUID()}`;
      try {
        copySupportingEntry(attachmentSource, staging);
        fs.renameSync(staging, attachmentTarget);
      } catch (error) {
        if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
        throw error;
      }
    }
    const recovered: NoteRecord = {
      ...note,
      id,
      project,
      updatedAt: now,
      body: note.body.replaceAll(`../Attachments/${note.id}/`, `../Attachments/${id}/`),
      path: "",
      deleted: false,
      attachmentsPath: attachmentTarget,
      attachments: fs.existsSync(attachmentTarget) ? filesIn(attachmentTarget) : [],
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
    const titleChanged = note.title !== current.title;
    const target = titleChanged
      ? notePath(note.project, note.title, note.id)
      : path.join(projectDir(note.project), "Notes", path.basename(current.path));
    assertUniqueNote(note.id, target);
    const previousProject = current.project;
    const nextAttachments = path.join(projectDir(note.project), "Attachments", note.id);
    if (previousProject !== note.project && fs.existsSync(current.attachmentsPath!) && fs.existsSync(nextAttachments)) {
      throw new Error("Attachments already exist in the destination Project.");
    }
    if (path.resolve(current.path) !== path.resolve(target)) {
      if (fs.existsSync(target)) throw new Error("A file with this title already exists.");
      fs.renameSync(current.path, target);
    }
    if (previousProject !== note.project && fs.existsSync(current.attachmentsPath!)) {
      fs.renameSync(current.attachmentsPath!, nextAttachments);
    }
    const updated = {
      ...note,
      updatedAt: new Date().toISOString(),
      attachmentsPath: nextAttachments,
      attachments: filesIn(nextAttachments),
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
    const attachments = note.attachmentsPath!;
    if (fs.existsSync(attachments)) fs.renameSync(attachments, path.join(trashEntry, "Attachments"));
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
    const trashedAttachments = path.join(trashEntry, "Attachments");
    if (fs.existsSync(trashedAttachments)) {
      const destination = path.join(projectDir(targetProject), "Attachments", id);
      if (fs.existsSync(destination)) throw new Error("Attachments already exist at the restore destination.");
      fs.renameSync(trashedAttachments, destination);
    }
    fs.rmSync(trashEntry, { recursive: true });
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
      if (![".md", ".txt"].includes(path.extname(item.path).toLowerCase())) {
        throw new Error(`${path.basename(item.path)} is not a Markdown or text file.`);
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
        attachments: [],
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
      filters: [{ name: "Notes", extensions: ["md", "txt"] }],
    });
    return result.canceled ? [] : result.filePaths;
  });
  ipcMain.handle("files:add", async (_event, project: string) => {
    if (!projectNames().includes(project)) throw new Error("Choose an existing Project.");
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: `Add files to ${project}`,
      properties: ["openFile", "openDirectory", "multiSelections"],
    });
    if (result.canceled) return 0;
    for (const file of result.filePaths) {
      const target = path.join(projectDir(project), "Files", path.basename(file));
      if (fs.existsSync(target)) throw new Error(`${path.basename(file)} already exists in this Project.`);
      const staging = `${target}.import-${randomUUID()}`;
      try {
        copySupportingEntry(file, staging);
        fs.renameSync(staging, target);
      } catch (error) {
        if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
        throw error;
      }
    }
    notifyChanged();
    return result.filePaths.length;
  });
  ipcMain.handle("files:open", async (_event, target: string) => {
    if (!libraryRoot || !path.resolve(target).startsWith(path.resolve(libraryRoot) + path.sep)) {
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
  ipcMain.handle("attachment:add", async (_event, id: string) => {
    const note = noteRecords().find((candidate) => candidate.id === id && !candidate.deleted);
    if (!note) throw new Error("Note not found.");
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: "Add attachment to note",
      properties: ["openFile", "multiSelections"],
    });
    if (result.canceled) return null;
    const directory = note.attachmentsPath!;
    fs.mkdirSync(directory, { recursive: true });
    const references: string[] = [];
    for (const file of result.filePaths) {
      let filename = path.basename(file);
      if (fs.existsSync(path.join(directory, filename))) {
        filename = `${path.parse(filename).name}-${randomUUID().slice(0, 8)}${path.extname(filename)}`;
      }
      fs.copyFileSync(file, path.join(directory, filename), fs.constants.COPYFILE_EXCL);
      references.push(`![${path.parse(filename).name}](../Attachments/${id}/${encodeURIComponent(filename)})`);
    }
    notifyChanged();
    return references.join("\n");
  });
}

function copySupportingEntry(source: string, destination: string) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error(`Symbolic links cannot be copied into the library: ${source}`);
  if (stat.isDirectory()) {
    fs.mkdirSync(destination);
    for (const entry of fs.readdirSync(source)) {
      copySupportingEntry(path.join(source, entry), path.join(destination, entry));
    }
    return;
  }
  if (!stat.isFile()) throw new Error(`Unsupported file type: ${source}`);
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 960,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: "#111318",
    title: "Ferretations",
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
  protocol.handle("ferretation-attachment", (request) => {
    const url = new URL(request.url);
    const id = path.basename(decodeURIComponent(url.hostname));
    const filename = path.basename(decodeURIComponent(url.pathname).replace(/^\/+/, ""));
    const attachment = path.join(libraryRoot || "", projectRootName);
    const match = noteRecords().find((note) => note.id === id && !note.deleted);
    if (!match || !filename) return new Response("Not found", { status: 404 });
    const target = path.join(attachment, match.project, "Attachments", id, filename);
    if (!fs.existsSync(target)) return new Response("Not found", { status: 404 });
    return net.fetch(pathToFileURL(target).toString());
  });
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
