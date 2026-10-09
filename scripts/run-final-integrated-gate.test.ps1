[CmdletBinding()]
param(
  [switch]$TimeoutOnly,
  [switch]$CommandOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'run-final-integrated-gate.ps1') `
  -OutputRoot 'Z:\twilight-final-gate-static-dry-run' `
  -CandidateName 'final-integrated-selftest' `
  -NativeBuildDir 'C:\twilight-build\mingw-final-integrated-v2' `
  -DryRun | Out-Null

$tests = 0
function Assert-True {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw $Message }
  $script:tests += 1
}

function Assert-Equal {
  param($Actual, $Expected, [string]$Message)
  if ($Actual -ne $Expected) { throw "$Message; expected=[$Expected], actual=[$Actual]" }
  $script:tests += 1
}

function Assert-Throws {
  param([scriptblock]$Action, [string]$Message, [string]$Pattern)
  $caught = $null
  try { & $Action } catch { $caught = $_ }
  if ($null -eq $caught) { throw $Message }
  if ($Pattern -and $caught.Exception.Message -notmatch $Pattern) {
    throw "$Message; wrong failure: $($caught.Exception.Message)"
  }
  $script:tests += 1
}

function Invoke-BoundedSelfTestCleanup {
  param(
    [Parameter(Mandatory = $true)][string]$Parent,
    [Parameter(Mandatory = $true)][string]$Target,
    [int]$DeadlineMilliseconds = 5000
  )
  if (-not (Test-Path -LiteralPath $Target)) { return $true }
  $parentPhysical = Get-PhysicalCanonicalPath $Parent
  $targetPhysical = Get-PhysicalCanonicalPath $Target
  $targetParent = [System.IO.Directory]::GetParent($targetPhysical)
  if (-not $targetParent -or
      -not $targetParent.FullName.TrimEnd('\', '/').Equals($parentPhysical, [System.StringComparison]::OrdinalIgnoreCase) -or
      $targetPhysical.Equals($parentPhysical, [System.StringComparison]::OrdinalIgnoreCase)) {
    Write-Warning "Self-test cleanup refused unsafe path; retained: $targetPhysical"
    return $false
  }

  $escaped = $Target.Replace("'", "''")
  $cleanupCommand = "Remove-Item -LiteralPath '$escaped' -Recurse -Force -ErrorAction Stop"
  $encoded = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($cleanupCommand))
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = 'powershell.exe'
  $psi.Arguments = "-NoProfile -NonInteractive -EncodedCommand $encoded"
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $process = New-Object System.Diagnostics.Process
  try {
    $process.StartInfo = $psi
    if (-not $process.Start()) {
      Write-Warning "Self-test cleanup could not start; retained: $Target"
      return $false
    }
    if (-not $process.WaitForExit($DeadlineMilliseconds)) {
      try { $process.Kill() } catch {}
      [void]$process.WaitForExit(1000)
      Write-Warning "Self-test cleanup exceeded its hard deadline; retained or partially retained: $Target"
      return $false
    }
    if ($process.ExitCode -ne 0 -or (Test-Path -LiteralPath $Target)) {
      Write-Warning "Self-test cleanup failed; retained or partially retained: $Target"
      return $false
    }
    return $true
  } finally {
    $process.Dispose()
  }
}

function Test-ProcessGone {
  param([int]$Id)
  if ($Id -le 0) { return $false }
  return $null -eq (Get-Process -Id $Id -ErrorAction SilentlyContinue)
}

function Assert-CommandCaptureClean {
  param($Result, [string]$Label)
  Assert-Equal @($Result.captureFilesRemaining).Count 0 "$Label must remove all capture artifacts"
  Assert-True (@($Result.capturePaths | Where-Object { Test-Path -LiteralPath $_ }).Count -eq 0) "$Label capture paths must not remain on disk"
}

function Invoke-RealCommandExecutionSelfTests {
  param([Parameter(Mandatory = $true)][string]$Root)
  $commandRoot = Join-Path $Root 'real-command-execution'
  $commandLogs = Join-Path $commandRoot 'logs'
  [System.IO.Directory]::CreateDirectory($commandLogs) | Out-Null
  $script:CandidatePath = $commandRoot
  $script:LogsRoot = $commandLogs

  $corepack = Invoke-CommandProcess -Command 'corepack pnpm@11.7.0 --version' -TimeoutSeconds 60
  Assert-Equal ([int]$corepack.exitCode) 0 'Direct corepack.cmd execution must return success'
  Assert-True (-not $corepack.timedOut -and $corepack.terminationConfirmed) 'Direct corepack.cmd execution must terminate normally'
  Assert-Equal $corepack.stdout.Trim() '11.7.0' 'Direct corepack.cmd execution must preserve stdout'
  Assert-CommandCaptureClean $corepack 'Direct corepack.cmd execution'

  $environmentChain = Invoke-CommandProcess -Command 'set "TWILIGHT_FINAL_GATE_SELFTEST=env-ok" && corepack pnpm@11.7.0 --version && node -e "process.stdout.write(''|'' + process.env.TWILIGHT_FINAL_GATE_SELFTEST)"' -TimeoutSeconds 60
  Assert-Equal ([int]$environmentChain.exitCode) 0 'set && corepack.cmd && node chain must return success'
  Assert-True ($environmentChain.stdout -match '(?m)^11\.7\.0\s*\|env-ok$') 'Batch command chains must continue after corepack.cmd and preserve their environment'
  Assert-CommandCaptureClean $environmentChain 'set/corepack/node chain'

  $quotedNode = Invoke-CommandProcess -Command 'node -e "const payload = { text: ''nested quote value'' }; process.stdout.write(JSON.stringify(payload))"' -TimeoutSeconds 30
  Assert-Equal ([int]$quotedNode.exitCode) 0 'Quoted Node command must return success'
  Assert-Equal $quotedNode.stdout '{"text":"nested quote value"}' 'Nested command quotes must reach Node byte-for-byte'
  Assert-CommandCaptureClean $quotedNode 'Quoted Node command'

  $ctest = Invoke-CommandProcess -Command 'ctest --version' -TimeoutSeconds 30
  Assert-Equal ([int]$ctest.exitCode) 0 'Native ctest executable must return success'
  Assert-True ($ctest.stdout -match 'ctest version') 'Native ctest executable must preserve stdout'
  Assert-CommandCaptureClean $ctest 'ctest command'

  $failure = Invoke-CommandProcess -Command 'node -e "process.stderr.write(''expected-failure''); process.exit(23)"' -TimeoutSeconds 30
  Assert-Equal ([int]$failure.exitCode) 23 'Failing commands must preserve their exact exit code'
  Assert-True (-not $failure.timedOut -and $failure.terminationConfirmed) 'Failing commands must still terminate cleanly'
  Assert-Equal $failure.stderr 'expected-failure' 'Failing commands must preserve stderr'
  Assert-CommandCaptureClean $failure 'Failing Node command'

  $savedComSpec = $env:ComSpec
  try {
    $env:ComSpec = Join-Path $commandRoot 'missing-cmd.exe'
    Assert-Throws { Invoke-CommandProcess -Command 'node --version' -TimeoutSeconds 5 | Out-Null } 'Process startup failures must be propagated after cleanup'
  } finally {
    $env:ComSpec = $savedComSpec
  }
  Assert-True (@(Get-ChildItem -LiteralPath $commandLogs -Force -Filter '.capture-*').Count -eq 0) 'Process startup failure must not leave capture artifacts'
}

function Invoke-TimeoutTreeSelfTest {
  param([Parameter(Mandatory = $true)][string]$Root)
  $timeoutRoot = Join-Path $Root 'job-timeout'
  $timeoutLogs = Join-Path $timeoutRoot 'logs'
  [System.IO.Directory]::CreateDirectory($timeoutLogs) | Out-Null
  $commandPidPath = Join-Path $timeoutRoot 'command.pid'
  $childPidPath = Join-Path $timeoutRoot 'child.pid'
  $probeScript = Join-Path $timeoutRoot 'tree-probe.ps1'
  Write-Utf8File -Path $probeScript -Text @'
param([string]$CommandPidPath, [string]$ChildPidPath)
[System.IO.File]::WriteAllText($CommandPidPath, [string]$PID)
$child = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 120') -PassThru
[System.IO.File]::WriteAllText($ChildPidPath, [string]$child.Id)
Start-Sleep -Seconds 120
'@

  $script:LogsRoot = $timeoutLogs
  $script:CandidatePath = $timeoutRoot
  $command = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$probeScript`" -CommandPidPath `"$commandPidPath`" -ChildPidPath `"$childPidPath`""
  $started = [DateTime]::UtcNow
  # Windows PowerShell cold start can take several seconds on loaded hosts. The timeout
  # must fire only after both descendant PID files prove the complete test tree existed.
  $result = Invoke-CommandProcess -Command $command -TimeoutSeconds 6
  $elapsed = ([DateTime]::UtcNow - $started).TotalSeconds

  Assert-True $result.timedOut 'Timeout probe must report timedOut'
  Assert-True $result.terminationConfirmed 'Timeout probe must confirm process-tree termination and capture cleanup'
  Assert-Equal ([int]$result.exitCode) 124 'Timeout probe must use the timeout exit code'
  Assert-True ($elapsed -lt 20) 'Timeout probe must respect its secondary hard deadlines'
  Assert-True (Test-Path -LiteralPath $commandPidPath -PathType Leaf) 'Timeout probe must record the command PID before termination'
  Assert-True (Test-Path -LiteralPath $childPidPath -PathType Leaf) 'Timeout probe must record the child PID before termination'

  $pids = @([int]$result.processId, [int](Get-Content -LiteralPath $commandPidPath -Raw), [int](Get-Content -LiteralPath $childPidPath -Raw))
  $pidDeadline = [DateTime]::UtcNow.AddSeconds(3)
  do {
    $live = @($pids | Where-Object { -not (Test-ProcessGone $_) })
    if ($live.Count -eq 0) { break }
    Start-Sleep -Milliseconds 50
  } while ([DateTime]::UtcNow -lt $pidDeadline)
  Assert-True ($live.Count -eq 0) "Timeout probe left related PIDs alive: $($live -join ', ')"
  Assert-Equal @($result.captureFilesRemaining).Count 0 'Timeout probe must close and delete all capture artifacts'
  Assert-True (@($result.capturePaths | Where-Object { Test-Path -LiteralPath $_ }).Count -eq 0) 'Timeout probe capture paths must not remain on disk'
}

$workspaceRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$selfTestParent = Join-Path $workspaceRoot '.tmp-final-gate-selftest'
[System.IO.Directory]::CreateDirectory($selfTestParent) | Out-Null
$root = Join-Path $selfTestParent ([Guid]::NewGuid().ToString('N'))
[System.IO.Directory]::CreateDirectory($root) | Out-Null
$nativeExternal = $null

try {
  if ($CommandOnly) {
    Invoke-RealCommandExecutionSelfTests -Root $root
    Write-Host "run-final-integrated-gate command self-tests passed: $tests"
    return
  }
  Invoke-TimeoutTreeSelfTest -Root $root
  if ($TimeoutOnly) {
    Write-Host "run-final-integrated-gate timeout self-tests passed: $tests"
    return
  }
  Invoke-RealCommandExecutionSelfTests -Root $root

  $source = Join-Path $root 'source'
  $output = Join-Path $root 'output'
  $candidate = Join-Path $output 'candidate'
  $external = Join-Path $root 'external'
  [System.IO.Directory]::CreateDirectory($source) | Out-Null
  [System.IO.Directory]::CreateDirectory($candidate) | Out-Null
  [System.IO.Directory]::CreateDirectory($external) | Out-Null

  Assert-Throws { Assert-SafeLeafName -Name '..\escape' -Label candidate } 'Traversal leaf must be rejected' 'single safe path segment'
  Assert-Throws { Assert-SafeLeafName -Name 'nested/name' -Label candidate } 'Nested leaf must be rejected' 'single safe path segment'
  Assert-Throws { Resolve-SafeRelativePath -Root $root -RelativePath '../escape.log' -Label log } 'Relative traversal must be rejected' 'without traversal'
  Assert-Throws { Resolve-SafeRelativePath -Root $root -RelativePath 'C:\escape.log' -Label log } 'Rooted relative path must be rejected' 'non-rooted'
  Assert-Throws { Assert-PathsDoNotOverlap -Left $source -Right (Join-Path $source 'nested') -Label test } 'Ancestor paths must be rejected' 'overlap physically'
  Assert-Throws { Assert-PathsDoNotOverlap -Left $source -Right $source -Label test } 'Equal paths must be rejected' 'overlap physically'
  Assert-Throws { Assert-DirectPhysicalChild -Parent $output -Child (Join-Path $candidate 'grandchild') -Label test } 'Non-direct children must be rejected' 'direct physical child'

  $junction = Join-Path $root 'junction-to-source'
  New-Item -ItemType Junction -Path $junction -Target $source | Out-Null
  Assert-Throws { Assert-PathsDoNotOverlap -Left $source -Right $junction -Label reparse } 'Reparse escape must resolve to its physical target' 'overlap physically'
  $candidateJunction = Join-Path $candidate 'escape-to-source'
  New-Item -ItemType Junction -Path $candidateJunction -Target $source | Out-Null
  Assert-Throws { Resolve-SafeRelativePath -Root $candidate -RelativePath 'escape-to-source/escaped.txt' -Label reparse } 'Safe relative resolver must reject a reparse escape' 'escaped its physical root'

  $script:SourceRoot = $source
  $script:OutputRoot = $output
  $script:CandidatePath = $candidate
  $script:ExternalToolRoot = $external
  $script:ElectronLeafName = 'electron-final-integrated-v2'
  $script:NativeLeafName = 'mingw-final-integrated-v2'
  $CandidateName = 'candidate'
  Assert-CriticalPathPolicy
  Assert-Throws {
    Assert-FixedExternalLeaf -Path (Join-Path $external 'attacker-controlled') -ExpectedLeaf $script:ElectronLeafName -Label electron
  } 'Electron override must be restricted to its fixed owned leaf' 'restricted to the owned leaf'

  $nonOwned = Join-Path $external $script:ElectronLeafName
  [System.IO.Directory]::CreateDirectory($nonOwned) | Out-Null
  Assert-Throws { Read-ValidatedOwnerMarker -Root $nonOwned -Kind electron } 'Existing non-owned Electron directory must fail closed' 'not owned'
  Write-OwnerMarker -Root $nonOwned -Kind electron -PlanDigest ('a' * 64)
  $ownerPath = Get-OwnerMarkerPath $nonOwned
  $owner = Get-Content -LiteralPath $ownerPath -Raw | ConvertFrom-Json
  $owner.outputRootPhysical = Get-PhysicalCanonicalPath $source
  Write-JsonFile -Path $ownerPath -Value $owner
  Assert-Throws { Read-ValidatedOwnerMarker -Root $nonOwned -Kind electron } 'Ownership marker from another output root must fail closed' 'does not match'

  $manifestRoot = Join-Path $root 'manifest-root'
  [System.IO.Directory]::CreateDirectory($manifestRoot) | Out-Null
  $manifestJunction = Join-Path $manifestRoot 'outside'
  New-Item -ItemType Junction -Path $manifestJunction -Target $source | Out-Null
  Assert-Throws { Get-DirectoryManifest -Root $manifestRoot } 'Directory manifests must reject reparse points' 'reparse point'

  $electronCandidate = Join-Path $root 'electron-candidate'
  $electronEvidence = Join-Path $electronCandidate 'evidence'
  $electronDist = Join-Path $electronCandidate 'node_modules\electron\dist'
  $electronExternal = Join-Path $root 'electron-external'
  [System.IO.Directory]::CreateDirectory($electronEvidence) | Out-Null
  [System.IO.Directory]::CreateDirectory((Join-Path $electronDist 'resources')) | Out-Null
  [System.IO.Directory]::CreateDirectory($electronExternal) | Out-Null
  Write-Utf8File -Path (Join-Path $electronDist 'electron.exe') -Text 'candidate-electron-v1'
  Write-Utf8File -Path (Join-Path $electronDist 'resources\icudtl.dat') -Text 'candidate-resource-v1'

  $script:CandidatePath = $electronCandidate
  $script:EvidenceRoot = $electronEvidence
  $script:ExternalToolRoot = $electronExternal
  $script:SourceManifestSha256 = ('1' * 64)
  $script:PlanDigest = ('2' * 64)
  $ElectronDistOverride = Join-Path $electronExternal $script:ElectronLeafName
  [System.IO.Directory]::CreateDirectory($ElectronDistOverride) | Out-Null
  $script:RunId = [Guid]::NewGuid().ToString('D')
  Write-OwnerMarker -Root $ElectronDistOverride -Kind electron -SourceManifestSha256 ('3' * 64) -PlanDigest ('4' * 64) -OwnerCandidateName 'old-electron-candidate'
  Write-Utf8File -Path (Join-Path $ElectronDistOverride 'old-plan-sentinel.txt') -Text 'old electron plan'
  $oldElectronOwner = Read-ValidatedOwnerMarker -Root $ElectronDistOverride -Kind electron

  $electronArchiveRunId = [Guid]::NewGuid().ToString('D')
  $script:RunId = $electronArchiveRunId
  $electronArchive = Join-Path $electronExternal "failed-$($script:ElectronLeafName)-$electronArchiveRunId"
  Initialize-ElectronOverride
  Assert-True (Test-Path -LiteralPath $electronArchive -PathType Container) 'A valid old-plan Electron leaf must be archived under the current RunId'
  Assert-True (Test-Path -LiteralPath (Join-Path $electronArchive 'old-plan-sentinel.txt') -PathType Leaf) 'The old-plan Electron contents must move into the archive'
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $ElectronDistOverride 'old-plan-sentinel.txt'))) 'The fresh Electron leaf must not retain old-plan contents'
  $archivedElectronOwner = Read-ValidatedOwnerMarker -Root $electronArchive -Kind electron
  Assert-Equal ([string]$archivedElectronOwner.schemaVersion) ([string]$oldElectronOwner.schemaVersion) 'The archived Electron leaf must retain its owner schema'
  Assert-Equal ([string]$archivedElectronOwner.managedBy) ([string]$oldElectronOwner.managedBy) 'The archived Electron leaf must retain its owner manager'
  Assert-Equal ([string]$archivedElectronOwner.candidateName) ([string]$oldElectronOwner.candidateName) 'The archived Electron leaf must retain its original candidate provenance'
  Assert-Equal ([string]$archivedElectronOwner.runId) ([string]$oldElectronOwner.runId) 'The archived Electron leaf must retain its original run provenance'
  Assert-Equal ([string]$archivedElectronOwner.sourceManifestSha256) ([string]$oldElectronOwner.sourceManifestSha256) 'The archived Electron leaf must retain its original source provenance'
  Assert-Equal ([string]$archivedElectronOwner.planDigest) ([string]$oldElectronOwner.planDigest) 'The archived Electron leaf must retain its original plan provenance'
  Assert-Equal ([string]$archivedElectronOwner.leafName) (Split-Path -Leaf $electronArchive) 'The archived Electron marker must bind the archive leaf name'
  Assert-Equal ([string]$archivedElectronOwner.physicalPath) (Get-PhysicalCanonicalPath $electronArchive) 'The archived Electron marker must bind the archive physical path'
  Assert-Equal ([string]$archivedElectronOwner.outputRootPhysical) (Get-PhysicalCanonicalPath $output) 'The archived Electron marker must retain the current output-root binding'
  $electronArchiveEvidence = Get-Content -LiteralPath (Join-Path $electronEvidence 'electron-override-manifest.json') -Raw | ConvertFrom-Json
  Assert-Equal ([string]$electronArchiveEvidence.archivedMismatchedCopy) $electronArchive 'Electron evidence must identify the validated owned archive'
  [void](Read-ValidatedOwnerMarker -Root ([string]$electronArchiveEvidence.archivedMismatchedCopy) -Kind electron)
  $freshElectronOwner = Read-ValidatedOwnerMarker -Root $ElectronDistOverride -Kind electron -RequireCurrentPlan
  Assert-Equal ([string]$freshElectronOwner.runId) $electronArchiveRunId 'The fresh Electron leaf must be owned by the archiving run'

  $electronReuseRunId = [Guid]::NewGuid().ToString('D')
  $script:RunId = $electronReuseRunId
  Initialize-ElectronOverride
  $electronReuseEvidence = Get-Content -LiteralPath (Join-Path $electronEvidence 'electron-override-manifest.json') -Raw | ConvertFrom-Json
  Assert-True ([bool]$electronReuseEvidence.reusedExistingIdenticalCopy) 'A current-plan byte-identical Electron leaf must be reused'
  Assert-True ($null -eq $electronReuseEvidence.archivedMismatchedCopy) 'Reusing an identical Electron leaf must not create an archive'
  $reusedElectronOwner = Read-ValidatedOwnerMarker -Root $ElectronDistOverride -Kind electron -RequireCurrentPlan
  Assert-Equal ([string]$reusedElectronOwner.runId) $electronArchiveRunId 'Electron reuse must preserve the original owner run'
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $electronExternal "failed-$($script:ElectronLeafName)-$electronReuseRunId"))) 'Electron reuse must not create an archive directory'

  Write-Utf8File -Path (Join-Path $electronDist 'electron.exe') -Text 'candidate-electron-v2'
  $currentPlanOwnerBeforeMismatch = Read-ValidatedOwnerMarker -Root $ElectronDistOverride -Kind electron -RequireCurrentPlan
  $electronMismatchRunId = [Guid]::NewGuid().ToString('D')
  $script:RunId = $electronMismatchRunId
  $electronMismatchArchive = Join-Path $electronExternal "failed-$($script:ElectronLeafName)-$electronMismatchRunId"
  Initialize-ElectronOverride
  $mismatchedElectronArchiveOwner = Read-ValidatedOwnerMarker -Root $electronMismatchArchive -Kind electron
  Assert-Equal ([string]$mismatchedElectronArchiveOwner.planDigest) ([string]$currentPlanOwnerBeforeMismatch.planDigest) 'A current-plan mismatched Electron archive must retain its plan provenance'
  Assert-Equal ([string]$mismatchedElectronArchiveOwner.runId) ([string]$currentPlanOwnerBeforeMismatch.runId) 'A current-plan mismatched Electron archive must retain its run provenance'
  Assert-True (Test-Path -LiteralPath (Join-Path $electronMismatchArchive 'electron.exe') -PathType Leaf) 'A current-plan mismatched Electron leaf must be archived before replacement'
  Assert-Equal ([System.IO.File]::ReadAllText((Join-Path $ElectronDistOverride 'electron.exe'))) 'candidate-electron-v2' 'A mismatched Electron leaf must be replaced with the current candidate dist'
  $mismatchEvidence = Get-Content -LiteralPath (Join-Path $electronEvidence 'electron-override-manifest.json') -Raw | ConvertFrom-Json
  Assert-Equal ([string]$mismatchEvidence.archivedMismatchedCopy) $electronMismatchArchive 'Mismatch evidence must identify the validated owned archive'
  [void](Read-ValidatedOwnerMarker -Root ([string]$mismatchEvidence.archivedMismatchedCopy) -Kind electron)

  Write-Utf8File -Path (Join-Path $electronDist 'electron.exe') -Text 'candidate-electron-v3'
  $electronCollisionRunId = [Guid]::NewGuid().ToString('D')
  $script:RunId = $electronCollisionRunId
  $electronCollisionArchive = Join-Path $electronExternal "failed-$($script:ElectronLeafName)-$electronCollisionRunId"
  [System.IO.Directory]::CreateDirectory($electronCollisionArchive) | Out-Null
  Write-Utf8File -Path (Join-Path $electronCollisionArchive 'collision-sentinel.txt') -Text 'electron collision'
  $electronOwnerHashBeforeCollision = Get-Sha256File (Get-OwnerMarkerPath $ElectronDistOverride)
  $electronCopyHashBeforeCollision = Get-Sha256File (Join-Path $ElectronDistOverride 'electron.exe')
  Assert-Throws { Initialize-ElectronOverride } 'Electron archive collisions must fail closed' 'Electron archive path exists'
  Assert-True (Test-Path -LiteralPath (Join-Path $electronCollisionArchive 'collision-sentinel.txt') -PathType Leaf) 'Electron archive collision contents must remain untouched'
  Assert-Equal (Get-Sha256File (Get-OwnerMarkerPath $ElectronDistOverride)) $electronOwnerHashBeforeCollision 'Electron source ownership must remain untouched after an archive collision'
  Assert-Equal (Get-Sha256File (Join-Path $ElectronDistOverride 'electron.exe')) $electronCopyHashBeforeCollision 'Electron source contents must remain untouched after an archive collision'

  $electronSourceReparse = Join-Path $electronDist 'reparse-source'
  New-Item -ItemType Junction -Path $electronSourceReparse -Target $source | Out-Null
  Assert-Throws { Initialize-ElectronOverride } 'Electron source manifests must reject reparse points before moving an owned destination' 'reparse point'
  Assert-Equal (Get-Sha256File (Get-OwnerMarkerPath $ElectronDistOverride)) $electronOwnerHashBeforeCollision 'Electron ownership must remain untouched when the source dist contains a reparse point'
  Assert-Equal (Get-Sha256File (Join-Path $ElectronDistOverride 'electron.exe')) $electronCopyHashBeforeCollision 'Electron contents must remain untouched when the source dist contains a reparse point'

  $ElectronDistOverride = Join-Path $electronExternal 'attacker-controlled'
  Assert-Throws { Initialize-ElectronOverride } 'Electron override paths must remain restricted to the fixed owned leaf' 'restricted to the owned leaf'
  $electronReparseExternal = Join-Path $root 'electron-reparse-external'
  $electronReparseTarget = Join-Path $root 'electron-reparse-target'
  [System.IO.Directory]::CreateDirectory($electronReparseExternal) | Out-Null
  [System.IO.Directory]::CreateDirectory($electronReparseTarget) | Out-Null
  $script:ExternalToolRoot = $electronReparseExternal
  $ElectronDistOverride = Join-Path $electronReparseExternal $script:ElectronLeafName
  New-Item -ItemType Junction -Path $ElectronDistOverride -Target $electronReparseTarget | Out-Null
  Assert-Throws { Initialize-ElectronOverride } 'Electron override reparse redirection must be rejected' 'direct physical child'
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $electronReparseTarget '.twilight-final-gate-owner.json'))) 'Rejected Electron reparse targets must not receive ownership markers'

  $script:CandidatePath = $candidate
  $script:EvidenceRoot = Join-Path $candidate 'evidence'
  $script:ExternalToolRoot = $external
  $ElectronDistOverride = $null

  $operationalCandidate = Join-Path $root 'operational-candidate'
  [System.IO.Directory]::CreateDirectory($operationalCandidate) | Out-Null
  New-Item -ItemType Junction -Path (Join-Path $operationalCandidate 'evidence') -Target $source | Out-Null
  [System.IO.Directory]::CreateDirectory((Join-Path $operationalCandidate 'logs')) | Out-Null
  $script:CandidatePath = $operationalCandidate
  $script:EvidenceRoot = Join-Path $operationalCandidate 'evidence'
  $script:LogsRoot = Join-Path $operationalCandidate 'logs'
  Assert-Throws { Assert-GateOperationalRoots } 'Operational evidence/log roots must reject reparse redirection' 'direct physical child|reparse point'
  $script:CandidatePath = $candidate

  $invalidArchive = Join-Path $output 'invalid-candidate'
  $invalidEvidence = Join-Path $invalidArchive 'evidence'
  [System.IO.Directory]::CreateDirectory($invalidEvidence) | Out-Null
  $invalidManifestPath = Join-Path $invalidEvidence 'source-manifest.json'
  Write-JsonFile -Path $invalidManifestPath -Value ([ordered]@{ schemaVersion = 1; candidate = 'invalid-candidate' })
  $invalidManifestHash = Get-Sha256File $invalidManifestPath
  Write-Utf8File -Path (Join-Path $invalidEvidence 'source-manifest.sha256') -Text "$invalidManifestHash *source-manifest.json`n"
  Write-JsonFile -Path (Join-Path $invalidEvidence 'freeze-result.json') -Value ([ordered]@{ candidatePath = $invalidArchive })
  Assert-Throws { Move-ManagedInvalidCandidate -InvalidName 'invalid-candidate' } 'Evidence alone must never authorize an arbitrary move' 'pre-existing ownership marker'
  Assert-True (Test-Path -LiteralPath $invalidArchive -PathType Container) 'Rejected archive source must remain in place'
  Write-OwnerMarker -Root $invalidArchive -Kind candidate -SourceManifestSha256 ('0' * 64) -OwnerCandidateName 'invalid-candidate'
  Assert-Throws { Move-ManagedInvalidCandidate -InvalidName 'invalid-candidate' } 'Wrong marker digest must not authorize a move' 'another source manifest'
  Write-OwnerMarker -Root $invalidArchive -Kind candidate -SourceManifestSha256 $invalidManifestHash -OwnerCandidateName 'invalid-candidate'
  Move-ManagedInvalidCandidate -InvalidName 'invalid-candidate'
  Assert-True (-not (Test-Path -LiteralPath $invalidArchive)) 'A fully bound owned candidate must be archived'
  Assert-True (Test-Path -LiteralPath (Join-Path $output 'failed-invalid-candidate-source-changed') -PathType Container) 'Owned archive destination must be deterministic and contained'

  $nativeExternal = Join-Path ([System.IO.Path]::GetTempPath()) "twilight-final-gate-native-$([Guid]::NewGuid().ToString('N'))"
  if ($nativeExternal -match '\s') { throw "Native ownership self-test requires a no-whitespace system temp path: $nativeExternal" }
  [System.IO.Directory]::CreateDirectory($nativeExternal) | Out-Null
  $script:ExternalToolRoot = $nativeExternal
  $script:PlanDigest = ('a' * 64)
  $nativeOwned = Join-Path $nativeExternal $script:NativeLeafName
  [System.IO.Directory]::CreateDirectory($nativeOwned) | Out-Null
  Write-OwnerMarker -Root $nativeOwned -Kind native -SourceManifestSha256 ('b' * 64) -PlanDigest $script:PlanDigest
  Write-Utf8File -Path (Join-Path $nativeOwned 'old-plan-sentinel.txt') -Text 'old plan'
  $oldNativeOwner = Read-ValidatedOwnerMarker -Root $nativeOwned -Kind native -RequireCurrentPlan
  [void](Read-ValidatedOwnerMarker -Root $nativeOwned -Kind native -RequireCurrentPlan)
  $script:PlanDigest = ('c' * 64)
  Assert-Throws { Read-ValidatedOwnerMarker -Root $nativeOwned -Kind native -RequireCurrentPlan } 'Native owner marker must bind the resume plan digest' 'different gate plan'

  $NativeBuildDir = $nativeOwned
  $Resume = $false
  $archiveRunId = [Guid]::NewGuid().ToString('D')
  $script:RunId = $archiveRunId
  $nativeArchive = Join-Path $nativeExternal "failed-$($script:NativeLeafName)-$archiveRunId"
  Assert-Equal (Initialize-NativeBuildDirectory -Path $NativeBuildDir) $nativeOwned 'A new run must initialize the fixed native leaf after archiving a valid old-plan owner'
  Assert-True (Test-Path -LiteralPath $nativeArchive -PathType Container) 'A valid old-plan native leaf must be archived under the current RunId'
  Assert-True (Test-Path -LiteralPath (Join-Path $nativeArchive 'old-plan-sentinel.txt') -PathType Leaf) 'The old-plan native contents must move into the archive'
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $nativeOwned 'old-plan-sentinel.txt'))) 'The fresh native leaf must not retain old-plan build contents'
  $archivedNativeOwner = Read-ValidatedOwnerMarker -Root $nativeArchive -Kind native
  Assert-Equal ([string]$archivedNativeOwner.planDigest) ('a' * 64) 'The archived native leaf must retain its old plan binding'
  Assert-Equal ([string]$archivedNativeOwner.runId) ([string]$oldNativeOwner.runId) 'The archived native leaf must retain its original run owner'
  Assert-Equal ([string]$archivedNativeOwner.sourceManifestSha256) ([string]$oldNativeOwner.sourceManifestSha256) 'The archived native leaf must retain its original source binding'
  $currentNativeOwner = Read-ValidatedOwnerMarker -Root $nativeOwned -Kind native -RequireCurrentPlan
  Assert-Equal ([string]$currentNativeOwner.runId) $archiveRunId 'The fresh native leaf must be owned by the new run'

  Write-Utf8File -Path (Join-Path $nativeOwned 'current-plan-sentinel.txt') -Text 'current plan'
  $newRunId = [Guid]::NewGuid().ToString('D')
  $script:RunId = $newRunId
  Assert-Throws {
    Initialize-NativeBuildDirectory -Path $NativeBuildDir | Out-Null
  } 'A new run must reject a native leaf already owned by its current plan' 'already owned by the current gate plan; use -Resume'
  Assert-True (Test-Path -LiteralPath (Join-Path $nativeOwned 'current-plan-sentinel.txt') -PathType Leaf) 'Rejected current-plan new runs must leave the native leaf untouched'
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $nativeExternal "failed-$($script:NativeLeafName)-$newRunId"))) 'Rejected current-plan new runs must not create an archive'

  $Resume = $true
  Assert-Equal (Initialize-NativeBuildDirectory -Path $NativeBuildDir) $nativeOwned 'Resume must reuse a native leaf owned by the current plan'
  $resumedNativeOwner = Read-ValidatedOwnerMarker -Root $nativeOwned -Kind native -RequireCurrentPlan
  Assert-Equal ([string]$resumedNativeOwner.runId) $archiveRunId 'Resume must preserve the existing native owner instead of replacing it'
  Assert-True (Test-Path -LiteralPath (Join-Path $nativeOwned 'current-plan-sentinel.txt') -PathType Leaf) 'Resume must preserve current-plan native build contents'

  $script:PlanDigest = ('d' * 64)
  foreach ($collisionResume in @($false, $true)) {
    $Resume = $collisionResume
    $collisionRunId = [Guid]::NewGuid().ToString('D')
    $script:RunId = $collisionRunId
    $collisionArchive = Join-Path $nativeExternal "failed-$($script:NativeLeafName)-$collisionRunId"
    [System.IO.Directory]::CreateDirectory($collisionArchive) | Out-Null
    Write-Utf8File -Path (Join-Path $collisionArchive 'collision-sentinel.txt') -Text "collision-$collisionResume"
    $nativeOwnerHashBeforeCollision = Get-Sha256File (Get-OwnerMarkerPath $nativeOwned)
    Assert-Throws {
      Initialize-NativeBuildDirectory -Path $NativeBuildDir | Out-Null
    } "Native archive collisions must fail closed when Resume=$collisionResume" 'Native archive path exists'
    Assert-True (Test-Path -LiteralPath (Join-Path $collisionArchive 'collision-sentinel.txt') -PathType Leaf) "Native archive collision contents must remain untouched when Resume=$collisionResume"
    Assert-True (Test-Path -LiteralPath (Join-Path $nativeOwned 'current-plan-sentinel.txt') -PathType Leaf) "Native source contents must remain untouched after an archive collision when Resume=$collisionResume"
    Assert-Equal (Get-Sha256File (Get-OwnerMarkerPath $nativeOwned)) $nativeOwnerHashBeforeCollision "Native source ownership must remain untouched after an archive collision when Resume=$collisionResume"
  }

  $Resume = $true
  $resumeArchiveRunId = [Guid]::NewGuid().ToString('D')
  $script:RunId = $resumeArchiveRunId
  $resumeArchive = Join-Path $nativeExternal "failed-$($script:NativeLeafName)-$resumeArchiveRunId"
  Assert-Equal (Initialize-NativeBuildDirectory -Path $NativeBuildDir) $nativeOwned 'Resume must archive a valid old-plan native leaf before initializing a fresh one'
  $resumeArchivedOwner = Read-ValidatedOwnerMarker -Root $resumeArchive -Kind native
  Assert-Equal ([string]$resumeArchivedOwner.planDigest) ('c' * 64) 'Resume archive must retain the old plan binding'
  Assert-Equal ([string]$resumeArchivedOwner.runId) $archiveRunId 'Resume archive must retain the old run binding'
  Assert-True (Test-Path -LiteralPath (Join-Path $resumeArchive 'current-plan-sentinel.txt') -PathType Leaf) 'Resume archive must retain old-plan native contents'
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $nativeOwned 'current-plan-sentinel.txt'))) 'Resume fresh native leaf must not retain old-plan contents'
  $resumeFreshOwner = Read-ValidatedOwnerMarker -Root $nativeOwned -Kind native -RequireCurrentPlan
  Assert-Equal ([string]$resumeFreshOwner.runId) $resumeArchiveRunId 'Resume fresh native leaf must be owned by the current run'
  $Resume = $false
  $script:ExternalToolRoot = $external

  $planSource = Join-Path $root 'plan-source'
  $planOutput = Join-Path $root 'plan-output'
  $planCandidate = Join-Path $planOutput 'resume-plan-candidate'
  $planEvidence = Join-Path $planCandidate 'evidence'
  [System.IO.Directory]::CreateDirectory($planSource) | Out-Null
  [System.IO.Directory]::CreateDirectory($planEvidence) | Out-Null
  $script:SourceRoot = $planSource
  $script:OutputRoot = $planOutput
  $script:CandidatePath = $planCandidate
  $script:EvidenceRoot = $planEvidence
  $script:LogsRoot = Join-Path $planCandidate 'logs'
  [System.IO.Directory]::CreateDirectory($script:LogsRoot) | Out-Null
  $script:ResultsPath = Join-Path $planEvidence 'gate-results.ndjson'
  $script:SourceManifestPath = Join-Path $planEvidence 'source-manifest.json'
  Write-JsonFile -Path $script:SourceManifestPath -Value ([ordered]@{ recordsDigestSha256 = ('4' * 64) })
  $script:SourceManifestSha256 = Get-Sha256File $script:SourceManifestPath
  $CandidateName = 'resume-plan-candidate'
  $NativeBuildDir = Join-Path $external $script:NativeLeafName
  $ElectronDistOverride = $null
  $Resume = $true
  $script:InvocationPath = Join-Path $planEvidence 'gate-invocation.json'
  Write-JsonFile -Path $script:InvocationPath -Value ([ordered]@{ schemaVersion = 1; planDigest = ('5' * 64) })
  Write-Utf8File -Path (Join-Path $planEvidence 'gate-invocation.sha256') -Text ((Get-Sha256File $script:InvocationPath) + " *gate-invocation.json`n")
  Write-Utf8File -Path $script:ResultsPath -Text "stale-result`n"
  Initialize-PlanBinding
  Assert-Equal ([System.IO.File]::ReadAllText($script:ResultsPath)) '' 'A stale invocation digest must clear prior resume results'
  Assert-Equal @(Get-ChildItem -LiteralPath $planEvidence -Filter 'gate-invocation.stale-*.json').Count 1 'A stale invocation must be retained as evidence'
  Assert-Equal @(Get-ChildItem -LiteralPath $planEvidence -Filter 'gate-results.stale-*.ndjson').Count 1 'Stale resume results must be retained separately'
  Assert-Equal (([System.IO.File]::ReadAllText((Join-Path $planEvidence 'gate-invocation.sha256')).Split(' ')[0]).Trim()) (Get-Sha256File $script:InvocationPath) 'Current invocation digest file must bind the replacement plan'
  $Resume = $false

  $scopeCandidate = Join-Path $root 'scope-candidate'
  [System.IO.Directory]::CreateDirectory($scopeCandidate) | Out-Null
  Write-Utf8File -Path (Join-Path $scopeCandidate 'a.txt') -Text 'alpha'
  $scopeRecord = [pscustomobject]@{ path = 'a.txt'; size = 5; sha256 = Get-Sha256File (Join-Path $scopeCandidate 'a.txt') }
  $scopeManifest = [pscustomobject]@{ files = @($scopeRecord); recordsDigestSha256 = Get-RecordsDigest @($scopeRecord) }
  $script:CandidatePath = $scopeCandidate
  Assert-CandidateMatchesManifest $scopeManifest
  Write-Utf8File -Path (Join-Path $scopeCandidate 'new-file.txt') -Text 'tamper'
  Assert-Throws { Assert-CandidateMatchesManifest $scopeManifest } 'Candidate verification must reject newly added source files' 'path set changed'
  [System.IO.File]::Delete((Join-Path $scopeCandidate 'new-file.txt'))
  $badDigestManifest = $scopeManifest.PSObject.Copy()
  $badDigestManifest.recordsDigestSha256 = ('0' * 64)
  Assert-Throws { Assert-CandidateMatchesManifest $badDigestManifest } 'Candidate verification must reject a manifest digest mismatch' 'digest no longer matches'
  [System.IO.File]::Delete((Join-Path $scopeCandidate 'a.txt'))
  Assert-Throws { Assert-CandidateMatchesManifest $scopeManifest } 'Candidate verification must reject a missing source file' 'path set changed'

  $resumeCandidate = Join-Path $root 'resume-candidate'
  $resumeLogs = Join-Path $resumeCandidate 'logs'
  $resumeEvidence = Join-Path $resumeCandidate 'evidence'
  [System.IO.Directory]::CreateDirectory($resumeLogs) | Out-Null
  [System.IO.Directory]::CreateDirectory($resumeEvidence) | Out-Null
  $script:CandidatePath = $resumeCandidate
  $script:LogsRoot = $resumeLogs
  $script:EvidenceRoot = $resumeEvidence
  $script:ResultsPath = Join-Path $resumeEvidence 'gate-results.ndjson'
  $script:SourceManifestSha256 = ('d' * 64)
  $script:PlanDigest = ('e' * 64)
  $script:ForceRerunAll = $false
  $descriptor = New-StageDescriptor -Id 'resume-stage' -Command 'node --version' -Timeout 10 -Kind command
  $script:StagePlanById = @{ 'resume-stage' = $descriptor }
  $resumeLog = Join-Path $resumeLogs 'resume-stage.log'
  Write-Utf8File -Path $resumeLog -Text "ok`n"
  $baseRecord = [pscustomobject]@{
    id = 'resume-stage'; command = 'node --version'; timeoutSeconds = 10; exitCode = 0
    log = 'logs/resume-stage.log'; logSha256 = Get-Sha256File $resumeLog
    sourceManifestSha256 = $script:SourceManifestSha256; planDigest = ('f' * 64)
  }
  Add-ResultRecord $baseRecord
  Assert-True (-not (Test-StageAlreadyPassed 'resume-stage')) 'Stale plan records must not be reused'
  $wrongSourceRecord = $baseRecord.PSObject.Copy()
  $wrongSourceRecord.planDigest = $script:PlanDigest
  $wrongSourceRecord.sourceManifestSha256 = ('1' * 64)
  Add-ResultRecord $wrongSourceRecord
  Assert-True (-not (Test-StageAlreadyPassed 'resume-stage')) 'Records from another source manifest must not be reused'
  $currentRecord = $baseRecord.PSObject.Copy()
  $currentRecord.planDigest = $script:PlanDigest
  Add-ResultRecord $currentRecord
  Assert-True (Test-StageAlreadyPassed 'resume-stage') 'Current plan record with a verified log must resume'
  Write-Utf8File -Path $resumeLog -Text "tampered`n"
  Assert-True (-not (Test-StageAlreadyPassed 'resume-stage')) 'Tampered resume logs must invalidate the checkpoint'
  $outsideLog = Join-Path $root 'outside-resume.log'
  Write-Utf8File -Path $outsideLog -Text "outside`n"
  $traversalRecord = $currentRecord.PSObject.Copy()
  $traversalRecord.log = '../outside-resume.log'
  $traversalRecord.logSha256 = Get-Sha256File $outsideLog
  Add-ResultRecord $traversalRecord
  Assert-True (-not (Test-StageAlreadyPassed 'resume-stage')) 'Resume log traversal must not escape the candidate'

  $mandatoryCandidate = Join-Path $root 'mandatory-candidate'
  $mandatoryLogs = Join-Path $mandatoryCandidate 'logs'
  $mandatoryEvidence = Join-Path $mandatoryCandidate 'evidence'
  [System.IO.Directory]::CreateDirectory($mandatoryLogs) | Out-Null
  [System.IO.Directory]::CreateDirectory($mandatoryEvidence) | Out-Null
  $script:CandidatePath = $mandatoryCandidate
  $script:LogsRoot = $mandatoryLogs
  $script:EvidenceRoot = $mandatoryEvidence
  $script:ResultsPath = Join-Path $mandatoryEvidence 'gate-results.ndjson'
  $script:SourceManifestSha256 = ('2' * 64)
  $script:PlanDigest = ('3' * 64)
  $stageA = New-StageDescriptor -Id 'stage-a' -Command 'internal:stage-a' -Timeout 0 -Kind internal
  $stageB = New-StageDescriptor -Id 'stage-b' -Command 'internal:stage-b' -Timeout 0 -Kind internal
  $script:StagePlan = @($stageA, $stageB)
  $script:StagePlanById = @{ 'stage-a' = $stageA; 'stage-b' = $stageB }
  foreach ($stage in $script:StagePlan) {
    $stageLog = Join-Path $mandatoryLogs "$($stage.id).log"
    Write-Utf8File -Path $stageLog -Text "ok`n"
    Add-ResultRecord ([pscustomobject]@{
        id = $stage.id; command = $stage.command; timeoutSeconds = 0; exitCode = 0
        log = "logs/$($stage.id).log"; logSha256 = Get-Sha256File $stageLog
        sourceManifestSha256 = $script:SourceManifestSha256; planDigest = $script:PlanDigest
      })
  }
  Assert-MandatoryStageCoverage
  $extraLog = Join-Path $mandatoryLogs 'extra.log'
  Write-Utf8File -Path $extraLog -Text "ok`n"
  Add-ResultRecord ([pscustomobject]@{
      id = 'unplanned'; command = 'internal:unplanned'; timeoutSeconds = 0; exitCode = 0
      log = 'logs/extra.log'; logSha256 = Get-Sha256File $extraLog
      sourceManifestSha256 = $script:SourceManifestSha256; planDigest = $script:PlanDigest
    })
  Assert-Throws { Assert-MandatoryStageCoverage } 'Mandatory coverage must reject extra bound stages' 'stage set is not exact'

  $benchmarkRoot = Join-Path $root 'benchmark-candidate'
  $benchmarkDir = Join-Path $benchmarkRoot 'evidence\benchmarks'
  [System.IO.Directory]::CreateDirectory($benchmarkDir) | Out-Null
  $script:CandidatePath = $benchmarkRoot
  $provenance = [ordered]@{ algorithm = 'sha256' }
  foreach ($name in @('source', 'sharedContract', 'runner', 'runnerContract', 'packageManifest', 'lockfile')) {
    $relative = "provenance/$name.txt"
    $path = Join-Path $benchmarkRoot $relative
    Write-Utf8File -Path $path -Text $name
    $provenance[$name] = [ordered]@{ path = $relative; sha256 = Get-Sha256File $path }
  }
  $elapsedSamples = @(1..20 | ForEach-Object { [double]$_ })
  $benchmark = [ordered]@{
    schemaVersion = 2; generatedAt = '2026-07-18T00:00:00.000Z'; rows = 10000; warmupIterations = 3; iterations = 20
    budgets = [ordered]@{ uniqueP95Ms = 1500; collisionP95Ms = 2500 }
    provenance = $provenance
    scenarios = [ordered]@{
      unique = [ordered]@{ rows = 10000; elapsedMs = $elapsedSamples; p50Ms = 10; p95Ms = 19 }
      collision = [ordered]@{ rows = 10000; elapsedMs = $elapsedSamples; p50Ms = 10; p95Ms = 19 }
    }
  }
  $benchmarkPath = Join-Path $benchmarkDir 'duplicate-detection.json'
  $benchmarkManifestPath = Join-Path $benchmarkDir 'duplicate-detection.manifest.json'
  Write-JsonFile -Path $benchmarkPath -Value $benchmark -Depth 12
  $benchmarkManifest = [ordered]@{
    schemaVersion = 1; generatedAt = $benchmark.generatedAt
    evidence = [ordered]@{ path = 'duplicate-detection.json'; sha256 = Get-Sha256File $benchmarkPath }
    provenance = $provenance
    benchmark = [ordered]@{
      rows = 10000; warmupIterations = 3; iterations = 20
      budgets = [ordered]@{ uniqueP95Ms = 1500; collisionP95Ms = 2500 }
      unique = [ordered]@{ p50Ms = 10; p95Ms = 19 }
      collision = [ordered]@{ p50Ms = 10; p95Ms = 19 }
    }
  }
  Write-JsonFile -Path $benchmarkManifestPath -Value $benchmarkManifest -Depth 12
  Assert-DuplicateBenchmarkEvidence -EvidencePath $benchmarkPath -ManifestPath $benchmarkManifestPath
  [System.IO.File]::AppendAllText($benchmarkPath, " `n", $script:Utf8NoBom)
  Assert-Throws { Assert-DuplicateBenchmarkEvidence -EvidencePath $benchmarkPath -ManifestPath $benchmarkManifestPath } 'Benchmark manifest hash must reject tampered live evidence' 'hash/path mismatch'
  Write-JsonFile -Path $benchmarkPath -Value $benchmark -Depth 12
  $benchmark.scenarios.unique.p95Ms = 18
  $benchmarkManifest.benchmark.unique.p95Ms = 18
  Write-JsonFile -Path $benchmarkPath -Value $benchmark -Depth 12
  $benchmarkManifest.evidence.sha256 = Get-Sha256File $benchmarkPath
  Write-JsonFile -Path $benchmarkManifestPath -Value $benchmarkManifest -Depth 12
  Assert-Throws { Assert-DuplicateBenchmarkEvidence -EvidencePath $benchmarkPath -ManifestPath $benchmarkManifestPath } 'Benchmark validator must recompute percentiles from raw samples' 'do not match the raw samples'
  $benchmark.scenarios.unique.p95Ms = 19
  $benchmarkManifest.benchmark.unique.p95Ms = 19
  $benchmark.provenance.runner.path = '../outside-runner.ts'
  $benchmarkManifest.provenance.runner.path = '../outside-runner.ts'
  Write-JsonFile -Path $benchmarkPath -Value $benchmark -Depth 12
  $benchmarkManifest.evidence.sha256 = Get-Sha256File $benchmarkPath
  Write-JsonFile -Path $benchmarkManifestPath -Value $benchmarkManifest -Depth 12
  Assert-Throws { Assert-DuplicateBenchmarkEvidence -EvidencePath $benchmarkPath -ManifestPath $benchmarkManifestPath } 'Benchmark provenance must not escape the candidate' 'without traversal'

  function New-QueueScenario {
    param([int]$QueueLength)
    return [ordered]@{
      queueLength = $QueueLength; snapshotHeavyBytes = 0
      limits = [ordered]@{ mountedRows = 18; snapshotP95Ms = [Math]::Max(16, $QueueLength / 1000 * 4); windowP95Ms = 8; windowHeapDeltaBytes = 8388608; snapshotHeavyBytes = 0 }
      snapshotMetrics = [ordered]@{ samplesMs = @(1, 2, 3); p95Ms = 3; maxHeapDeltaBytes = 1024 }
      windowMetrics = [ordered]@{ samplesMs = @(1, 2, 3); p95Ms = 3; maxHeapDeltaBytes = 1024 }
    }
  }
  $queueEvidencePath = Join-Path $benchmarkDir 'queue.json'
  $queueEvidence = [ordered]@{
    schemaVersion = 2
    runner = [ordered]@{ implementation = 'src/renderer/src/utils/playbackQueueVirtualization.ts'; command = @('node'); rowHeight = 54; viewportHeight = 324; overscan = 6; gcExposed = $true }
    scenarios = @((New-QueueScenario 5000), (New-QueueScenario 20000))
  }
  Write-JsonFile -Path $queueEvidencePath -Value $queueEvidence -Depth 12
  Assert-QueueBenchmarkEvidence -EvidencePath $queueEvidencePath
  $queueEvidence.scenarios[0].limits.windowP95Ms = 999
  Write-JsonFile -Path $queueEvidencePath -Value $queueEvidence -Depth 12
  Assert-Throws { Assert-QueueBenchmarkEvidence -EvidencePath $queueEvidencePath } 'Queue benchmark must enforce fixed limits' 'execution contract mismatch'

  $persistenceRunner = Join-Path $benchmarkRoot 'scripts\persistence-benchmark.cjs'
  Write-Utf8File -Path $persistenceRunner -Text 'runner'
  $persistenceEvidencePath = Join-Path $benchmarkDir 'persistence.json'
  $persistenceScenarios = @(5000, 20000, 50000 | ForEach-Object {
      [ordered]@{
        trackCount = $_
        json = [ordered]@{ parse = [ordered]@{ p95Ms = 1 } }
        sqlite = [ordered]@{ load = [ordered]@{ p95Ms = 1 } }
      }
    })
  $persistence = [ordered]@{
    schemaVersion = 1
    provenance = [ordered]@{ scriptSha256 = Get-Sha256File $persistenceRunner }
    host = [ordered]@{ gcExposed = $true }
    methodology = [ordered]@{
      iterations = 7; percentile = 'nearest-rank'
      workload = [ordered]@{ localTrackCounts = @(5000, 20000, 50000); playlistCount = 100; tracksPerPlaylist = 500; sessionQueueEntries = 20000; listeningStatsEntries = 1000 }
    }
    scenarios = $persistenceScenarios
  }
  Write-JsonFile -Path $persistenceEvidencePath -Value $persistence -Depth 12
  Assert-PersistenceBenchmarkEvidence -EvidencePath $persistenceEvidencePath
  $persistence.methodology.workload.playlistCount = 101
  Write-JsonFile -Path $persistenceEvidencePath -Value $persistence -Depth 12
  Assert-Throws { Assert-PersistenceBenchmarkEvidence -EvidencePath $persistenceEvidencePath } 'Persistence benchmark must enforce its fixed workload' 'workload contract mismatch'

  $fullPlan = @(Get-FullStagePlan)
  $fullIds = @($fullPlan | ForEach-Object { [string]$_.id })
  Assert-Equal $fullIds.Count 54 'Full gate plan must retain every mandatory stage'
  Assert-Equal @($fullIds | Sort-Object -Unique).Count $fullIds.Count 'Full gate plan must not contain duplicate IDs'
  Assert-True ($fullIds.IndexOf('renderer-budget') -gt $fullIds.IndexOf('build')) 'Renderer budget verification must run after the production build'
  Assert-Equal $fullIds[-1] 'mandatory-stage-coverage' 'Mandatory stage coverage must close the full plan'
  foreach ($required in @('test-renderer-data-tooling', 'test-sleep-timer', 'test-cross-cutting-regressions', 'test-radio-remote', 'test-themes', 'test-playlist-lifecycle', 'test-tag-duplicate-management', 'test-lyrics-management', 'test-cue', 'native-ctest-evidence-check')) {
    Assert-True ($fullIds -contains $required) "Full gate plan is missing mandatory stage: $required"
  }
  $dryRunPlan = Show-DryRunPlan | ConvertFrom-Json
  Assert-True ([bool]$dryRunPlan.dryRun) 'DryRun plan must identify itself without writing a candidate'
  Assert-Equal @($dryRunPlan.stages).Count $fullPlan.Count 'DryRun must expose the complete bound stage plan'
  $tokens = $null
  $parseErrors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'run-final-integrated-gate.ps1'), [ref]$tokens, [ref]$parseErrors)
  Assert-Equal @($parseErrors).Count 0 'Final gate script must parse cleanly'

  Write-Host "run-final-integrated-gate self-tests passed: $tests"
} finally {
  if ($nativeExternal) {
    [void](Invoke-BoundedSelfTestCleanup -Parent ([System.IO.Path]::GetTempPath()) -Target $nativeExternal -DeadlineMilliseconds 5000)
  }
  $cleaned = Invoke-BoundedSelfTestCleanup -Parent $selfTestParent -Target $root -DeadlineMilliseconds 5000
  if ($cleaned -and (Test-Path -LiteralPath $selfTestParent -PathType Container)) {
    try {
      if (@(Get-ChildItem -LiteralPath $selfTestParent -Force).Count -eq 0) {
        [System.IO.Directory]::Delete($selfTestParent, $false)
      }
    } catch {
      Write-Warning "Empty self-test parent retained: $selfTestParent"
    }
  }
}
