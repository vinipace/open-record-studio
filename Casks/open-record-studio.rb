cask "open-record-studio" do
  version "0.1.0"
  sha256 "530bccc5534b737b15ffaa6fe4be857a98c46d7fe95e4e6d4168704207bafdeb"

  url "https://github.com/vinipace/open-record-studio/releases/download/v#{version}/Open-Record-Studio-#{version}-macOS-arm64.dmg"
  name "Open Record Studio"
  desc "Local screen and webcam recorder with synchronized video editing"
  homepage "https://github.com/vinipace/open-record-studio"

  depends_on formula: "ffmpeg"
  depends_on macos: :sequoia
  depends_on arch: :arm64

  app "Open Record Studio.app"

  caveats "This preview is signed but not notarized. macOS may block its first launch."
end
