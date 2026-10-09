# Ferretations

Ferretations is a local-first desktop workspace for work notes. It stores notes as ordinary Markdown files and organizes them into Projects, so the library remains portable and readable without the app.

## Run locally

Requirements: Node.js 20 or newer.

```sh
npm install
npm run dev
```

Build the desktop app:

```sh
npm run build
```

Run the built app with `npm start`.

## Build installers

Install dependencies with `npm install`, then create platform-specific installers:

On an Apple Silicon Mac, create the macOS disk image and ZIP for the Apple Silicon (`arm64`) architecture:

```sh
npm run dist:mac -- --arm64
```

On Windows, create the 64-bit Windows installer:

```sh
npm run dist:win -- --x64
```

Builds are written to `dist/`. The macOS command targets Apple Silicon, not Intel (`x64`) Macs; the Windows command creates an NSIS `.exe` installer.

## First launch and library layout

Choose a library folder on first launch. The app creates this layout:

```text
<library>/
  Projects/
    Unassigned/
      Notes/
      Files/
      Attachments/
    <project name>/
      Notes/
      Files/
      Attachments/
  Trash/
```

Every note belongs to one Project. The protected `Unassigned` Project is the default for notes created from global views. Choose a Project in the sidebar to make new notes there. Notes use YAML frontmatter for their title, type, tags, lifecycle status, work-item/branch fields, links, and dates. Their body is normal Markdown. Renaming a note in the app also renames its Markdown file; moving a note changes its Project folder and moves note-specific attachments with it.

Supporting files are copied into a Project's `Files` area. Markdown, text, log, JSON, CSV, and YAML files are indexed for full-text search (the first 500 KB of each file); other files are searchable by name and open with the operating system's default app. Imported `.md` and `.txt` notes are copied, never moved, and must be assigned to a Project individually.

Deleted notes and their attachments are retained under `Trash` until Trash is emptied. Projects can be renamed and only empty Projects can be deleted. Keep backups of the library folder; synchronization between devices is not built in.

## Current scope

The first release includes project/date/type browsing, full-text search over notes and supported Project files, Markdown editing and preview, autosave, multi-note tabs, Project metadata and links, safe import, attachments, external-file change detection, and recoverable note deletion. Templates, cloud sync, and Azure DevOps/Confluence integrations are not included.
