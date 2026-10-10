# Super Weird Notes

Super Weird Notes is a local-first desktop workspace for plain-text notes. Notes are organized into Projects and remain readable as text files outside the app.

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
      <note title>--<id>.txt
    <project name>/
      <note title>--<id>.txt
  Trash/
```

Each text note contains a small YAML metadata header followed by its plain-text body. New notes are `.txt` files saved directly in their Project folder. Existing `.md` notes and notes in a legacy `Notes` folder remain readable; when edited, they are saved as flat `.txt` files. Empty legacy `Notes`, `Files`, and `Attachments` folders are removed when a library opens or is selected. Existing non-note files are left untouched.

The note editor uses Monaco with the VS Code Dark theme. Find is available with `Ctrl+F` (or `Cmd+F` on macOS); replace is available with `Ctrl+H` (or `Cmd+H`). Editor options can be changed in the app and are stored on this device. `readOnly` remains controlled by Trash state.

Notes autosave, support metadata and links, and can be restored from Trash. Import copies `.txt` notes into a selected Project. Keep backups of the library folder; synchronization between devices is not built in.

## Current scope

The first release includes project/date/type browsing, full-text note search, plain-text editing, autosave, multi-note tabs, Project metadata and links, text-note import, external-file change detection, and recoverable note deletion. Templates, cloud sync, and Azure DevOps/Confluence integrations are not included.
