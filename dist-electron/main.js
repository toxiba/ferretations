"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const node_url_1 = require("node:url");
const node_crypto_1 = require("node:crypto");
const yaml_1 = require("yaml");
electron_1.protocol.registerSchemesAsPrivileged([
    { scheme: "ferretation-attachment", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
const UNASSIGNED = "Unassigned";
const projectRootName = "Projects";
let mainWindow = null;
let libraryRoot = null;
let watcher = null;
let changeTimer;
function settingsPath() {
    return node_path_1.default.join(electron_1.app.getPath("userData"), "settings.json");
}
function loadRoot() {
    try {
        const settings = JSON.parse(node_fs_1.default.readFileSync(settingsPath(), "utf8"));
        libraryRoot = settings.root && node_fs_1.default.existsSync(settings.root) ? settings.root : null;
    }
    catch {
        libraryRoot = null;
    }
}
function setRoot(root) {
    libraryRoot = root;
    node_fs_1.default.mkdirSync(root, { recursive: true });
    node_fs_1.default.mkdirSync(node_path_1.default.join(root, projectRootName), { recursive: true });
    node_fs_1.default.mkdirSync(node_path_1.default.join(root, "Trash"), { recursive: true });
    ensureProject(UNASSIGNED);
    node_fs_1.default.writeFileSync(settingsPath(), JSON.stringify({ root }, null, 2));
    watchRoot();
}
function safeName(value) {
    const trimmed = value.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-");
    if (!trimmed || trimmed === "." || trimmed === "..") {
        throw new Error("Enter a valid name.");
    }
    return trimmed;
}
function projectsDir() {
    if (!libraryRoot)
        throw new Error("Choose a library folder first.");
    return node_path_1.default.join(libraryRoot, projectRootName);
}
function projectDir(name) {
    return node_path_1.default.join(projectsDir(), name);
}
function ensureProject(name) {
    const directory = projectDir(name);
    node_fs_1.default.mkdirSync(node_path_1.default.join(directory, "Notes"), { recursive: true });
    node_fs_1.default.mkdirSync(node_path_1.default.join(directory, "Files"), { recursive: true });
    node_fs_1.default.mkdirSync(node_path_1.default.join(directory, "Attachments"), { recursive: true });
    return directory;
}
function notifyChanged() {
    if (changeTimer)
        clearTimeout(changeTimer);
    changeTimer = setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("workspace:changed");
        }
    }, 180);
}
function watchRoot() {
    watcher?.close();
    if (!libraryRoot)
        return;
    try {
        watcher = node_fs_1.default.watch(libraryRoot, { recursive: true }, notifyChanged);
        watcher.on("error", (error) => {
            console.error("Library watcher failed:", error);
            watcher?.close();
            watcher = null;
        });
    }
    catch (error) {
        console.error("Could not watch library folder:", error);
        watcher = null;
    }
}
function safeReadDir(directory) {
    try {
        return node_fs_1.default.readdirSync(directory, { withFileTypes: true });
    }
    catch {
        return [];
    }
}
function filesIn(directory, relative = "", includeHidden = false) {
    const output = [];
    for (const entry of safeReadDir(directory)) {
        if (!includeHidden && entry.name.startsWith("."))
            continue;
        const childRelative = node_path_1.default.join(relative, entry.name);
        const fullPath = node_path_1.default.join(directory, entry.name);
        if (entry.isDirectory())
            output.push(...filesIn(fullPath, childRelative, includeHidden));
        else
            output.push(childRelative);
    }
    return output;
}
function projectNames() {
    return safeReadDir(projectsDir())
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b));
}
function noteRecords() {
    if (!libraryRoot)
        return [];
    const notes = [];
    for (const project of projectNames()) {
        const notesDir = node_path_1.default.join(projectDir(project), "Notes");
        for (const file of safeReadDir(notesDir)) {
            if (!file.isFile() || !file.name.toLowerCase().endsWith(".md"))
                continue;
            const fullPath = node_path_1.default.join(notesDir, file.name);
            try {
                const parsed = parseNoteFile(node_fs_1.default.readFileSync(fullPath, "utf8"));
                const data = parsed.data;
                const id = typeof data.id === "string" ? data.id : file.name;
                const attachmentPath = node_path_1.default.join(projectDir(project), "Attachments", id);
                notes.push({
                    id,
                    title: typeof data.title === "string" ? data.title : file.name.replace(/\.md$/i, ""),
                    project,
                    type: typeof data.type === "string" ? data.type : "",
                    tags: Array.isArray(data.tags) ? data.tags.filter((tag) => typeof tag === "string") : [],
                    status: data.status === "Completed" || data.status === "Archived" ? data.status : "Active",
                    workItemId: typeof data.workItemId === "string" ? data.workItemId : "",
                    branch: typeof data.branch === "string" ? data.branch : "",
                    baseBranch: typeof data.baseBranch === "string" ? data.baseBranch : "",
                    prs: parseLinks(data.prs),
                    docs: parseLinks(data.docs),
                    createdAt: typeof data.createdAt === "string" ? data.createdAt : node_fs_1.default.statSync(fullPath).birthtime.toISOString(),
                    updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : node_fs_1.default.statSync(fullPath).mtime.toISOString(),
                    body: parsed.content,
                    path: fullPath,
                    deleted: false,
                    attachmentsPath: attachmentPath,
                    attachments: filesIn(attachmentPath),
                    fileNameMismatch: file.name !== expectedNoteFilename(typeof data.title === "string" ? data.title : file.name.replace(/\.md$/i, ""), id),
                });
            }
            catch (error) {
                console.error(`Could not read note ${fullPath}:`, error);
            }
        }
    }
    const trashDir = node_path_1.default.join(libraryRoot, "Trash");
    for (const folder of safeReadDir(trashDir)) {
        if (!folder.isDirectory())
            continue;
        const directory = node_path_1.default.join(trashDir, folder.name);
        try {
            const manifest = JSON.parse(node_fs_1.default.readFileSync(node_path_1.default.join(directory, "manifest.json"), "utf8"));
            const noteFile = safeReadDir(directory).find((entry) => entry.isFile() && entry.name.endsWith(".md"));
            if (!noteFile)
                continue;
            const fullPath = node_path_1.default.join(directory, noteFile.name);
            const parsed = parseNoteFile(node_fs_1.default.readFileSync(fullPath, "utf8"));
            const data = parsed.data;
            const id = typeof data.id === "string" ? data.id : folder.name;
            notes.push({
                id,
                title: typeof data.title === "string" ? data.title : noteFile.name,
                project: manifest.originalProject,
                type: typeof data.type === "string" ? data.type : "",
                tags: Array.isArray(data.tags) ? data.tags.filter((tag) => typeof tag === "string") : [],
                status: data.status === "Completed" || data.status === "Archived" ? data.status : "Active",
                workItemId: typeof data.workItemId === "string" ? data.workItemId : "",
                branch: typeof data.branch === "string" ? data.branch : "",
                baseBranch: typeof data.baseBranch === "string" ? data.baseBranch : "",
                prs: parseLinks(data.prs),
                docs: parseLinks(data.docs),
                createdAt: typeof data.createdAt === "string" ? data.createdAt : node_fs_1.default.statSync(fullPath).birthtime.toISOString(),
                updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : node_fs_1.default.statSync(fullPath).mtime.toISOString(),
                body: parsed.content,
                path: fullPath,
                deleted: true,
                originalProject: manifest.originalProject,
                attachmentsPath: node_path_1.default.join(directory, "Attachments"),
                attachments: filesIn(node_path_1.default.join(directory, "Attachments")),
                fileNameMismatch: noteFile.name !== expectedNoteFilename(typeof data.title === "string" ? data.title : noteFile.name.replace(/\.md$/i, ""), id),
            });
        }
        catch (error) {
            console.error(`Could not read trash entry ${folder.name}:`, error);
        }
    }
    return notes;
}
function parseLinks(value) {
    if (!Array.isArray(value))
        return [];
    return value.flatMap((link) => {
        if (!link || typeof link !== "object")
            return [];
        const item = link;
        return typeof item.url === "string"
            ? [{ label: typeof item.label === "string" ? item.label : "", url: item.url }]
            : [];
    });
}
function getSnapshot() {
    if (!libraryRoot)
        throw new Error("Choose a library folder first.");
    const notes = noteRecords();
    const types = notes.map((note) => note.type).filter(Boolean);
    const indexedFiles = projectNames().flatMap((project) => {
        const filesRoot = node_path_1.default.join(projectDir(project), "Files");
        return filesIn(filesRoot).map((relativePath) => {
            const fullPath = node_path_1.default.join(filesRoot, relativePath);
            const extension = node_path_1.default.extname(relativePath).toLowerCase();
            let content = "";
            let contentTruncated = false;
            if ([".txt", ".md", ".log", ".json", ".csv", ".yaml", ".yml"].includes(extension)) {
                let fileDescriptor;
                try {
                    const stat = node_fs_1.default.statSync(fullPath);
                    fileDescriptor = node_fs_1.default.openSync(fullPath, "r");
                    const size = Math.min(stat.size, 500_000);
                    const buffer = Buffer.alloc(size);
                    node_fs_1.default.readSync(fileDescriptor, buffer, 0, size, 0);
                    content = buffer.toString("utf8");
                    contentTruncated = stat.size > size;
                }
                catch (error) {
                    console.error(`Could not index file ${fullPath}:`, error);
                }
                finally {
                    if (fileDescriptor !== undefined)
                        node_fs_1.default.closeSync(fileDescriptor);
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
            files: filesIn(node_path_1.default.join(projectDir(name), "Files")),
        })),
        notes,
        noteTypes: [...new Set(["Feature", "Test", "UAT", "Fix", "Incident", "Data request", "Random", ...types])],
        indexedFiles,
    };
}
function makeNoteFile(note) {
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
    return `---\n${(0, yaml_1.stringify)(metadata).trimEnd()}\n---\n${note.body}`;
}
function parseNoteFile(content) {
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
    if (!match)
        return { data: {}, content };
    const data = (0, yaml_1.parse)(match[1]);
    if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new Error("Note YAML frontmatter must be a mapping.");
    }
    return {
        data: data,
        content: content.slice(match[0].length),
    };
}
function titleSlug(title) {
    const slug = safeName(title.trim() || "Untitled note")
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-zA-Z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 70) || "note";
    return slug;
}
function expectedNoteFilename(title, id) {
    return `${titleSlug(title)}--${id.slice(0, 8)}.md`;
}
function notePath(project, title, id) {
    return node_path_1.default.join(projectDir(project), "Notes", expectedNoteFilename(title, id));
}
function assertUniqueNote(id, targetPath, currentPath) {
    const collision = noteRecords().find((note) => note.id === id && note.path !== targetPath && note.path !== currentPath);
    if (collision)
        throw new Error(`A note with id ${id} already exists.`);
}
async function chooseRoot() {
    const result = await electron_1.dialog.showOpenDialog(mainWindow, {
        title: "Choose your notes library folder",
        properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0)
        return null;
    setRoot(result.filePaths[0]);
    return libraryRoot;
}
function registerHandlers() {
    electron_1.ipcMain.handle("workspace:get-root", () => libraryRoot);
    electron_1.ipcMain.handle("workspace:choose-root", chooseRoot);
    electron_1.ipcMain.handle("workspace:get-snapshot", getSnapshot);
    electron_1.ipcMain.handle("project:create", (_event, rawName) => {
        const name = safeName(rawName);
        if (name === UNASSIGNED)
            throw new Error("Unassigned is already provided.");
        if (node_fs_1.default.existsSync(projectDir(name)))
            throw new Error("A Project with that name already exists.");
        ensureProject(name);
        notifyChanged();
    });
    electron_1.ipcMain.handle("project:rename", (_event, oldName, rawName) => {
        if (oldName === UNASSIGNED)
            throw new Error("Unassigned cannot be renamed.");
        const nextName = safeName(rawName);
        if (oldName === nextName)
            return;
        const from = projectDir(oldName);
        const to = projectDir(nextName);
        if (!node_fs_1.default.existsSync(from))
            throw new Error("Project not found.");
        if (node_fs_1.default.existsSync(to))
            throw new Error("A Project with that name already exists.");
        node_fs_1.default.renameSync(from, to);
        notifyChanged();
    });
    electron_1.ipcMain.handle("project:delete", (_event, name) => {
        if (name === UNASSIGNED)
            throw new Error("Unassigned cannot be deleted.");
        const directory = projectDir(name);
        if (!node_fs_1.default.existsSync(directory))
            throw new Error("Project not found.");
        const notes = noteRecords().filter((note) => note.project === name && !note.deleted);
        const managedFiles = new Set(notes.map((note) => node_path_1.default.relative(directory, note.path)));
        for (const note of notes) {
            if (!note.attachmentsPath || !node_fs_1.default.existsSync(note.attachmentsPath))
                continue;
            for (const attachment of filesIn(note.attachmentsPath, "", true)) {
                managedFiles.add(node_path_1.default.relative(directory, node_path_1.default.join(note.attachmentsPath, attachment)));
            }
        }
        const otherFiles = filesIn(directory, "", true).filter((file) => !managedFiles.has(file));
        if (otherFiles.length > 0)
            throw new Error("Move or delete all non-note Project files before deleting this Project.");
        const unassignedDirectory = ensureProject(UNASSIGNED);
        const moves = [];
        const destinations = new Set();
        const addMove = (source, destination) => {
            if (node_fs_1.default.existsSync(destination) || destinations.has(destination)) {
                throw new Error("A note or attachment already exists in Unassigned.");
            }
            destinations.add(destination);
            moves.push({ source, destination });
        };
        for (const note of notes) {
            const target = node_path_1.default.join(unassignedDirectory, "Notes", node_path_1.default.basename(note.path));
            assertUniqueNote(note.id, target, note.path);
            addMove(note.path, target);
            if (note.attachmentsPath && node_fs_1.default.existsSync(note.attachmentsPath)) {
                addMove(note.attachmentsPath, node_path_1.default.join(unassignedDirectory, "Attachments", note.id));
            }
        }
        const completedMoves = [];
        try {
            for (const move of moves) {
                node_fs_1.default.renameSync(move.source, move.destination);
                completedMoves.push(move);
            }
        }
        catch (error) {
            for (const move of completedMoves.reverse()) {
                if (node_fs_1.default.existsSync(move.destination) && !node_fs_1.default.existsSync(move.source)) {
                    node_fs_1.default.mkdirSync(node_path_1.default.dirname(move.source), { recursive: true });
                    node_fs_1.default.renameSync(move.destination, move.source);
                }
            }
            throw error;
        }
        node_fs_1.default.rmSync(directory, { recursive: true });
        notifyChanged();
    });
    electron_1.ipcMain.handle("note:create", (_event, project) => {
        if (!projectNames().includes(project))
            throw new Error("Choose an existing Project.");
        const now = new Date();
        const title = now.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
        const note = {
            id: (0, node_crypto_1.randomUUID)(),
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
        node_fs_1.default.writeFileSync(target, makeNoteFile(note), { flag: "wx" });
        notifyChanged();
        return { ...note, path: target };
    });
    electron_1.ipcMain.handle("note:recover", (_event, note) => {
        const project = projectNames().includes(note.project) ? note.project : UNASSIGNED;
        ensureProject(project);
        const id = (0, node_crypto_1.randomUUID)();
        const now = new Date().toISOString();
        const attachmentSource = node_path_1.default.join(projectDir(project), "Attachments", note.id);
        const attachmentTarget = node_path_1.default.join(projectDir(project), "Attachments", id);
        if (node_fs_1.default.existsSync(attachmentSource)) {
            const staging = `${attachmentTarget}.recover-${(0, node_crypto_1.randomUUID)()}`;
            try {
                copySupportingEntry(attachmentSource, staging);
                node_fs_1.default.renameSync(staging, attachmentTarget);
            }
            catch (error) {
                if (node_fs_1.default.existsSync(staging))
                    node_fs_1.default.rmSync(staging, { recursive: true, force: true });
                throw error;
            }
        }
        const recovered = {
            ...note,
            id,
            project,
            updatedAt: now,
            body: note.body.replaceAll(`../Attachments/${note.id}/`, `../Attachments/${id}/`),
            path: "",
            deleted: false,
            attachmentsPath: attachmentTarget,
            attachments: node_fs_1.default.existsSync(attachmentTarget) ? filesIn(attachmentTarget) : [],
            fileNameMismatch: false,
        };
        const target = notePath(project, recovered.title, id);
        node_fs_1.default.writeFileSync(target, makeNoteFile(recovered), { flag: "wx" });
        notifyChanged();
        return { ...recovered, path: target };
    });
    electron_1.ipcMain.handle("note:save", (_event, note) => {
        if (note.deleted)
            throw new Error("Restore this note before editing it.");
        const current = noteRecords().find((candidate) => candidate.id === note.id && !candidate.deleted);
        if (!current)
            throw new Error("This note no longer exists in the library.");
        if (!projectNames().includes(note.project))
            throw new Error("The note's Project no longer exists.");
        const titleChanged = note.title !== current.title;
        const target = titleChanged
            ? notePath(note.project, note.title, note.id)
            : node_path_1.default.join(projectDir(note.project), "Notes", node_path_1.default.basename(current.path));
        assertUniqueNote(note.id, target, current.path);
        const previousProject = current.project;
        const nextAttachments = node_path_1.default.join(projectDir(note.project), "Attachments", note.id);
        if (previousProject !== note.project && node_fs_1.default.existsSync(current.attachmentsPath) && node_fs_1.default.existsSync(nextAttachments)) {
            throw new Error("Attachments already exist in the destination Project.");
        }
        if (node_path_1.default.resolve(current.path) !== node_path_1.default.resolve(target)) {
            if (node_fs_1.default.existsSync(target))
                throw new Error("A file with this title already exists.");
            node_fs_1.default.renameSync(current.path, target);
        }
        if (previousProject !== note.project && node_fs_1.default.existsSync(current.attachmentsPath)) {
            node_fs_1.default.renameSync(current.attachmentsPath, nextAttachments);
        }
        const updated = {
            ...note,
            updatedAt: new Date().toISOString(),
            attachmentsPath: nextAttachments,
            attachments: filesIn(nextAttachments),
            fileNameMismatch: node_path_1.default.basename(target) !== expectedNoteFilename(note.title, note.id),
        };
        node_fs_1.default.writeFileSync(target, makeNoteFile(updated));
        notifyChanged();
        return { ...updated, path: target };
    });
    electron_1.ipcMain.handle("note:delete", (_event, id) => {
        const note = noteRecords().find((candidate) => candidate.id === id && !candidate.deleted);
        if (!note)
            throw new Error("Note not found.");
        const trashEntry = node_path_1.default.join(libraryRoot, "Trash", `${id}-${(0, node_crypto_1.randomUUID)().slice(0, 8)}`);
        node_fs_1.default.mkdirSync(trashEntry, { recursive: true });
        node_fs_1.default.renameSync(note.path, node_path_1.default.join(trashEntry, node_path_1.default.basename(note.path)));
        const attachments = note.attachmentsPath;
        if (node_fs_1.default.existsSync(attachments))
            node_fs_1.default.renameSync(attachments, node_path_1.default.join(trashEntry, "Attachments"));
        node_fs_1.default.writeFileSync(node_path_1.default.join(trashEntry, "manifest.json"), JSON.stringify({ originalProject: note.project }, null, 2));
        notifyChanged();
    });
    electron_1.ipcMain.handle("note:restore", (_event, id) => {
        const note = noteRecords().find((candidate) => candidate.id === id && candidate.deleted);
        if (!note)
            throw new Error("Trashed note not found.");
        const trashEntry = node_path_1.default.dirname(note.path);
        const targetProject = projectNames().includes(note.originalProject || note.project)
            ? note.originalProject || note.project
            : UNASSIGNED;
        ensureProject(targetProject);
        const target = notePath(targetProject, note.title, note.id);
        if (node_fs_1.default.existsSync(target))
            throw new Error("A note with the same filename already exists in that Project.");
        node_fs_1.default.renameSync(note.path, target);
        const trashedAttachments = node_path_1.default.join(trashEntry, "Attachments");
        if (node_fs_1.default.existsSync(trashedAttachments)) {
            const destination = node_path_1.default.join(projectDir(targetProject), "Attachments", id);
            if (node_fs_1.default.existsSync(destination))
                throw new Error("Attachments already exist at the restore destination.");
            node_fs_1.default.renameSync(trashedAttachments, destination);
        }
        node_fs_1.default.rmSync(trashEntry, { recursive: true });
        notifyChanged();
    });
    electron_1.ipcMain.handle("trash:empty", () => {
        const trashDir = node_path_1.default.join(libraryRoot, "Trash");
        for (const entry of safeReadDir(trashDir)) {
            node_fs_1.default.rmSync(node_path_1.default.join(trashDir, entry.name), { recursive: true, force: true });
        }
        notifyChanged();
    });
    electron_1.ipcMain.handle("import:notes", (_event, items) => {
        let imported = 0;
        for (const item of items) {
            if (!projectNames().includes(item.project))
                throw new Error(`Choose a valid Project for ${node_path_1.default.basename(item.path)}.`);
            if (![".md", ".txt"].includes(node_path_1.default.extname(item.path).toLowerCase())) {
                throw new Error(`${node_path_1.default.basename(item.path)} is not a Markdown or text file.`);
            }
            const stat = node_fs_1.default.statSync(item.path);
            const date = stat.birthtimeMs > 0 ? stat.birthtime : stat.mtime;
            const id = (0, node_crypto_1.randomUUID)();
            const title = node_path_1.default.basename(item.path, node_path_1.default.extname(item.path));
            const note = {
                id, title, project: item.project, type: "", tags: [], status: "Active",
                workItemId: "", branch: "", baseBranch: "", prs: [], docs: [],
                createdAt: date.toISOString(), updatedAt: date.toISOString(),
                body: node_fs_1.default.readFileSync(item.path, "utf8"), path: "", deleted: false,
                attachments: [],
                fileNameMismatch: false,
            };
            const target = notePath(item.project, title, id);
            node_fs_1.default.writeFileSync(target, makeNoteFile(note), { flag: "wx" });
            imported += 1;
        }
        notifyChanged();
        return imported;
    });
    electron_1.ipcMain.handle("import:choose-files", async () => {
        const result = await electron_1.dialog.showOpenDialog(mainWindow, {
            title: "Import notes",
            properties: ["openFile", "multiSelections"],
            filters: [{ name: "Notes", extensions: ["md", "txt"] }],
        });
        return result.canceled ? [] : result.filePaths;
    });
    electron_1.ipcMain.handle("files:add", async (_event, project) => {
        if (!projectNames().includes(project))
            throw new Error("Choose an existing Project.");
        const result = await electron_1.dialog.showOpenDialog(mainWindow, {
            title: `Add files to ${project}`,
            properties: ["openFile", "openDirectory", "multiSelections"],
        });
        if (result.canceled)
            return 0;
        for (const file of result.filePaths) {
            const target = node_path_1.default.join(projectDir(project), "Files", node_path_1.default.basename(file));
            if (node_fs_1.default.existsSync(target))
                throw new Error(`${node_path_1.default.basename(file)} already exists in this Project.`);
            const staging = `${target}.import-${(0, node_crypto_1.randomUUID)()}`;
            try {
                copySupportingEntry(file, staging);
                node_fs_1.default.renameSync(staging, target);
            }
            catch (error) {
                if (node_fs_1.default.existsSync(staging))
                    node_fs_1.default.rmSync(staging, { recursive: true, force: true });
                throw error;
            }
        }
        notifyChanged();
        return result.filePaths.length;
    });
    electron_1.ipcMain.handle("files:open", async (_event, target) => {
        if (!libraryRoot || !node_path_1.default.resolve(target).startsWith(node_path_1.default.resolve(libraryRoot) + node_path_1.default.sep)) {
            throw new Error("Only files inside this library can be opened.");
        }
        const error = await electron_1.shell.openPath(target);
        if (error)
            throw new Error(error);
    });
    electron_1.ipcMain.handle("links:open-external", async (_event, value) => {
        let url;
        try {
            url = new URL(value);
        }
        catch {
            throw new Error("Enter a valid web URL first.");
        }
        if (url.protocol !== "https:" && url.protocol !== "http:") {
            throw new Error("Only HTTP and HTTPS links can be opened.");
        }
        await electron_1.shell.openExternal(url.toString());
    });
    electron_1.ipcMain.handle("attachment:add", async (_event, id) => {
        const note = noteRecords().find((candidate) => candidate.id === id && !candidate.deleted);
        if (!note)
            throw new Error("Note not found.");
        const result = await electron_1.dialog.showOpenDialog(mainWindow, {
            title: "Add attachment to note",
            properties: ["openFile", "multiSelections"],
        });
        if (result.canceled)
            return null;
        const directory = note.attachmentsPath;
        node_fs_1.default.mkdirSync(directory, { recursive: true });
        const references = [];
        for (const file of result.filePaths) {
            let filename = node_path_1.default.basename(file);
            if (node_fs_1.default.existsSync(node_path_1.default.join(directory, filename))) {
                filename = `${node_path_1.default.parse(filename).name}-${(0, node_crypto_1.randomUUID)().slice(0, 8)}${node_path_1.default.extname(filename)}`;
            }
            node_fs_1.default.copyFileSync(file, node_path_1.default.join(directory, filename), node_fs_1.default.constants.COPYFILE_EXCL);
            references.push(`![${node_path_1.default.parse(filename).name}](../Attachments/${id}/${encodeURIComponent(filename)})`);
        }
        notifyChanged();
        return references.join("\n");
    });
}
function copySupportingEntry(source, destination) {
    const stat = node_fs_1.default.lstatSync(source);
    if (stat.isSymbolicLink())
        throw new Error(`Symbolic links cannot be copied into the library: ${source}`);
    if (stat.isDirectory()) {
        node_fs_1.default.mkdirSync(destination);
        for (const entry of node_fs_1.default.readdirSync(source)) {
            copySupportingEntry(node_path_1.default.join(source, entry), node_path_1.default.join(destination, entry));
        }
        return;
    }
    if (!stat.isFile())
        throw new Error(`Unsupported file type: ${source}`);
    node_fs_1.default.copyFileSync(source, destination, node_fs_1.default.constants.COPYFILE_EXCL);
}
function createWindow() {
    mainWindow = new electron_1.BrowserWindow({
        width: 1500,
        height: 960,
        minWidth: 1024,
        minHeight: 680,
        backgroundColor: "#111318",
        title: "Super Weird Notes",
        webPreferences: {
            preload: node_path_1.default.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith("https://") || url.startsWith("http://"))
            void electron_1.shell.openExternal(url);
        return { action: "deny" };
    });
    mainWindow.webContents.on("will-navigate", (event, url) => {
        const developmentUrl = process.env.VITE_DEV_SERVER_URL;
        const productionUrl = (0, node_url_1.pathToFileURL)(node_path_1.default.join(__dirname, "../dist/index.html")).toString();
        if ((developmentUrl && (url === developmentUrl || url.startsWith(`${developmentUrl}/#`))) ||
            url === productionUrl ||
            url.startsWith(`${productionUrl}#`))
            return;
        event.preventDefault();
        if (url.startsWith("https://") || url.startsWith("http://"))
            void electron_1.shell.openExternal(url);
    });
    if (process.env.VITE_DEV_SERVER_URL) {
        void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    }
    else {
        void mainWindow.loadFile(node_path_1.default.join(__dirname, "../dist/index.html"));
    }
}
electron_1.app.whenReady().then(() => {
    electron_1.protocol.handle("ferretation-attachment", (request) => {
        const url = new URL(request.url);
        const id = node_path_1.default.basename(decodeURIComponent(url.hostname));
        const filename = node_path_1.default.basename(decodeURIComponent(url.pathname).replace(/^\/+/, ""));
        const attachment = node_path_1.default.join(libraryRoot || "", projectRootName);
        const match = noteRecords().find((note) => note.id === id && !note.deleted);
        if (!match || !filename)
            return new Response("Not found", { status: 404 });
        const target = node_path_1.default.join(attachment, match.project, "Attachments", id, filename);
        if (!node_fs_1.default.existsSync(target))
            return new Response("Not found", { status: 404 });
        return electron_1.net.fetch((0, node_url_1.pathToFileURL)(target).toString());
    });
    loadRoot();
    if (libraryRoot)
        watchRoot();
    registerHandlers();
    createWindow();
    electron_1.app.on("activate", () => {
        if (electron_1.BrowserWindow.getAllWindows().length === 0)
            createWindow();
    });
});
electron_1.app.on("window-all-closed", () => {
    if (process.platform !== "darwin")
        electron_1.app.quit();
});
electron_1.app.on("before-quit", () => watcher?.close());
