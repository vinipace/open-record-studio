cask "open-record-studio" do
  version "0.3.0"
  sha256 "0098274d17aa1959f72aea52ec6355b31542b55b34602a1cc90524e4f4ea44be"

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
