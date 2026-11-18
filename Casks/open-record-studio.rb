cask "open-record-studio" do
  version "0.4.2"
  sha256 "ba633ea5110c1a8932a64f43e62bf21fd67eb12d6bd373c045fa23de683b8a15"

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
