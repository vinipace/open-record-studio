export const updateRepository = "vinipace/open-record-studio";
export const releasesURL = `https://github.com/${updateRepository}/releases`;
export const releasesAPI = `https://api.github.com/repos/${updateRepository}/releases?per_page=100`;
export const updateManifestName = "RELEASES.json";

export function versionParts(version) {
  if (
    typeof version !== "string" ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)
  )
    return null;
  const parts = version.split(".").map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}
export function compareVersions(left, right) {
  const a = versionParts(left),
    b = versionParts(right);
  if (!a || !b) throw new Error("Invalid release version");
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return Math.sign(a[i] - b[i]);
  return 0;
}
export function updateAssetURL(version, name) {
  if (!versionParts(version)) throw new Error("Invalid release version");
  return `${releasesURL}/download/v${version}/${name}`;
}
export const updateZipName = (version) =>
  `Open-Record-Studio-${version}-macOS-arm64.zip`;

export function selectUpdate(releases, currentVersion, includePreviews = true) {
  if (!Array.isArray(releases))
    throw new Error("Invalid GitHub release response");
  const candidates = releases.flatMap((release) => {
    const version =
      typeof release.tag_name === "string"
        ? release.tag_name.replace(/^v/, "")
        : "";
    if (
      release.draft ||
      (release.prerelease && !includePreviews) ||
      !versionParts(version) ||
      release.tag_name !== `v${version}` ||
      compareVersions(version, currentVersion) <= 0
    )
      return [];
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const zip = assets.find(
      (asset) =>
        asset.name === updateZipName(version) && asset.state === "uploaded",
    );
    const feed = assets.find(
      (asset) =>
        asset.name === updateManifestName && asset.state === "uploaded",
    );
    return [
      {
        version,
        preview: !!release.prerelease,
        releaseURL: `${releasesURL}/tag/v${version}`,
        feedURL: updateAssetURL(version, updateManifestName),
        automatic: !!zip && !!feed,
        zipSize: zip?.size,
        zipHash: /^sha256:[a-f\d]{64}$/i.test(zip?.digest || "")
          ? zip.digest.slice(7).toLowerCase()
          : undefined,
      },
    ];
  });
  return (
    candidates.sort((a, b) => compareVersions(b.version, a.version))[0] || null
  );
}

export function createUpdateManifest({
  version,
  sha256,
  size,
  date = new Date().toISOString(),
}) {
  if (
    !versionParts(version) ||
    !/^[a-f\d]{64}$/i.test(sha256) ||
    !Number.isSafeInteger(size) ||
    size <= 0
  )
    throw new Error("Invalid update artifact");
  return {
    currentRelease: version,
    releases: [
      {
        version,
        updateTo: {
          version,
          name: `Open Record Studio ${version}`,
          pub_date: date,
          notes: `Release notes: ${releasesURL}/tag/v${version}`,
          url: updateAssetURL(version, updateZipName(version)),
          sha256: sha256.toLowerCase(),
          size,
        },
      },
    ],
  };
}

export function validateUpdateManifest(manifest, release) {
  if (
    manifest?.currentRelease !== release.version ||
    !Array.isArray(manifest.releases) ||
    manifest.releases.length !== 1
  )
    throw new Error("Update metadata does not match this release");
  const entry = manifest.releases[0],
    update = entry?.updateTo;
  if (
    entry.version !== release.version ||
    update?.version !== release.version ||
    update.url !==
      updateAssetURL(release.version, updateZipName(release.version)) ||
    !/^[a-f\d]{64}$/i.test(update.sha256) ||
    !Number.isSafeInteger(update.size) ||
    update.size <= 0 ||
    update.size !== release.zipSize ||
    (release.zipHash && update.sha256.toLowerCase() !== release.zipHash) ||
    update.delta
  )
    throw new Error("Update download does not match the GitHub release");
  return manifest;
}
