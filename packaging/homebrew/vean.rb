# Homebrew formula for the CLI-first Mac install (Move-3G).
#
# vean's source/CLI/Homebrew artifact is PURE TypeScript/Bun: it treats `melt`
# (MLT) and `ffmpeg`/`ffprobe` as SYSTEM dependencies driven arm's-length as
# subprocesses (Hard boundary #1/#2 — never links libmlt/libavcodec). Only the
# signed .app bundles pinned renderer sidecars; this formula bundles no media
# binaries, it just declares the deps.
#
# Tap + install (once a release is tagged):
#   brew tap vean-studio/vean
#   brew install vean
#   vean doctor --surface cli-lsp     # must pass on a clean Mac
#
# Until a tagged release exists, install from HEAD:
#   brew install --HEAD vean-studio/vean/vean
class Vean < Formula
  desc "Agent-native video editing core — typed IR, edit algebra, diagnostics over MLT"
  homepage "https://vean.studio"
  license "AGPL-3.0-only"
  head "https://github.com/vean-studio/vean.git", branch: "main"

  # On the first tagged release, set these to the release tarball:
  # url "https://github.com/vean-studio/vean/archive/refs/tags/v0.1.0.tar.gz"
  # sha256 "REPLACE_WITH_RELEASE_TARBALL_SHA256"
  # version "0.1.0"

  depends_on "oven-sh/bun/bun"
  depends_on "ffmpeg" # encode + probe (system dep, never linked)
  depends_on "mlt"    # provides `melt` — render/still (system dep, never linked)

  def install
    bun = Formula["oven-sh/bun/bun"].opt_bin/"bun"
    # Pure Bun/TS package: install the source tree + production deps under libexec,
    # then expose a thin wrapper that runs the CLI under bun. Renderer binaries stay
    # external system deps resolved on PATH (or via VEAN_MELT/VEAN_FFMPEG/VEAN_FFPROBE).
    libexec.install Dir["*"]
    system bun, "install", "--cwd", libexec, "--frozen-lockfile", "--production"

    (bin/"vean").write <<~SH
      #!/bin/bash
      exec "#{bun}" "#{libexec}/src/cli.ts" "$@"
    SH
    (bin/"vean-lsp").write <<~SH
      #!/bin/bash
      exec "#{bun}" "#{libexec}/src/bridge/lsp/server.ts" "$@"
    SH
    (bin/"vean-mcp").write <<~SH
      #!/bin/bash
      exec "#{bun}" "#{libexec}/src/bridge/mcp/server.ts" "$@"
    SH
    chmod 0755, bin/"vean", bin/"vean-lsp", bin/"vean-mcp"
  end

  def caveats
    <<~EOS
      vean drives melt/ffmpeg as separate processes (never linked). Verify the
      install with:
        vean doctor --surface cli-lsp
      Override renderer binaries for nonstandard installs with VEAN_MELT,
      VEAN_FFMPEG, VEAN_FFPROBE.
    EOS
  end

  test do
    assert_match "vean", shell_output("#{bin}/vean --help 2>&1")
    # The renderer system deps the formula declares must be resolvable.
    assert_predicate Formula["mlt"].opt_bin/"melt", :exist?
    assert_predicate Formula["ffmpeg"].opt_bin/"ffmpeg", :exist?
  end
end
