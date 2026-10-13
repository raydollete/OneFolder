# Third-Party Vendored Helpers

This directory bundles pre-built third-party executables that OneFolder ships and
invokes at runtime. This file records, for every vendored helper, its upstream
name and version, the exact source it was obtained from, a SHA-256 of each
file (with the command to reproduce it), its license and the
redistribution obligations that license imposes, and the material build flags
that describe what the binary is capable of.

Windows helpers are shipped for the desktop build on Windows; the Linux FFmpeg
helpers are shipped for the portable Linux build. ExifTool is a
platform-independent Perl script used on every platform that has Perl.

The Windows helpers and ExifTool are committed to this repository. The Linux
FFmpeg helpers are **not tracked in git** (each is over GitHub's 100 MB file
limit): they are downloaded before `yarn package:appimage`, as described in the
README's "Portable builds → Linux (AppImage)" steps. Whoever builds and
distributes an AppImage containing them must meet their license terms.

## Reproducing the checksums

All SHA-256 values below are produced with GNU coreutils `sha256sum`, run from
the repository root:

```
sha256sum resources/ffmpeg/linux/ffmpeg resources/ffmpeg/linux/ffprobe
```

For the Windows helpers:

```
sha256sum resources/ffmpeg/ffmpeg.exe resources/ffmpeg/ffprobe.exe resources/exiftool/exiftool.exe
```

For the ExifTool script and config:

```
sha256sum resources/exiftool/exiftool.pl resources/exiftool/.ExifTool_config
```

A file matches this record when its `sha256sum` output equals the value listed
for it here. The Linux FFmpeg source URL is BtbN's moving `latest` build, so a
fresh download may not match; when it differs, update the Linux entries below to
the build you are shipping.

---

## FFmpeg — Linux x86_64 (`resources/ffmpeg/linux/ffmpeg`)

- **Upstream:** FFmpeg
- **Version:** `n8.1.2-50-g1a748fe2cd-20260906` (release/8.1 branch, static GPL build)
- **Distributor:** BtbN FFmpeg-Builds (statically linked Linux x86_64 GPL build)
- **Source URL:** https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n8.1-latest-linux64-gpl-8.1.tar.xz
- **File:** `resources/ffmpeg/linux/ffmpeg` (mode 0755, 145410576 bytes)
- **SHA-256:** `f07daf4016a556eb7657eb32a1027ec7a818da20c558695fcf0fe4764074ba5d`

## FFprobe — Linux x86_64 (`resources/ffmpeg/linux/ffprobe`)

- **Upstream:** FFmpeg (ffprobe)
- **Version:** `n8.1.2-50-g1a748fe2cd-20260906` (same build as the ffmpeg above)
- **Distributor:** BtbN FFmpeg-Builds (statically linked Linux x86_64 GPL build)
- **Source URL:** https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n8.1-latest-linux64-gpl-8.1.tar.xz
- **File:** `resources/ffmpeg/linux/ffprobe` (mode 0755, 145197456 bytes)
- **SHA-256:** `cab54d2f10cb38a552b4fc9f35cdb6d28dd4c69b3089e96c1517d8f1cd3d16ab`

### License and redistribution obligations (Linux FFmpeg / FFprobe)

These are **GPL** builds, configured with `--enable-gpl --enable-version3`. The
combined work is therefore licensed under the **GNU General Public License,
version 3 or later**. Redistributing these binaries (as OneFolder does inside its
portable Linux artifact) triggers the GPLv3 obligations:

- **Source availability.** The complete corresponding source code for this exact
  FFmpeg build, plus the source of the GPL libraries linked into it, must be
  offered to recipients. BtbN publishes the reproducible build scripts and pins
  the FFmpeg commit (`g1a748fe2cd` on the `release/8.1` branch) at
  https://github.com/BtbN/FFmpeg-Builds; FFmpeg source is at
  https://git.ffmpeg.org/ffmpeg.git (tag/commit `1a748fe2cd`). The OneFolder
  release must carry a written offer or a link to this corresponding source.
- **License text.** A copy of the GPLv3 license text must be included with the
  distribution.
- **No further restrictions.** The binaries must be redistributed under GPLv3
  without imposing additional restrictions.

### Material build flags (Linux FFmpeg / FFprobe)

Captured verbatim from the `configuration:` line of `ffmpeg -version`:

```
--enable-gpl --enable-version3 --enable-ffnvcodec --enable-cuda-llvm
--enable-libx264 --enable-libx265 --enable-libvpx --enable-libaom
--enable-libsvtav1 --enable-librav1e --enable-vaapi --enable-libvpl --enable-amf
(static build: --pkg-config-flags=--static)
```

The flags that matter for OneFolder:

- `--enable-ffnvcodec` + `--enable-cuda-llvm` provide NVIDIA NVENC hardware
  encoders. `ffmpeg -hide_banner -encoders` lists `h264_nvenc` (along with
  `hevc_nvenc` and `av1_nvenc`):

  ```
   V....D h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)
  ```

  NVENC requires a supported NVIDIA GPU and driver on the host at runtime; the
  encoder is present in the binary regardless.
- `--enable-libx264` provides the software H.264 encoder (`libx264`) used as the
  portable, GPU-independent fallback.
- The build is fully statically linked, so these binaries have no external shared
  library dependencies beyond the Linux kernel/libc ABI.

---

## FFmpeg / FFprobe — Windows x86_64 (`resources/ffmpeg/ffmpeg.exe`, `resources/ffmpeg/ffprobe.exe`)

- **Upstream:** FFmpeg 8.1.1
- **Build:** `8.1.1-essentials_build-www.gyan.dev` (Windows x64 static build by
  Gyan Doshi, www.gyan.dev), unmodified. Reproduce with
  `strings resources/ffmpeg/ffmpeg.exe | grep -m1 'version 8.1.1-essentials_build-www.gyan.dev'`;
  the full build configuration is printed by `ffmpeg -buildconf`.
- **Files and SHA-256:**
  - `resources/ffmpeg/ffmpeg.exe` — SHA-256 `228d7a8556258de907fdb55f36850078ebc7680b84ec30d84ea02e99bec1d1eb`
  - `resources/ffmpeg/ffprobe.exe` — SHA-256 `0fde260f5abd35c9cafd96f594cc76365a780c1b73a90e35b6a3409ea1db1bf0`
- **Used by:** the inspector's Re-encode (x264) tool; see
  [docs/reencode-x264.md](../docs/reencode-x264.md).

### License and redistribution obligations (Windows FFmpeg / FFprobe)

These are **GPL** builds, configured with `--enable-gpl --enable-version3` and
statically linking GPL components including libx264 and libx265. There is no
`--enable-nonfree`. The binaries are therefore licensed under the **GNU General
Public License, version 3 or later**. Because this repository is public,
committing them distributes them:

- **License text.** The GPLv3 text is in this repository's [LICENSE](../LICENSE)
  file and at https://www.gnu.org/licenses/gpl-3.0.html. FFmpeg's own licensing
  summary is at https://ffmpeg.org/legal.html.
- **Corresponding Source:**
  - FFmpeg 8.1.1 source: https://ffmpeg.org/releases/ffmpeg-8.1.1.tar.xz
  - Build details and component library versions: https://www.gyan.dev/ffmpeg/builds/
  - Release archive for gyan.dev builds: https://github.com/GyanD/codexffmpeg/releases

  If any of these locations stops providing the source for this exact build,
  open an issue on this repository and the maintainer will provide it.
- **Replacing the binaries** requires updating this section in the same commit.

---

## ExifTool (`resources/exiftool/exiftool.pl`, `resources/exiftool/.ExifTool_config`, `resources/exiftool/exiftool.exe`)

- **Upstream:** ExifTool by Phil Harvey — https://exiftool.org/
- **Version:** 12.54 (January 6, 2023)
- **Source URL:** https://exiftool.org/index.html (the `nix` Perl script was
  extracted from the "first download link" Perl archive; the Windows `.exe` was
  renamed from `exiftool(-k).exe`). See `resources/exiftool/readme.md`.
- **Files:**
  - `resources/exiftool/exiftool.pl` — the cross-platform Perl script (mode
    0755, executable; requires the bundled `lib/` folder). SHA-256
    `94530f35ddae4d1c27830b4253bdd21df4cbe98a36691cee838733cfb2a258a6`.
  - `resources/exiftool/.ExifTool_config` — user configuration file. **The exact
    case (capital `E` and capital `T`: `.ExifTool_config`) is load-bearing** —
    ExifTool only reads a config file with this name. Do not rename it. SHA-256
    `22f0f954d932a3ba530481ef97b2dc0c038dd6d3f15bf25878db96d38f967c71`.
  - `resources/exiftool/exiftool.exe` — self-contained Windows build (does not
    need `lib/`; shipped with the Windows desktop build, unchanged by this
    change). SHA-256
    `d2b62e6e64032f3355a5f8a75c6ccadf6e92dad98e592a769fd953bc1a2d35d0`.
- **License:** ExifTool is free software, released under the same terms as Perl
  itself — the **Artistic License** or the **GNU General Public License**, at the
  user's choice. Redistribution obligation: retain the license notice; source is
  the script itself and is available from https://exiftool.org/.

### Host prerequisite: `/usr/bin/perl` (Linux/portable build)

`exiftool.pl` is a Perl script with the shebang `#!/usr/bin/perl -w`. On Linux it
requires a working Perl interpreter at `/usr/bin/perl`. This is present by default
on essentially every mainstream desktop Linux distribution.

If `/usr/bin/perl` is missing, the script cannot be executed directly and the
kernel/shell reports a `bad interpreter` failure. The concrete, actionable error
a user (or OneFolder, when it spawns the helper) sees is:

```
/usr/bin/perl: bad interpreter: No such file or directory
```

(exit code 126). **Actionable fix:** install Perl via the distribution package
manager, e.g. `sudo apt install perl` (Debian/Ubuntu),
`sudo dnf install perl` (Fedora/RHEL), or `sudo pacman -S perl` (Arch). Perl
5.8.8 or newer satisfies ExifTool 12.54.
