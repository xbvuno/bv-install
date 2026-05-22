# bv-install ⚡

> transform windows portable apps and directories into native installed applications.

`bv-install` is a modern, lightweight native windows utility designed for developers and power users. it takes ready-to-run portable application folders or `.zip` archives and integrates them seamlessly into the windows environment—handling file organization, start menu/desktop shortcuts, path variables, and registry registration.

it is not a package manager, but a **smart installer for your portable binaries**.

---

## ✨ features

* 📂 **folder & zip inputs**: point to a folder or a `.zip` file. archives are automatically extracted and nested root folders are automatically unwrapped.
* 🎯 **smart main exe detection**: recursively scans your folder, calculates heuristics, and automatically identifies the primary executable.
* 🧠 **gui vs cli auto-detection**: parses raw executable header bytes (PE optional header) in sub-milliseconds to distinguish console (`[cli]`) from desktop (`[gui]`) applications.
* 🌐 **environment PATH integration**: optionally registers cli tools permanently into your environment `PATH` (user or machine level) with an instant win32 message broadcast so you don't have to restart active shells.
* 🧼 **100% clean native uninstallation**: registers an official entry in windows **apps & features / control panel**. uninstalling runs a tailored powershell script that removes the files, deletes shortcuts, and strips the application folder clean from your `PATH`.
* ⚡ **fast developer flags**:
  * `--just-scan` to run the heuristic analyzer on any folder/zip and exit.
  * `--just-add-path` to map any directory directly to your `PATH` variable and exit instantly.
* 🎨 **lowercase-first aesthetics**: outputs beautiful, low-noise, and minimal cli logs inspired by tools like bun and fd.

---

## 🚀 installation

install the package globally via npm:

```bash
npm install -g bv-install
```

---

## 🛠️ usage

### 1. standard interactive install
run the interactive installer wizard on any directory or `.zip` file:

```bash
bv-install .
bv-install C:\path\to\portable-app-folder
bv-install .\ffmpeg-release.zip
```

### 2. quick path mapper (`--just-add-path`)
instantly add the target directory directly to your user (or system-wide if run as admin) environment `PATH` and exit:

```bash
bv-install . --just-add-path
```

### 3. dry-run scanning (`--just-scan`)
scan any folder or archive to see detected executables, recommended entry points, and CLI/GUI classification without installing anything:

```bash
bv-install . --just-scan
```

---

## 🔮 under the hood

### ⚡ sub-millisecond PE subsystem parser
unlike bulky external shell utilities, `bv-install` directly parses the executable file buffers on disk. by reading the `PE` signature offset at `0x3c` and jumping to the optional header subsystem field at `PE_OFFSET + 92`, it determines if the file is a graphical app (`GUI = 2`) or command-line utility (`CUI = 3`) in under 1ms.

### 📡 win32 broadcast notifications
when updating environmental paths, the tool doesn't just change the registry. it uses a native powershell signature bridge to trigger:
```powershell
[Win32.Win32SendMessage]::SendMessageTimeout([IntPtr]0xffff, 0x001A, [UIntPtr]::Zero, "Environment", 2, 5000, [ref]$result)
```
this notifies explorer.exe and active shells of the environment update immediately.

### 🧹 native uninstaller registration
registered apps will show up in the standard windows settings. the `UninstallString` contains backtick-escaped powershell command blocks that execute on click:
* removes all application files.
* cleans up the start menu and desktop shortcuts.
* selectively removes the bin directory from the system `PATH` environment variable.
* deletes the app registry key itself.

---

## 📋 requirements

* **OS**: Windows 10 / 11
* **shell**: PowerShell 5.1+ (included with Windows)
* **runtime**: Node.js `v16.7.0` or higher (uses native recursive `fs.cp`)

---

## 📄 license

MIT © [xbvuno](LICENSE)
