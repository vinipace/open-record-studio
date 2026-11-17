cask "open-record-studio" do
  version "0.4.1"
  sha256 "8f2fccb5a5c79570d6e09013409e5090027c1a8c918f43e62fea0009e2282526"

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
