"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
electron_1.contextBridge.exposeInMainWorld("workspace", {
    getRoot: () => electron_1.ipcRenderer.invoke("workspace:get-root"),
    chooseRoot: () => electron_1.ipcRenderer.invoke("workspace:choose-root"),
    getSnapshot: () => electron_1.ipcRenderer.invoke("workspace:get-snapshot"),
    createProject: (name) => electron_1.ipcRenderer.invoke("project:create", name),
    renameProject: (name, nextName) => electron_1.ipcRenderer.invoke("project:rename", name, nextName),
    deleteProject: (name) => electron_1.ipcRenderer.invoke("project:delete", name),
    createNote: (project) => electron_1.ipcRenderer.invoke("note:create", project),
    recoverNote: (note) => electron_1.ipcRenderer.invoke("note:recover", note),
    saveNote: (note) => electron_1.ipcRenderer.invoke("note:save", note),
    deleteNote: (id) => electron_1.ipcRenderer.invoke("note:delete", id),
    restoreNote: (id) => electron_1.ipcRenderer.invoke("note:restore", id),
    emptyTrash: () => electron_1.ipcRenderer.invoke("trash:empty"),
    importNotes: (items) => electron_1.ipcRenderer.invoke("import:notes", items),
    chooseImportFiles: () => electron_1.ipcRenderer.invoke("import:choose-files"),
    addFiles: (project) => electron_1.ipcRenderer.invoke("files:add", project),
    openPath: (path) => electron_1.ipcRenderer.invoke("files:open", path),
    openExternal: (url) => electron_1.ipcRenderer.invoke("links:open-external", url),
    addAttachment: (noteId) => electron_1.ipcRenderer.invoke("attachment:add", noteId),
    onChanged: (callback) => {
        const listener = () => callback();
        electron_1.ipcRenderer.on("workspace:changed", listener);
        return () => electron_1.ipcRenderer.removeListener("workspace:changed", listener);
    },
});
