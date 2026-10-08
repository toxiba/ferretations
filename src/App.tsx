import { marked } from "marked";
import DOMPurify from "dompurify";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ImportItem, NoteRecord, ProjectRecord, Snapshot } from "../electron/preload";

type View = "all" | "dates" | "types" | "files" | "trash";
type LinkField = "prs" | "docs";

const emptySnapshot: Snapshot = {
  root: "",
  projects: [],
  notes: [],
  noteTypes: [],
  indexedFiles: [],
};

function sameContent(a: NoteRecord, b: NoteRecord) {
  return a.title === b.title && a.project === b.project && a.type === b.type &&
    a.status === b.status && a.workItemId === b.workItemId && a.branch === b.branch &&
    a.baseBranch === b.baseBranch && a.body === b.body &&
    JSON.stringify(a.tags) === JSON.stringify(b.tags) &&
    JSON.stringify(a.prs) === JSON.stringify(b.prs) &&
    JSON.stringify(a.docs) === JSON.stringify(b.docs);
}

function dateParts(value: string) {
  const date = new Date(value);
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const quarter = `Q${Math.floor(date.getMonth() / 3) + 1}`;
  return {
    year,
    quarter,
    month,
    day: String(date.getDate()).padStart(2, "0"),
  };
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function App() {
  const [snapshot, setSnapshot] = useState<Snapshot>(emptySnapshot);
  const [drafts, setDrafts] = useState<Record<string, NoteRecord>>({});
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const savedRef = useRef<Record<string, NoteRecord>>({});
  const [rootSelected, setRootSelected] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tabs, setTabs] = useState<string[]>([]);
  const [view, setView] = useState<View>("all");
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [dateFilter, setDateFilter] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [conflicts, setConflicts] = useState<Set<string>>(new Set());
  const [missingNotes, setMissingNotes] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState(false);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [workspaceRestored, setWorkspaceRestored] = useState(false);
  const [importPaths, setImportPaths] = useState<string[]>([]);
  const [importProjects, setImportProjects] = useState<Record<string, string>>({});
  const [renderedMarkdown, setRenderedMarkdown] = useState("");
  const autosaveTimer = useRef<number | undefined>(undefined);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const refresh = useCallback(async () => {
    try {
      const next = await window.workspace.getSnapshot();
      setSnapshot(next);
      setRootSelected(true);
      const previousSaved = savedRef.current;
      const nextSaved = Object.fromEntries(next.notes.map((note) => [note.id, note]));
      const changedExternally = new Set<string>();
      const missingExternally = new Set<string>();
      for (const note of next.notes) {
        const previous = previousSaved[note.id];
        if (dirtyRef.current.has(note.id) && previous && !sameContent(previous, note)) {
          changedExternally.add(note.id);
        }
      }
      const nextIds = new Set(next.notes.map((note) => note.id));
      for (const id of dirtyRef.current) {
        if (previousSaved[id] && !nextIds.has(id)) missingExternally.add(id);
      }
      for (const id of missingExternally) nextSaved[id] = previousSaved[id];
      savedRef.current = nextSaved;
      if (changedExternally.size) {
        setConflicts((current) => new Set([...current, ...changedExternally]));
      }
      if (missingExternally.size) {
        setConflicts((current) => new Set([...current, ...missingExternally]));
        setMissingNotes((current) => new Set([...current, ...missingExternally]));
      }
      setDrafts((previous) => {
        const merged: Record<string, NoteRecord> = {};
        for (const note of next.notes) {
          const current = previous[note.id];
          const isDirty = dirtyRef.current.has(note.id);
          if (current && isDirty) {
            merged[note.id] = current;
          } else {
            merged[note.id] = note;
          }
        }
        for (const id of missingExternally) {
          if (previous[id]) merged[id] = previous[id];
        }
        return merged;
      });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void window.workspace.getRoot().then(async (root) => {
      if (root) await refresh();
      else setLoading(false);
    });
  }, [refresh]);

  useEffect(() => window.workspace.onChanged(() => void refresh()), [refresh]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        document.querySelector<HTMLInputElement>(".global-search input")?.focus();
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        void createNote();
      }
      if (event.key === "Escape" && document.activeElement?.classList.contains("global-search")) {
        setSearch("");
        document.activeElement instanceof HTMLElement && document.activeElement.blur();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  useEffect(() => {
    const savedTabs = localStorage.getItem("ferretations.tabs");
    const savedSelection = localStorage.getItem("ferretations.selected");
    const savedProject = localStorage.getItem("ferretations.project");
    const savedView = localStorage.getItem("ferretations.view") as View | null;
    if (savedTabs) setTabs(JSON.parse(savedTabs) as string[]);
    if (savedSelection) setSelectedId(savedSelection);
    if (savedProject) setProjectFilter(savedProject);
    if (savedView && ["all", "dates", "types", "files", "trash"].includes(savedView)) setView(savedView);
    setWorkspaceRestored(true);
  }, []);

  useEffect(() => {
    if (!workspaceRestored) return;
    localStorage.setItem("ferretations.tabs", JSON.stringify(tabs));
    if (selectedId) localStorage.setItem("ferretations.selected", selectedId);
    else localStorage.removeItem("ferretations.selected");
    if (projectFilter) localStorage.setItem("ferretations.project", projectFilter);
    else localStorage.removeItem("ferretations.project");
    localStorage.setItem("ferretations.view", view);
  }, [tabs, selectedId, projectFilter, view, workspaceRestored]);

  const activeNote = selectedId ? drafts[selectedId] : undefined;

  const openNote = (id: string) => {
    setSelectedId(id);
    setTabs((current) => current.includes(id) ? current : [...current, id]);
    setPreview(false);
    setView("all");
    setMessage("");
  };

  const closeTab = (id: string) => {
    const remaining = tabs.filter((tab) => tab !== id);
    setTabs(remaining);
    if (selectedId === id) setSelectedId(remaining.at(-1) || null);
  };

  const updateNote = (patch: Partial<NoteRecord>) => {
    if (!activeNote || activeNote.deleted) return;
    setDrafts((previous) => ({ ...previous, [activeNote.id]: { ...activeNote, ...patch } }));
    setDirty((previous) => new Set(previous).add(activeNote.id));
  };

  const saveNote = useCallback(async (note: NoteRecord, overwrite = false) => {
    if (conflicts.has(note.id) && !overwrite) return;
    try {
      const saved = await window.workspace.saveNote(note);
      savedRef.current[note.id] = saved;
      setDrafts((current) => {
        const latest = current[note.id];
        if (latest && sameContent(latest, note)) return { ...current, [note.id]: saved };
        return current;
      });
      setDirty((current) => {
        const next = new Set(current);
        if (sameContent(draftsRef.current[note.id] || note, note)) next.delete(note.id);
        return next;
      });
      if (overwrite) setConflicts((current) => {
        const next = new Set(current);
        next.delete(note.id);
        return next;
      });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }, [conflicts]);

  useEffect(() => {
    if (!activeNote || !dirty.has(activeNote.id) || activeNote.deleted || conflicts.has(activeNote.id)) return;
    window.clearTimeout(autosaveTimer.current);
    const noteCopy = activeNote;
    autosaveTimer.current = window.setTimeout(() => void saveNote(noteCopy), 700);
    return () => window.clearTimeout(autosaveTimer.current);
  }, [activeNote, dirty, conflicts, saveNote]);

  useEffect(() => {
    let alive = true;
    async function renderBody() {
      if (!activeNote) {
        setRenderedMarkdown("");
        return;
      }
      const source = activeNote.body.replace(
        /\.\.\/Attachments\/([^/]+)\/([^)\s]+)/g,
        (_match, id: string, filename: string) => {
          let decodedFilename = filename;
          try {
            decodedFilename = decodeURIComponent(filename);
          } catch {
            // Keep malformed external Markdown paths as literal filenames.
          }
          return `ferretation-attachment://${encodeURIComponent(id)}/${encodeURIComponent(decodedFilename)}`;
        },
      );
      const html = await marked.parse(source);
      if (alive) {
        setRenderedMarkdown(DOMPurify.sanitize(html, {
          ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|ferretation-attachment):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i,
        }));
      }
    }
    void renderBody();
    return () => { alive = false; };
  }, [activeNote?.body, activeNote?.id]);

  const filteredNotes = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return snapshot.notes.filter((note) => {
      if (view === "trash" && !note.deleted) return false;
      if (view !== "trash" && note.deleted && !query) return false;
      if (projectFilter && note.project !== projectFilter) return false;
      if (typeFilter && typeFilter !== "__untyped" && note.type !== typeFilter) return false;
      if (statusFilter && note.status !== statusFilter) return false;
      if (dateFilter) {
        const parts = dateParts(note.createdAt);
        const value = dateFilter.split("/");
        if (value[0] !== parts.year) return false;
        if (value[1] && value[1] !== parts.quarter) return false;
        if (value[2] && value[2] !== parts.month) return false;
        if (value[3] && value[3] !== parts.day) return false;
      }
      if (!query) return true;
      const haystack = [
        note.title, note.body, note.project, note.type, note.status, note.workItemId,
        note.branch, note.baseBranch, ...note.tags,
        ...note.prs.flatMap((link) => [link.label, link.url]),
        ...note.docs.flatMap((link) => [link.label, link.url]),
      ].join(" ").toLocaleLowerCase();
      return haystack.includes(query);
    }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [snapshot.notes, view, projectFilter, typeFilter, statusFilter, dateFilter, search]);

  const filteredFiles = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return snapshot.indexedFiles.filter((file) => {
      if (projectFilter && file.project !== projectFilter) return false;
      if (!query) return true;
      return `${file.project} ${file.path} ${file.content}`.toLocaleLowerCase().includes(query);
    });
  }, [snapshot.indexedFiles, projectFilter, search]);

  const displayedNotes = view === "files" ? [] : filteredNotes;
  const displayFiles = search.trim() ? filteredFiles : view === "files" ? filteredFiles : [];

  const doChooseRoot = async () => {
    try {
      const root = await window.workspace.chooseRoot();
      if (root) await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const createProject = async () => {
    const name = window.prompt("Project name");
    if (!name?.trim()) return;
    try {
      await window.workspace.createProject(name);
      await refresh();
      setProjectFilter(name.trim());
      setView("all");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const manageProject = async (project: ProjectRecord) => {
    if (project.name === "Unassigned") return;
    const choice = window.prompt(`Project: ${project.name}\nType a new name, or enter DELETE to remove an empty Project.`);
    if (choice === null || !choice.trim()) return;
    try {
      if (choice.trim().toUpperCase() === "DELETE") {
        if (!window.confirm(`Delete empty Project "${project.name}"?`)) return;
        await window.workspace.deleteProject(project.name);
        setProjectFilter(null);
      } else {
        await window.workspace.renameProject(project.name, choice);
        if (projectFilter === project.name) setProjectFilter(choice.trim());
      }
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const createNote = async () => {
    const project = projectFilter || "Unassigned";
    try {
      const note = await window.workspace.createNote(project);
      setDrafts((current) => ({ ...current, [note.id]: note }));
      savedRef.current[note.id] = note;
      setTabs((current) => [...current, note.id]);
      setSelectedId(note.id);
      setView("all");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const startImport = async () => {
    try {
      const paths = await window.workspace.chooseImportFiles();
      if (!paths.length) return;
      setImportPaths(paths);
      setImportProjects(Object.fromEntries(paths.map((file) => [file, ""])));
      setView("all");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const finishImport = async () => {
    const items: ImportItem[] = importPaths.map((file) => ({ path: file, project: importProjects[file] }));
    try {
      const count = await window.workspace.importNotes(items);
      setImportPaths([]);
      setMessage(`Imported ${count} note${count === 1 ? "" : "s"}.`);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const addFiles = async () => {
    const project = projectFilter || "Unassigned";
    try {
      const count = await window.workspace.addFiles(project);
      if (count) setMessage(`Added ${count} file${count === 1 ? "" : "s"} to ${project}.`);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const deleteSelected = async () => {
    if (!activeNote || !window.confirm(`Move "${activeNote.title}" to Trash?`)) return;
    try {
      await window.workspace.deleteNote(activeNote.id);
      closeTab(activeNote.id);
      setSelectedId(null);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const restoreSelected = async () => {
    if (!activeNote?.deleted) return;
    try {
      await window.workspace.restoreNote(activeNote.id);
      setView("all");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const recoverMissingNote = async () => {
    if (!activeNote || !missingNotes.has(activeNote.id)) return;
    try {
      const recovered = await window.workspace.recoverNote(activeNote);
      savedRef.current[recovered.id] = recovered;
      setDrafts((current) => ({ ...current, [recovered.id]: recovered }));
      setDirty((current) => { const next = new Set(current); next.delete(activeNote.id); return next; });
      setConflicts((current) => { const next = new Set(current); next.delete(activeNote.id); return next; });
      setMissingNotes((current) => { const next = new Set(current); next.delete(activeNote.id); return next; });
      setTabs((current) => [...current.filter((id) => id !== activeNote.id), recovered.id]);
      setSelectedId(recovered.id);
      setView("all");
      setMessage("Saved a recovered copy of the missing note.");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const addAttachment = async () => {
    if (!activeNote) return;
    try {
      const markdown = await window.workspace.addAttachment(activeNote.id);
      if (markdown) updateNote({ body: `${activeNote.body}${activeNote.body ? "\n\n" : ""}${markdown}\n` });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const selectProject = (name: string | null) => {
    setProjectFilter(name);
    setTypeFilter(null);
    setStatusFilter(null);
    setDateFilter(null);
    setView("all");
  };

  const openExternal = async (path: string) => {
    try {
      await window.workspace.openPath(path);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const openWebLink = async (url: string) => {
    try {
      await window.workspace.openExternal(url);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  if (loading) return <div className="loading-screen">Opening your workspace…</div>;
  if (!rootSelected) {
    return (
      <main className="welcome-screen">
        <div className="brand-mark">f.</div>
        <p className="eyebrow">YOUR LOCAL WORKSPACE</p>
        <h1>All your work notes,<br />in one place.</h1>
        <p className="welcome-copy">A calm, searchable home for task notes, project files, links and the little details you’ll need later.</p>
        <button className="primary-button welcome-button" onClick={() => void doChooseRoot()}>Choose library folder <span>→</span></button>
        <p className="subtle">Your notes stay on this device as regular Markdown files.</p>
        {message && <p className="error-message">{message}</p>}
      </main>
    );
  }

  const activeConflict = !!activeNote && conflicts.has(activeNote.id);
  const activeDirty = !!activeNote && dirty.has(activeNote.id);

  return (
    <div className="app-shell">
      <header className="topbar">
        <button className="wordmark" onClick={() => selectProject(null)} aria-label="All notes">
          <span className="brand-mark small">f.</span><span>ferretations</span>
        </button>
        <div className="global-search">
          <span className="search-icon">⌕</span>
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search notes, work items, branches, files…" />
          <kbd>⌘ K</kbd>
        </div>
        <button className="icon-button" onClick={() => void doChooseRoot()} title="Change library folder">⚙</button>
        <div className="avatar">M</div>
      </header>

      <aside className="sidebar">
        <div className="side-scroll">
          <div className="side-section">
            <div className="section-label">WORKSPACE <span className="tiny-muted">⌄</span></div>
            <button className={`nav-item ${view === "all" && !projectFilter ? "selected" : ""}`} onClick={() => { selectProject(null); setView("all"); }}>
              <span className="nav-icon">▤</span> All notes <span className="nav-count">{snapshot.notes.filter((note) => !note.deleted).length}</span>
            </button>
            <button className={`nav-item ${view === "dates" ? "selected" : ""}`} onClick={() => { setView("dates"); setProjectFilter(null); setTypeFilter(null); setDateFilter(null); }}>
              <span className="nav-icon">◷</span> By date
            </button>
            <button className={`nav-item ${view === "types" ? "selected" : ""}`} onClick={() => { setView("types"); setProjectFilter(null); setTypeFilter(null); setDateFilter(null); }}>
              <span className="nav-icon">◇</span> By type
            </button>
            <button className={`nav-item ${view === "files" ? "selected" : ""}`} onClick={() => setView("files")}>
              <span className="nav-icon">▱</span> Project files
            </button>
            <button className={`nav-item ${view === "trash" ? "selected" : ""}`} onClick={() => { setView("trash"); setProjectFilter(null); }}>
              <span className="nav-icon">⌑</span> Trash <span className="nav-count">{snapshot.notes.filter((note) => note.deleted).length || ""}</span>
            </button>
          </div>

          <div className="side-section projects-section">
            <div className="section-label">PROJECTS <button className="tiny-action" onClick={() => void createProject()} title="New Project">＋</button></div>
            {snapshot.projects.map((project) => (
              <div className="project-row" key={project.name}>
                <button className={`nav-item project-item ${projectFilter === project.name ? "selected" : ""}`} onClick={() => selectProject(project.name)}>
                  <span className={`project-dot ${project.name === "Unassigned" ? "neutral" : ""}`} />
                  <span className="truncate">{project.name}</span><span className="nav-count">{project.notes || ""}</span>
                </button>
                {project.name !== "Unassigned" && <button className="more-button" title={`Manage ${project.name}`} onClick={() => void manageProject(project)}>···</button>}
              </div>
            ))}
          </div>

          {view === "dates" && (
            <div className="side-section tree-section">
              <div className="section-label">CREATED</div>
              <DateTree notes={snapshot.notes.filter((note) => !note.deleted)} current={dateFilter} onSelect={setDateFilter} />
            </div>
          )}
          {view === "types" && (
            <div className="side-section tree-section">
              <div className="section-label">NOTE TYPE</div>
              {snapshot.noteTypes.map((type) => (
                <button key={type} className={`nav-item ${typeFilter === type ? "selected" : ""}`} onClick={() => { setTypeFilter(typeFilter === type ? null : type); setView("all"); }}>
                  <span className="type-bullet" />{type}<span className="nav-count">{snapshot.notes.filter((note) => note.type === type && !note.deleted).length || ""}</span>
                </button>
              ))}
              <button className={`nav-item ${typeFilter === "__untyped" ? "selected" : ""}`} onClick={() => { setTypeFilter("__untyped"); setView("all"); }}>Unclassified</button>
            </div>
          )}
        </div>
        <div className="sidebar-bottom">
          <div className="library-location"><span className="online-dot" /> Library <span title={snapshot.root}>{snapshot.root.split(/[\\/]/).at(-1)}</span></div>
          <button className="import-link" onClick={() => void startImport()}>⇧ &nbsp;Import notes</button>
        </div>
      </aside>

      <main className="main-area">
        {message && <div className="toast" role="status">{message}<button onClick={() => setMessage("")}>×</button></div>}
        <div className="content-toolbar">
          <div>
            <div className="breadcrumbs">
              <span>{view === "trash" ? "Trash" : view === "files" ? "Project files" : view === "dates" ? "By date" : view === "types" ? "By type" : projectFilter || "All notes"}</span>
              {search && <><span className="crumb-slash">/</span><span className="muted">“{search}”</span></>}
            </div>
            <div className="result-subtitle">{view === "trash" ? "Deleted notes are kept here until you empty Trash." : view === "files" ? "Files copied into your Projects." : "Your notes, collected and ready when you need them."}</div>
          </div>
          <div className="toolbar-actions">
            {view === "files" && <button className="secondary-button" onClick={() => void addFiles()}>＋ Add files</button>}
            {view === "trash" && snapshot.notes.some((note) => note.deleted) && <button className="text-button danger-text" onClick={async () => {
              if (!window.confirm("Permanently delete everything in Trash? This cannot be undone.")) return;
              try { await window.workspace.emptyTrash(); await refresh(); } catch (error) { setMessage(String(error)); }
            }}>Empty Trash</button>}
            <button className="primary-button" onClick={() => void createNote()}><span>＋</span> New note</button>
          </div>
        </div>

        {view === "types" && typeFilter === "__untyped" && null}
        <div className={`workspace-grid ${activeNote ? "with-editor" : ""}`}>
          <section className="results-panel">
            {view === "types" && !typeFilter && (
              <div className="type-cards">
                {snapshot.noteTypes.map((type) => {
                  const count = snapshot.notes.filter((note) => note.type === type && !note.deleted).length;
                  return <button key={type} className="type-card" onClick={() => setTypeFilter(type)}>
                    <span className="type-card-icon">◇</span><strong>{type}</strong><span>{count} notes</span>
                  </button>;
                })}
              </div>
            )}
            <div className="filter-row">
              {typeFilter && typeFilter !== "__untyped" && <button className="filter-chip" onClick={() => setTypeFilter(null)}>{typeFilter} ×</button>}
              {typeFilter === "__untyped" && <button className="filter-chip" onClick={() => setTypeFilter(null)}>Unclassified ×</button>}
              <select aria-label="Filter by status" value={statusFilter || ""} onChange={(event) => setStatusFilter(event.target.value || null)}>
                <option value="">Any status</option><option>Active</option><option>Completed</option><option>Archived</option>
              </select>
              {projectFilter && <button className="filter-chip" onClick={() => selectProject(null)}>{projectFilter} ×</button>}
              {dateFilter && <button className="filter-chip" onClick={() => setDateFilter(null)}>{dateFilter.replaceAll("/", " / ")} ×</button>}
            </div>
            {view !== "types" || typeFilter ? (
              <div className="result-list">
                {displayedNotes.filter((note) => typeFilter !== "__untyped" || !note.type).map((note) => (
                  <button key={`${note.id}-${note.deleted}`} className={`note-card ${selectedId === note.id ? "active" : ""} ${note.deleted ? "is-deleted" : ""}`} onClick={() => openNote(note.id)}>
                    <div className="note-card-top"><span className="note-type">{note.type || "Unclassified"}</span><span className={`status-pill ${note.status.toLowerCase()}`}>{note.deleted ? "Deleted" : note.status}</span></div>
                    <h3>{note.title}</h3>
                    <p className="note-excerpt">{note.body.replace(/[#>*_`[\]()!-]/g, " ").replace(/\s+/g, " ").trim() || "No note content yet."}</p>
                    <div className="note-card-bottom"><span className="project-tag">{note.project}</span>{note.workItemId && <span className="work-item">#{note.workItemId}</span>}<span className="card-date">{formatDate(note.createdAt)}</span></div>
                  </button>
                ))}
                {displayFiles.map((file) => (
                  <button key={`${file.project}/${file.path}`} className="file-result" onClick={() => void openExternal(`${snapshot.root}/Projects/${file.project}/Files/${file.path}`)}>
                    <span className="file-icon">▧</span>                    <span><strong>{file.path}</strong><small>{file.project}{file.content && ` · ${file.content.slice(0, 90).replace(/\s+/g, " ")}`}{file.contentTruncated && " · content index limited to first 500 KB"}</small></span><span>↗</span>
                  </button>
                ))}
                {!displayedNotes.length && !displayFiles.length && <div className="empty-state"><div className="empty-icon">⌕</div><h3>No notes found</h3><p>Try another search or create a note to capture something.</p><button className="secondary-button" onClick={() => void createNote()}>＋ Create a note</button></div>}
              </div>
            ) : null}
          </section>

          {activeNote && (
            <section className="editor-panel">
              <div className="editor-toolbar">
                <div className="tab-strip">
                  {tabs.map((id) => {
                    const note = drafts[id];
                    if (!note) return null;
                    return <div className={`editor-tab ${id === selectedId ? "current" : ""}`} key={id}>
                      <button className="tab-title" onClick={() => setSelectedId(id)}>{note.title}</button>
                      <button className="tab-close" onClick={() => closeTab(id)} aria-label={`Close ${note.title}`}>×</button>
                    </div>;
                  })}
                </div>
                <div className="editor-actions">
                  {activeNote.deleted
                    ? <span className="save-indicator">In Trash</span>
                    : activeDirty
                      ? <span className="save-indicator"><i /> {activeConflict ? "Conflict" : "Saving…"}</span>
                      : <span className="save-indicator saved"><i /> Saved</span>}
                  {!activeNote.deleted && <button className={`icon-button ${preview ? "pressed" : ""}`} onClick={() => setPreview(!preview)} title="Toggle Markdown preview">◫</button>}
                  {activeNote.deleted
                    ? <button className="secondary-button restore-button" onClick={() => void restoreSelected()}>Restore note</button>
                    : <button className="icon-button danger-text" onClick={() => void deleteSelected()} title="Move note to Trash">⌑</button>}
                </div>
              </div>
              {activeConflict && <div className="conflict-banner"><span>{missingNotes.has(activeNote.id) ? "This note was moved or removed outside Ferretations. Your edits are safe locally." : "This note changed outside Ferretations. Your edits are safe locally."}</span>
                {missingNotes.has(activeNote.id)
                  ? <button onClick={() => void recoverMissingNote()}>Save as a new note</button>
                  : <>
                    <button onClick={() => {
                      const remote = snapshot.notes.find((item) => item.id === activeNote.id);
                      if (remote) {
                        setDrafts((current) => ({ ...current, [remote.id]: remote }));
                        savedRef.current[remote.id] = remote;
                        setDirty((current) => { const next = new Set(current); next.delete(remote.id); return next; });
                      }
                      setConflicts((current) => { const next = new Set(current); next.delete(activeNote.id); return next; });
                    }}>Load external version</button>
                    <button onClick={() => void saveNote(activeNote, true)}>Overwrite with my edits</button>
                  </>}
              </div>}
              <div className="editor-scroll">
                <div className="note-heading">
                  <span className="editor-project">{activeNote.project} <span>·</span> {formatDate(activeNote.createdAt)}</span>
                  {activeNote.fileNameMismatch && <div className="filename-warning">The filename was changed outside the app. The stored title and external filename are both preserved.</div>}
                  <input className="title-input" disabled={activeNote.deleted} value={activeNote.title} onChange={(event) => updateNote({ title: event.target.value })} aria-label="Note title" />
                  <div className="metadata-inline">
                    <label className="metadata-label">TYPE</label>
                    <input className="type-input" disabled={activeNote.deleted} list="note-types" placeholder="Unclassified" value={activeNote.type} onChange={(event) => updateNote({ type: event.target.value })} />
                    <datalist id="note-types">{snapshot.noteTypes.map((type) => <option key={type} value={type} />)}</datalist>
                    <label className="metadata-label status-label">STATUS</label>
                    <select className="status-select" disabled={activeNote.deleted} value={activeNote.status} onChange={(event) => updateNote({ status: event.target.value as NoteRecord["status"] })}>
                      <option>Active</option><option>Completed</option><option>Archived</option>
                    </select>
                  </div>
                  <MetadataEditor note={activeNote} projects={snapshot.projects} knownTags={[...new Set(snapshot.notes.flatMap((item) => item.tags))]} readOnly={activeNote.deleted} onOpenExternal={(url) => void openWebLink(url)} onChange={updateNote} />
                </div>
                {!activeNote.deleted && <div className="body-toolbar">
                  <span>NOTE BODY <span className="markdown-mark">M↓</span></span>
                  <div><button className="subtle-action" onClick={() => void addAttachment()}>＋ Attach</button>
                    <button className={`subtle-action ${preview ? "on" : ""}`} onClick={() => setPreview(!preview)}>{preview ? "Edit Markdown" : "Preview"}</button></div>
                </div>}
                {activeNote.deleted
                  ? <article className="markdown-preview" dangerouslySetInnerHTML={{ __html: renderedMarkdown }} />
                  : preview
                  ? <article className="markdown-preview" dangerouslySetInnerHTML={{ __html: renderedMarkdown }} />
                  : <textarea className="markdown-editor" value={activeNote.body} onChange={(event) => updateNote({ body: event.target.value })} placeholder={"Start with a thought…\n\nThis is your open canvas. Capture the details now; add structure when it helps you find them later."} spellCheck />}
                {activeNote.attachmentsPath && <AttachmentList note={activeNote} onOpen={openExternal} />}
              </div>
            </section>
          )}
        </div>

        <footer className="statusbar"><span><i className="online-dot" /> Local library</span><span>{snapshot.projects.length} projects</span><span>{snapshot.notes.filter((note) => !note.deleted).length} notes</span><span className="statusbar-path">{snapshot.root}</span><span>Markdown</span></footer>
      </main>

      {importPaths.length > 0 && (
        <div className="modal-backdrop">
          <div className="import-dialog">
            <div className="modal-heading"><div><p className="eyebrow">SAFE COPY IMPORT</p><h2>Choose a Project for each note</h2><p>Original files stay untouched. Files are copied into your library.</p></div><button className="icon-button" onClick={() => setImportPaths([])}>×</button></div>
            <div className="import-items">
              {importPaths.map((file) => <label className="import-item" key={file}><span className="import-file-icon">▤</span><span className="import-file-name" title={file}>{file.split(/[\\/]/).at(-1)}</span><select value={importProjects[file] || ""} onChange={(event) => setImportProjects((current) => ({ ...current, [file]: event.target.value }))}><option value="">Choose Project…</option>{snapshot.projects.map((project) => <option key={project.name}>{project.name}</option>)}</select></label>)}
            </div>
            <div className="modal-footer"><span>{importPaths.length} selected</span><div><button className="secondary-button" onClick={() => setImportPaths([])}>Cancel</button><button className="primary-button" disabled={importPaths.some((file) => !importProjects[file])} onClick={() => void finishImport()}>Import notes</button></div></div>
          </div>
        </div>
      )}
    </div>
  );
}

function MetadataEditor({ note, projects, knownTags, readOnly, onOpenExternal, onChange }: {
  note: NoteRecord;
  projects: ProjectRecord[];
  knownTags: string[];
  readOnly: boolean;
  onOpenExternal: (url: string) => void;
  onChange: (patch: Partial<NoteRecord>) => void;
}) {
  const [tagInput, setTagInput] = useState("");
  const addLink = (field: LinkField) => onChange({ [field]: [...note[field], { label: "", url: "" }] });
  const editLink = (field: LinkField, index: number, key: "label" | "url", value: string) => {
    const links = note[field].map((item, i) => i === index ? { ...item, [key]: value } : item);
    onChange({ [field]: links });
  };
  const removeLink = (field: LinkField, index: number) => onChange({ [field]: note[field].filter((_item, i) => i !== index) });
  const addTag = () => {
    const tag = tagInput.trim().replace(/^#/, "");
    if (tag && !note.tags.includes(tag)) onChange({ tags: [...note.tags, tag] });
    setTagInput("");
  };
  return (
    <div className="metadata-grid">
      <label className="field-label">PROJECT
        <select disabled={readOnly} value={note.project} onChange={(event) => onChange({ project: event.target.value })}>{projects.map((project) => <option key={project.name}>{project.name}</option>)}</select>
      </label>
      <label className="field-label">AZURE WORK ITEM
        <input disabled={readOnly} value={note.workItemId} onChange={(event) => onChange({ workItemId: event.target.value })} placeholder="e.g. 123456" />
      </label>
      <label className="field-label">BRANCH
        <input disabled={readOnly} value={note.branch} onChange={(event) => onChange({ branch: event.target.value })} placeholder="feature/my-branch" />
      </label>
      <label className="field-label">FROM BRANCH
        <input disabled={readOnly} value={note.baseBranch} onChange={(event) => onChange({ baseBranch: event.target.value })} placeholder="main" />
      </label>
      <div className="field-label tags-field">TAGS
        <div className="tags-input">{note.tags.map((tag) => <button className="tag-chip" key={tag} disabled={readOnly} onClick={() => onChange({ tags: note.tags.filter((item) => item !== tag) })}>{tag} ×</button>)}<input disabled={readOnly} value={tagInput} list="existing-tags" onChange={(event) => setTagInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === ",") { event.preventDefault(); addTag(); } }} onBlur={addTag} placeholder="Add tag…" /><datalist id="existing-tags">{knownTags.map((tag) => <option key={tag}>{tag}</option>)}</datalist></div>
      </div>
      <div className="link-fields">
        <LinkEditor title="PULL REQUESTS" links={note.prs} readOnly={readOnly} onOpen={onOpenExternal} onAdd={() => addLink("prs")} onEdit={(index, key, value) => editLink("prs", index, key, value)} onRemove={(index) => removeLink("prs", index)} />
        <LinkEditor title="DOCUMENTATION" links={note.docs} readOnly={readOnly} onOpen={onOpenExternal} onAdd={() => addLink("docs")} onEdit={(index, key, value) => editLink("docs", index, key, value)} onRemove={(index) => removeLink("docs", index)} />
      </div>
    </div>
  );
}

function LinkEditor({ title, links, readOnly, onOpen, onAdd, onEdit, onRemove }: {
  title: string;
  links: NoteRecord["prs"];
  readOnly: boolean;
  onOpen: (url: string) => void;
  onAdd: () => void;
  onEdit: (index: number, key: "label" | "url", value: string) => void;
  onRemove: (index: number) => void;
}) {
  return <div className="link-editor"><div className="field-label link-title">{title}<button disabled={readOnly} onClick={onAdd}>＋ Add</button></div>
    {links.map((link, index) => <div className="link-row" key={`${title}-${index}`}><input disabled={readOnly} value={link.label} onChange={(event) => onEdit(index, "label", event.target.value)} placeholder="Label" /><input disabled={readOnly} value={link.url} onChange={(event) => onEdit(index, "url", event.target.value)} placeholder="https://…" /><button className="open-link" disabled={!/^https?:\/\//i.test(link.url)} onClick={() => onOpen(link.url)} title="Open link in browser">↗</button><button disabled={readOnly} onClick={() => onRemove(index)}>×</button></div>)}
  </div>;
}

function AttachmentList({ note, onOpen }: { note: NoteRecord; onOpen: (path: string) => void }) {
  const files = note.attachments;
  if (!files.length) return null;
  return <div className="attachment-list"><span>ATTACHMENTS</span>{files.map((file) => <button key={file} onClick={() => void onOpen(`${note.attachmentsPath}/${file}`)}>{file}</button>)}</div>;
}

function DateTree({ notes, current, onSelect }: { notes: NoteRecord[]; current: string | null; onSelect: (value: string | null) => void }) {
  const tree = useMemo(() => {
    const years = new Map<string, Map<string, Map<string, Map<string, number>>>>();
    for (const note of notes) {
      const parts = dateParts(note.createdAt);
      if (!years.has(parts.year)) years.set(parts.year, new Map());
      const quarters = years.get(parts.year)!;
      if (!quarters.has(parts.quarter)) quarters.set(parts.quarter, new Map());
      const months = quarters.get(parts.quarter)!;
      if (!months.has(parts.month)) months.set(parts.month, new Map());
      const days = months.get(parts.month)!;
      days.set(parts.day, (days.get(parts.day) || 0) + 1);
    }
    return years;
  }, [notes]);
  return <div className="date-tree">
    {[...tree.entries()].sort(([a], [b]) => b.localeCompare(a)).map(([year, quarters]) => (
      <details key={year} open>
        <summary><button className={`tree-button ${current === year ? "chosen" : ""}`} onClick={() => onSelect(current === year ? null : year)}>{year}<span>{[...quarters.values()].flatMap((months) => [...months.values()].flatMap((days) => [...days.values()])).reduce((sum, n) => sum + n, 0)}</span></button></summary>
        {[...quarters.entries()].map(([quarter, months]) => {
          const qKey = `${year}/${quarter}`;
          return <details key={qKey}>
            <summary><button className={`tree-button nested ${current === qKey ? "chosen" : ""}`} onClick={() => onSelect(current === qKey ? null : qKey)}>{quarter}</button></summary>
            {[...months.entries()].map(([month, days]) => {
              const mKey = `${qKey}/${month}`;
              const monthName = new Date(Number(year), Number(month) - 1, 1).toLocaleString(undefined, { month: "short" });
              return <details key={mKey}>
                <summary><button className={`tree-button nested deeper ${current === mKey ? "chosen" : ""}`} onClick={() => onSelect(current === mKey ? null : mKey)}>{monthName}</button></summary>
                {[...days.entries()].map(([day, count]) => {
                  const dKey = `${mKey}/${day}`;
                  return <button key={dKey} className={`tree-button day-node ${current === dKey ? "chosen" : ""}`} onClick={() => onSelect(current === dKey ? null : dKey)}>{day}<span>{count}</span></button>;
                })}
              </details>;
            })}
          </details>;
        })}
      </details>
    ))}
  </div>;
}

export default App;
