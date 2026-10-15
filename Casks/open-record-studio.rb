cask "open-record-studio" do
  version "0.2.0"
  sha256 "3411c510a368301e6b6b300548007e87c160d7d62fa4858541608a7d860e2b3a"

  url "https://github.com/vinipace/open-record-studio/releases/download/v#{version}/Open-Record-Studio-#{version}-macOS-arm64.dmg"
  name "Open Record Studio"
  desc "Local screen and webcam recorder with synchronized video editing"
  homepage "https://github.com/vinipace/open-record-studio"

  depends_on formula: "ffmpeg"
  depends_on macos: :sequoia
  depends_on arch: :arm64

  app "Open Record Studio.app"
  binary "#{appdir}/Open Record Studio.app/Contents/Resources/bin/open-record-studio-mcp"

  caveats "This preview is signed but not notarized. macOS may block its first launch."
end
