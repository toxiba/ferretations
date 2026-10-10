import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("workspace", {
  getRoot: () => ipcRenderer.invoke("workspace:get-root"),
  chooseRoot: () => ipcRenderer.invoke("workspace:choose-root"),
  getSnapshot: () => ipcRenderer.invoke("workspace:get-snapshot"),
  createProject: (name: string) => ipcRenderer.invoke("project:create", name),
  renameProject: (name: string, nextName: string) =>
    ipcRenderer.invoke("project:rename", name, nextName),
  deleteProject: (name: string) => ipcRenderer.invoke("project:delete", name),
  createNote: (project: string) => ipcRenderer.invoke("note:create", project),
  recoverNote: (note: NoteRecord) => ipcRenderer.invoke("note:recover", note),
  saveNote: (note: NoteRecord) => ipcRenderer.invoke("note:save", note),
  deleteNote: (id: string) => ipcRenderer.invoke("note:delete", id),
  restoreNote: (id: string) => ipcRenderer.invoke("note:restore", id),
  emptyTrash: () => ipcRenderer.invoke("trash:empty"),
  importNotes: (items: ImportItem[]) =>
    ipcRenderer.invoke("import:notes", items),
  chooseImportFiles: () => ipcRenderer.invoke("import:choose-files"),
  openPath: (path: string) => ipcRenderer.invoke("files:open", path),
  openExternal: (url: string) => ipcRenderer.invoke("links:open-external", url),
  onChanged: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on("workspace:changed", listener);
    return () => ipcRenderer.removeListener("workspace:changed", listener);
  },
});

export interface LinkRecord {
  label: string;
  url: string;
}

export interface NoteRecord {
  id: string;
  title: string;
  project: string;
  type: string;
  tags: string[];
  status: "Active" | "Completed" | "Archived";
  workItemId: string;
  branch: string;
  baseBranch: string;
  prs: LinkRecord[];
  docs: LinkRecord[];
  createdAt: string;
  updatedAt: string;
  body: string;
  path: string;
  deleted: boolean;
  originalProject?: string;
  fileNameMismatch?: boolean;
}

export interface ImportItem {
  path: string;
  project: string;
}

export interface ProjectRecord {
  name: string;
  notes: number;
}

export interface Snapshot {
  root: string;
  projects: ProjectRecord[];
  notes: NoteRecord[];
  noteTypes: string[];
}

declare global {
  interface Window {
    workspace: {
      getRoot(): Promise<string | null>;
      chooseRoot(): Promise<string | null>;
      getSnapshot(): Promise<Snapshot>;
      createProject(name: string): Promise<void>;
      renameProject(name: string, nextName: string): Promise<void>;
      deleteProject(name: string): Promise<void>;
      createNote(project: string): Promise<NoteRecord>;
      recoverNote(note: NoteRecord): Promise<NoteRecord>;
      saveNote(note: NoteRecord): Promise<NoteRecord>;
      deleteNote(id: string): Promise<void>;
      restoreNote(id: string): Promise<void>;
      emptyTrash(): Promise<void>;
      importNotes(items: ImportItem[]): Promise<number>;
      chooseImportFiles(): Promise<string[]>;
      openPath(path: string): Promise<void>;
      openExternal(url: string): Promise<void>;
      onChanged(callback: () => void): () => void;
    };
  }
}
