cask "toolport" do
  version "1.9.3"

  on_arm do
    sha256 "8bc75ea05965866f43ccd2dba2c991a82768fad0ca2d33e3afb3a46dca87c618"
    url "https://github.com/tsouth89/toolport/releases/download/v#{version}/Toolport_aarch64-apple-darwin.dmg",
        verified: "github.com/tsouth89/toolport/"
  end
  on_intel do
    sha256 "822b98e6c1004a0387c53b51c02f8a6833250a2b5b425208cd70c2a6183b4896"
    url "https://github.com/tsouth89/toolport/releases/download/v#{version}/Toolport_x86_64-apple-darwin.dmg",
        verified: "github.com/tsouth89/toolport/"
  end

  name "Toolport"
  desc "One local gateway for every MCP server, shared by every AI client"
  homepage "https://toolport.app/"

  # The updater ships new versions in-app; livecheck tracks the GitHub releases so
  # `brew upgrade` also works for anyone who prefers it.
  livecheck do
    url :url
    strategy :github_latest
  end

  app "Toolport.app"

  # The gateway is a nested helper the app manages; no separate binaries to link.
  zap trash: [
    "~/Library/Application Support/Conduit",
    "~/Library/Caches/com.tsout.conduit",
    "~/Library/HTTPStorages/com.tsout.conduit",
    "~/Library/Preferences/com.tsout.conduit.plist",
    "~/Library/Saved Application State/com.tsout.conduit.savedState",
  ]
end
