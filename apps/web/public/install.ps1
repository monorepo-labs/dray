# Installs the `dray` CLI and its Claude Code skill on Windows: install.sh's
# twin, read beside it. The archive also carries `dray-serve`, and a first
# install ends in `dray setup`, which makes the machine a Dray server — except
# where the Dray app is installed, which runs its own.
#
#   irm https://www.drayhq.com/install.ps1 | iex
#
# Honours the same variables install.sh does:
#   DRAY_INSTALL_DIR      where the binaries land (default ~\.local\bin)
#   DRAY_VERSION          a specific release tag (default: the newest on the channel)
#   DRAY_CHANNEL          stable (default) or beta, which also takes stable releases
#   DRAY_CURRENT_VERSION  the tag already installed; stop unless the newest is newer
#   DRAY_UPDATING         set by `dray update`: no setup questions afterwards
#   DRAY_DOWNLOAD_BASE    where `<tag>/<archive>` is fetched from (default the
#                         GitHub releases), for a mirror or a test
#
# Everything sits in one function and errors are thrown, never `exit`: under
# `irm | iex` an `exit` closes the reader's own PowerShell window.

function Install-Dray {
  $ErrorActionPreference = "Stop"
  # Windows PowerShell 5.1 offers TLS 1.0 alone unless told otherwise.
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  # The progress bar slows Invoke-WebRequest's download several times over.
  $ProgressPreference = "SilentlyContinue"

  $repo = "monorepo-labs/dray"
  $installDir = if ($env:DRAY_INSTALL_DIR) { $env:DRAY_INSTALL_DIR } else { Join-Path $HOME ".local\bin" }
  $channel = if ($env:DRAY_CHANNEL) { $env:DRAY_CHANNEL } else { "stable" }
  $base = if ($env:DRAY_DOWNLOAD_BASE) { $env:DRAY_DOWNLOAD_BASE.TrimEnd("/") } else { "https://github.com/$repo/releases/download" }
  if ($channel -notin "stable", "beta") { throw "DRAY_CHANNEL must be stable or beta, not '$channel'." }

  # x64 alone. Windows on Arm runs it under emulation, which serves until an
  # arm64 build ships.
  $arch = $env:PROCESSOR_ARCHITEW6432
  if (-not $arch) { $arch = $env:PROCESSOR_ARCHITECTURE }
  if ($arch -notin "AMD64", "ARM64") { throw "unsupported architecture: $arch. dray builds for x64 Windows." }
  $target = "x86_64-pc-windows-msvc"

  # Whether tag $a is newer than tag $b: install.sh's `newer`. A beta sorts
  # below the release of its own version, so the release a beta led up to
  # replaces it and a stable hotfix never moves a beta install backwards.
  function Test-Newer([string]$a, [string]$b) {
    $a = $a -replace '^cli-v', ''; $b = $b -replace '^cli-v', ''
    if ($a -eq $b) { return $false }
    $coreA = ($a -split '-', 2)[0]; $coreB = ($b -split '-', 2)[0]
    if ($coreA -eq $coreB) {
      if ($a -eq $coreA) { return $true }
      if ($b -eq $coreB) { return $false }
    }
    # Four numeric fields, the fourth a beta's number (`0.12.0-beta.2`), as
    # install.sh's `sort -k1,1n -k2,2n -k3,3n -k4,4n` compares them.
    $fields = {
      param($v)
      $parts = ($v -replace '-[a-z]+\.', '.') -split '\.'
      0..3 | ForEach-Object { $n = 0; if ($_ -lt $parts.Count) { [void][int]::TryParse($parts[$_], [ref]$n) }; $n }
    }
    $fa = & $fields $a; $fb = & $fields $b
    for ($i = 0; $i -lt 4; $i++) {
      if ($fa[$i] -ne $fb[$i]) { return $fa[$i] -gt $fb[$i] }
    }
    return $false
  }

  # Every `cli-v*` tag from the releases API, never `/releases/latest/`: the
  # app and the CLI publish into one repo, so that URL belongs to whichever
  # went out last. Compared rather than taken in API order, which is not
  # version order. A beta tag carries a `-` after the version.
  function Resolve-Version {
    $releases = Invoke-RestMethod -UseBasicParsing "https://api.github.com/repos/$repo/releases?per_page=100"
    $tags = $releases | ForEach-Object { $_.tag_name } | Where-Object { $_ -like "cli-v*" }
    if ($channel -ne "beta") { $tags = $tags | Where-Object { $_ -notmatch '^cli-v[^-]*-' } }
    $best = $null
    foreach ($tag in $tags) { if (-not $best -or (Test-Newer $tag $best)) { $best = $tag } }
    return $best
  }

  # From the binary itself, so the skill always describes the CLI installed.
  # Run on the up-to-date path too, since `dray update` re-running this is the
  # only thing that rewrites a deleted or stale one.
  function Install-Skill {
    & (Join-Path $installDir "dray.exe") skill install
    if ($LASTEXITCODE) { Write-Host "Note: the skill could not be installed. Run 'dray skill install' by hand." }
  }

  # The user's PATH in the registry, so new terminals find dray, and this
  # session's too. Compared entry by entry, case and a trailing `\` aside.
  function Add-ToPath {
    $norm = { param($p) $p.TrimEnd("\").ToLowerInvariant() }
    $user = [Environment]::GetEnvironmentVariable("Path", "User")
    $entries = @($user -split ";" | Where-Object { $_ })
    if (-not ($entries | Where-Object { (& $norm ([Environment]::ExpandEnvironmentVariables($_))) -eq (& $norm $installDir) })) {
      [Environment]::SetEnvironmentVariable("Path", (($entries + $installDir) -join ";"), "User")
      Write-Host "Added $installDir to your PATH. New terminals will find dray."
    }
    if (-not ($env:Path -split ";" | Where-Object { $_ -and (& $norm $_) -eq (& $norm $installDir) })) {
      $env:Path = "$env:Path;$installDir"
    }
  }

  $version = $env:DRAY_VERSION
  if (-not $version -or $version -eq "latest") {
    Write-Host "Finding the latest dray release ($channel)..."
    try { $version = Resolve-Version } catch { $version = $null }
    # No falling back to an older pin: an unreachable API quietly installing
    # something ancient is the failure this refuses.
    if (-not $version) {
      throw "could not find a dray release. Set DRAY_VERSION to a tag from https://github.com/$repo/releases and re-run."
    }
    Write-Host "Latest is $version."

    # An explicit DRAY_VERSION stays a forced install of exactly that tag.
    # "Not newer" rather than "the same", so leaving beta never downgrades.
    $current = $env:DRAY_CURRENT_VERSION
    if ($current -and -not (Test-Newer $version $current)) {
      if ($version -eq $current) { Write-Host "dray $version is already installed." }
      else { Write-Host "dray $current is newer than $version; keeping it." }
      if (Test-Path (Join-Path $installDir "dray.exe")) { Install-Skill }
      Add-ToPath
      return
    }
  }

  $archive = "dray-$target.zip"
  $url = "$base/$version/$archive"
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("dray-install-" + [guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Force $tmp | Out-Null
  try {
    Write-Host "Downloading dray ($target)..."
    try { Invoke-WebRequest -UseBasicParsing $url -OutFile (Join-Path $tmp $archive) }
    catch { throw "could not download $url. Releases before Windows builds shipped have none; set DRAY_VERSION to a newer tag." }
    try { Invoke-WebRequest -UseBasicParsing "$url.sha256" -OutFile (Join-Path $tmp "$archive.sha256") }
    catch { throw "could not download the checksum for $url" }

    # Before unpacking: everything after treats the archive as trusted, and the
    # last step runs a binary out of it. A checksum published beside the
    # archive catches a truncated download or a bad mirror; it is not a
    # signature, as install.sh says.
    $expected = ((Get-Content (Join-Path $tmp "$archive.sha256") -Raw) -split '\s+')[0].ToLowerInvariant()
    $actual = (Get-FileHash -Algorithm SHA256 (Join-Path $tmp $archive)).Hash.ToLowerInvariant()
    if (-not $expected) { throw "the published checksum was empty; refusing to install." }
    if ($expected -ne $actual) { throw "checksum mismatch, refusing to install.`n    expected $expected`n    got      $actual" }
    Write-Host "Checksum verified."

    # .NET's unzip rather than Expand-Archive, whose progress bar Windows
    # PowerShell 5.1 draws over the output whatever $ProgressPreference says.
    $unpacked = Join-Path $tmp "unpacked"
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory((Join-Path $tmp $archive), $unpacked)
    if (-not (Test-Path (Join-Path $unpacked "dray.exe"))) { throw "the archive did not contain dray.exe" }

    New-Item -ItemType Directory -Force $installDir | Out-Null
    # Whether *this* archive is a server release, as install.sh asks it.
    $server = Test-Path (Join-Path $unpacked "dray-serve.exe")
    foreach ($bin in "dray.exe", "dray-serve.exe") {
      $from = Join-Path $unpacked $bin
      if (-not (Test-Path $from)) { continue }
      $to = Join-Path $installDir $bin
      # Windows will not overwrite a running exe, and `dray update` runs from
      # the one being replaced, but it will rename one. The renamed copy goes
      # once nothing runs it, here on a later install.
      Get-ChildItem $installDir -Filter "$bin.old-*" -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
      if (Test-Path $to) { Rename-Item $to ("$bin.old-" + [guid]::NewGuid().ToString("N").Substring(0, 8)) }
      Move-Item $from $to
      Write-Host "Installed $to"
    }
  } finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }

  Install-Skill
  Add-ToPath

  # The app records its own exe here on launch (cli.rs), as on Linux; a
  # `DRAY_HOME` of its own is a server apart from the app.
  $record = Join-Path $HOME ".local\share\dray\appimage"
  $appHere = (-not $env:DRAY_HOME) -and (Test-Path $record) -and (Test-Path ((Get-Content $record -Raw).Trim()))

  # Away from the app `dray` is only useful as a server, so a first install
  # goes on to set one up.
  if ($server -and -not $env:DRAY_UPDATING -and -not $appHere) {
    Write-Host ""
    & (Join-Path $installDir "dray.exe") setup
    return
  }
  Write-Host ""
  Write-Host "Done. Run 'dray --help' to get started, with the Dray app running."
}

Install-Dray
