<#
.SYNOPSIS
  Verify packed tarballs of the pnpm workspace (GrayCode x DSH).

.DESCRIPTION
  1. Optionally runs `pnpm build` and `pnpm pack` (root scripts) to produce the
     publishable tarballs (bundle + plugin; the private root package is excluded
     by the `pack` script's --filter).
  2. Collects every *.tgz under the tarball directory (default: repo root -
     `pnpm pack` in a workspace root writes all tarballs to the invoking cwd).
  3. For each tarball lists the archive entries with `tar -tzf` and checks:
       - blacklist: .env*, *.pem/*.key/*.p12/*.pfx, *secret*, node_modules/,
         .graycode data, .npmrc, .git metadata
       - absolute paths (POSIX `/`, Windows drive letters `C:\` / `C:/`, UNC)
       - path traversal (`..` segments)
       - entries outside the `package/` root (catches whole-repo junk tarballs)
       - `package/package.json` name/version matches the expected package
       - every relative `exports` target resolves to a packed file/path
     and reports per-package summary: entry count, tarball size, uncompressed
     size, README/LICENSE presence.
  4. Missing README/LICENSE is a warning by default; pass -Strict to make it a
     failure. Any blacklist / structure violation is always a failure.
  5. Exits 1 on any failure, 0 otherwise.

.PARAMETER SkipBuild
  Do not run `pnpm build` (tarballs must already exist).

.PARAMETER SkipPack
  Do not run `pnpm pack` (tarballs must already exist).

.PARAMETER Strict
  Treat missing README/LICENSE inside a tarball as a failure.

.PARAMETER TarballDir
  Directory to scan for *.tgz (default: repository root).

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File ./scripts/verify-pack.ps1

.EXAMPLE
  pwsh ./scripts/verify-pack.ps1 -SkipBuild -SkipPack   # CI after its own pack step
#>
[CmdletBinding()]
param(
  [switch]$SkipBuild,
  [switch]$SkipPack,
  [switch]$Strict,
  [string]$TarballDir = ''
)

# NOTE: no Set-StrictMode here - under StrictMode, accessing a missing JSON
# property (e.g. `$pkg.private` on a manifest without one) throws and would be
# swallowed by the try/catch below, silently emptying the expected list.
$ErrorActionPreference = 'Stop'

# Keep native-command output (tar listing, extracted package.json) byte-clean.
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $TarballDir) { $TarballDir = $repoRoot }
$TarballDir = [System.IO.Path]::GetFullPath($TarballDir)

$exitCode = 0
$warnings = 0

function Write-Step([string]$message) { Write-Host "==> $message" -ForegroundColor Cyan }

function Fail([string]$message) {
  Write-Host "FAIL: $message" -ForegroundColor Red
  $script:exitCode = 1
}

function Warn([string]$message) {
  Write-Host "WARN: $message" -ForegroundColor Yellow
  $script:warnings++
}

function Assert-Command([string]$name) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    Write-Host "FAIL: required command '$name' not found on PATH" -ForegroundColor Red
    exit 1
  }
}

function Get-StringLeaves($value) {
  if ($null -eq $value) { return @() }
  if ($value -is [string]) { return @($value) }
  $result = @()
  if ($value -is [System.Collections.IDictionary]) {
    foreach ($item in $value.Values) { $result += @(Get-StringLeaves $item) }
    return $result
  }
  if ($value -is [System.Collections.IEnumerable]) {
    foreach ($item in $value) { $result += @(Get-StringLeaves $item) }
    return $result
  }
  foreach ($property in $value.PSObject.Properties) {
    $result += @(Get-StringLeaves $property.Value)
  }
  return $result
}

function Get-TarEntries([string]$tgz) {
  # `tar -tzf` prints one member path per line; paths inside npm tarballs are
  # always POSIX `/`-separated and ASCII, so no encoding pitfalls.
  $raw = & tar -tzf $tgz 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "tar -tzf failed on $tgz`n$($raw -join [Environment]::NewLine)"
  }
  return @($raw | ForEach-Object { $_.ToString().TrimEnd("`r") } | Where-Object { $_ -ne '' })
}

function Get-TarUncompressedSize([string]$tgz) {
  # Total uncompressed bytes of the tar stream (headers + payload). Portable
  # across tar flavors; avoids parsing -tvzf column layouts.
  $fs = [System.IO.File]::OpenRead($tgz)
  try {
    $gz = New-Object System.IO.Compression.GZipStream(
      $fs, [System.IO.Compression.CompressionMode]::Decompress)
    try {
      $buf = New-Object byte[] 65536
      $total = [long]0
      while (($n = $gz.Read($buf, 0, $buf.Length)) -gt 0) { $total += $n }
      return $total
    } finally { $gz.Dispose() }
  } finally { $fs.Dispose() }
}

function Format-Bytes([long]$bytes) {
  if ($bytes -ge 1MB) { return '{0:N1} MB' -f ($bytes / 1MB) }
  if ($bytes -ge 1KB) { return '{0:N1} KB' -f ($bytes / 1KB) }
  return "$bytes B"
}

# ---------------------------------------------------------------------------
# 0. Build + pack (unless skipped)
# ---------------------------------------------------------------------------
if (-not $SkipBuild) {
  Write-Step "pnpm build"
  Push-Location $repoRoot
  try {
    & pnpm build
    if ($LASTEXITCODE -ne 0) { throw "pnpm build failed (exit $LASTEXITCODE)" }
  } finally { Pop-Location }
}

if (-not $SkipPack) {
  Write-Step "pnpm pack (removing stale *.tgz under $TarballDir first)"
  Get-ChildItem -Path $TarballDir -Filter '*.tgz' -File -ErrorAction SilentlyContinue |
    ForEach-Object { Write-Host "  removed stale $($_.Name)"; Remove-Item $_.FullName -Force }
  Push-Location $repoRoot
  try {
    # Root `pack` script excludes the private root package and packs only
    # publishable workspace packages; tarballs land in $TarballDir (cwd).
    & pnpm run pack
    if ($LASTEXITCODE -ne 0) { throw "pnpm pack failed (exit $LASTEXITCODE)" }
  } finally { Pop-Location }
}

# ---------------------------------------------------------------------------
# 1. Expected tarballs, derived from workspace manifests
# ---------------------------------------------------------------------------
Write-Step "Collecting tarballs from $TarballDir"
$expected = @()  # list of @{ File = 'name-version.tgz'; Package = 'pkg-name' }
foreach ($manifestPath in Get-ChildItem -Path (Join-Path $repoRoot 'packages') -Filter package.json -Recurse) {
  try { $pkg = [System.IO.File]::ReadAllText($manifestPath.FullName) | ConvertFrom-Json } catch { continue }
  $isPrivate = $pkg.PSObject.Properties['private'] -and $pkg.private
  if (-not $pkg.name -or $isPrivate) { continue }
  $plain = $pkg.name -replace '^@', '' -replace '/', '-'
  $expected += @{ File = "$plain-$($pkg.version).tgz"; Package = $pkg.name; Manifest = $manifestPath }
}

$tarballs = @(Get-ChildItem -Path $TarballDir -Filter '*.tgz' -File -ErrorAction SilentlyContinue)
if ($tarballs.Count -eq 0) {
  Write-Host "FAIL: no *.tgz found under $TarballDir - run 'pnpm pack' first (or drop -SkipPack)" -ForegroundColor Red
  exit 1
}

$expectedFiles = @($expected | ForEach-Object { $_.File })
$foundFiles = @($tarballs | ForEach-Object { $_.Name })
$unexpected = @($foundFiles | Where-Object { $_ -notin $expectedFiles })
$missing = @($expectedFiles | Where-Object { $_ -notin $foundFiles })

if ($unexpected.Count -gt 0) {
  Fail "unexpected tarballs not produced by any workspace package: $($unexpected -join ', ')"
}
if ($missing.Count -gt 0) {
  # Not a hard failure: the workspace may contain packages that are not part of
  # the pack set yet (e.g. an in-flight client package). They are reported so the
  # pack set stays visible; the tarball checks below still gate every artifact
  # that was actually produced.
  Warn "expected but not packed: $($missing -join ', ') - add them to the root 'pack' script when they become publishable"
}

# ---------------------------------------------------------------------------
# 2. Per-tarball inspection
# ---------------------------------------------------------------------------
# Blacklist patterns, applied to normalized POSIX entry paths (case-insensitive).
# The generic `*secret*` name rule was narrowed to key-material file shapes:
# the client package ships legitimate source modules named secrets.ts /
# SecretItemRow.tsx (settings contribution UI that renders credential refs
# without plaintext) — matching any file whose NAME contains "secret" would
# false-positive on them. The patterns below still catch every plausible
# secret carrier: .env variants, private key extensions, secrets directories,
# data files whose basename starts with "secret" / "secrets".
$blacklist = @(
  '(^|/)\.env($|[.])',             # .env, .env.local, .env.production etc.
  '\.(pem|key|p12|pfx)$',          # private key material
  '(^|/)\.?secrets?($|/)',         # secrets/ or .secrets/ directories (and a bare secrets file)
  '(^|/)[^/]*\.secret($|\.)',      # *.secret, *.secret.json etc.
  '(^|/)[^/]*secrets?\.(json|txt|yaml|yml|toml|ini|cfg|conf|env|local|prod|dev|backup|old|tar|gz|zip)$',
  '(^|/)node_modules(/|$)',        # node_modules residue
  '(^|/)\.graycode(/|$)',          # .graycode runtime data
  '(^|/)\.npmrc$',                 # npmrc may carry registry tokens
  '(^|/)\.git(/|$)'                # git metadata
)

foreach ($tgzFile in $tarballs) {
  $meta = $expected | Where-Object { $_.File -eq $tgzFile.Name } | Select-Object -First 1
  $label = if ($meta) { $meta.Package } else { $tgzFile.Name }
  Write-Host ""
  Write-Host "[tarball] $($tgzFile.Name) -> $label" -ForegroundColor Cyan

  $entries = Get-TarEntries $tgzFile.FullName
  $uncompressed = Get-TarUncompressedSize $tgzFile.FullName

  $violations = New-Object System.Collections.Generic.List[string]
  $hasReadme = $false
  $hasLicense = $false
  $manifestName = $null
  $manifestVersion = $null
  $m = $null

  foreach ($entry in $entries) {
    $raw = $entry

    # absolute path / drive letter / UNC - check on the RAW entry first, before
    # any './' trimming (TrimStart would otherwise eat a leading '/').
    if ($raw -match '^(/|\\|[A-Za-z]:[\\/]|\\\\)') {
      $violations.Add("absolute path: '$raw'")
      continue
    }

    # path traversal - checked on the RAW entry BEFORE any './' trimming:
    # TrimStart('./') is a character-set trim (any leading '.' or '/'), so it
    # would silently eat a leading '..' and bypass this check (4.21-L3).
    if ($raw -match '(^|/)\.\.(/|$)') {
      $violations.Add("path traversal '..': '$raw'")
      continue
    }

    $norm = $raw.TrimStart('./')
    # normalize backslashes to forward slashes for uniform matching
    $norm = $norm -replace '\\', '/'

    if ($norm -match '(^|/)[A-Za-z]:[\\/]') {
      $violations.Add("drive-letter path embedded: '$raw'")
      continue
    }
    # everything in a publishable npm tarball lives under package/
    if (-not $norm.StartsWith('package/')) {
      $violations.Add("entry outside package/ root: '$raw'")
      continue
    }

    $rel = $norm.Substring('package/'.Length)
    if ($rel -eq '') { continue }  # the package/ dir entry itself

    foreach ($pat in $blacklist) {
      if ($rel -match $pat) {
        $violations.Add("blacklist '$pat' -> '$raw'")
        break
      }
    }

    # README / LICENSE at the package root
    $seg = $rel.Split('/')[0]
    if (-not $hasReadme -and $seg -match '^README(\.|$)') { $hasReadme = $true }
    if (-not $hasLicense -and $seg -match '^LICENSE(\.|$)') { $hasLicense = $true }

    # record manifest identity from package/package.json
    if ($rel -eq 'package.json') {
      $manifestJson = (& tar -xOf $tgzFile.FullName 'package/package.json' 2>$null) -join "`n"
      if ($manifestJson) {
        try {
          $m = $manifestJson | ConvertFrom-Json
          $manifestName = $m.name
          $manifestVersion = $m.version
        } catch { }
      }
    }
  }

  # expected identity
  if ($meta) {
    if ($manifestName -and $manifestName -ne $meta.Package) {
      $violations.Add("package.json name mismatch: '$manifestName' != '$($meta.Package)'")
    }
    if ($manifestVersion -and $meta.Manifest) {
      try {
        $srcPkg = [System.IO.File]::ReadAllText($meta.Manifest.FullName) | ConvertFrom-Json
        if ($srcPkg.version -and $manifestVersion -ne $srcPkg.version) {
          $violations.Add("package.json version mismatch: '$manifestVersion' != '$($srcPkg.version)'")
        }
      } catch { }
    }
  }

  # Every relative package export must point at content that is actually in the
  # tarball. This catches manifests such as `./src/* -> ./src/*` when `src` is
  # excluded by the package `files` allowlist.
  if ($m -and $m.exports) {
    $normalizedEntries = @($entries | ForEach-Object { ($_ -replace '\\', '/').TrimStart('./') })
    foreach ($target in (Get-StringLeaves $m.exports | Sort-Object -Unique)) {
      if (-not $target.StartsWith('./')) { continue }
      $targetRel = $target.Substring(2)
      if ($targetRel.Contains('*')) {
        $prefix = $targetRel.Substring(0, $targetRel.IndexOf('*'))
        $found = @($normalizedEntries | Where-Object { $_.StartsWith("package/$prefix") }).Count -gt 0
      } else {
        $found = "package/$targetRel" -in $normalizedEntries
      }
      if (-not $found) {
        $violations.Add("exports target '$target' is absent from the tarball")
      }
    }
  }

  # bundle patch rows must be installable at runtime. `dsh plugin add` installs
  # the bundle's declared dependencies into the profile; every row name the
  # patch inserts (cordis:include loader entry) is imported from that
  # node_modules. A row without a matching `dependencies` entry boots into
  # ERR_MODULE_NOT_FOUND even though pack/verify pass on content alone.
  # (Regression guard for the graycode-client row missing from the bundle deps.)
  if ($manifestName -and $m.dsh -and $m.dsh.bundle -and $m.dsh.bundle.patch) {
    $patchRel = 'package/' + ($m.dsh.bundle.patch -replace '^\./', '')
    $patchRaw = (& tar -xOf $tgzFile.FullName $patchRel 2>$null) -join "`n"
    if (-not $patchRaw) {
      $violations.Add("bundle patch '$($m.dsh.bundle.patch)' missing from tarball")
    } else {
      $rowNames = @()
      $inInsert = $false
      foreach ($line in ($patchRaw -split "`r?`n")) {
        if (-not $inInsert) {
          if ($line -match '^\s*-\s*insert\s*:\s*$') { $inInsert = $true }
          continue
        }
        if ($line -match '^[^\s]') { $inInsert = $false; continue }  # next top-level op
        if ($line -match '^\s+-\s+name\s*:\s*["'']?([^"''\s#]+)') { $rowNames += $matches[1] }
        elseif ($line -match '^\s+name\s*:\s*["'']?([^"''\s#]+)') { $rowNames += $matches[1] }
      }
      $depNames = @($m.dependencies.PSObject.Properties.Name)
      $peerNames = @($m.peerDependencies.PSObject.Properties.Name)
      foreach ($row in ($rowNames | Sort-Object -Unique)) {
        if ($row -in $depNames) { continue }
        if ($row -in $peerNames) {
          Warn "$($tgzFile.Name): patch row '$row' is only a peerDependency - confirm pnpm auto-installs it in the profile"
        } else {
          $violations.Add("patch row '$row' is not declared in the bundle dependencies (profile boot fails: ERR_MODULE_NOT_FOUND)")
        }
      }
    }
  }

  $violationCount = $violations.Count
  foreach ($v in $violations) { Fail "$($tgzFile.Name): $v" }

  Write-Host ("  entries: {0} | tgz: {1} | uncompressed: {2}" -f `
    $entries.Count, (Format-Bytes $tgzFile.Length), (Format-Bytes $uncompressed))
  Write-Host ("  README: {0} | LICENSE: {1} | manifest: {2}@{3}" -f `
    $(if ($hasReadme) { 'present' } else { 'MISSING' }),
    $(if ($hasLicense) { 'present' } else { 'MISSING' }),
    $(if ($manifestName) { $manifestName } else { '?' }),
    $(if ($manifestVersion) { $manifestVersion } else { '?' }))

  if (-not $hasReadme) {
    if ($Strict) { Fail "$($tgzFile.Name): tarball contains no README (-Strict)" }
    else { Warn "$($tgzFile.Name): tarball contains no README (declared in 'files'? add one or drop it)" }
  }
  if (-not $hasLicense) {
    if ($Strict) { Fail "$($tgzFile.Name): tarball contains no LICENSE (-Strict)" }
    else { Warn "$($tgzFile.Name): tarball contains no LICENSE file" }
  }
  if ($violationCount -eq 0) { Write-Host '  violations: none' -ForegroundColor Green }
}

# ---------------------------------------------------------------------------
# 3. Summary
# ---------------------------------------------------------------------------
Write-Host ""
Write-Step "Summary"
Write-Host ("  tarballs verified: {0}" -f $tarballs.Count)
Write-Host ("  warnings: {0}" -f $warnings)
if ($exitCode -eq 0) {
  Write-Host "RESULT: PASS" -ForegroundColor Green
} else {
  Write-Host "RESULT: FAIL (see violations above)" -ForegroundColor Red
}
exit $exitCode
