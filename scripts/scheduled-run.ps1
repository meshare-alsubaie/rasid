# Scheduled collection, run on the owner's own machine.
#
# GitHub's runners are in the United States, and a large share of Saudi
# government sites refuse them: nine of the eleven failures in the first cloud
# run were .gov.sa hosts that answer this machine without complaint. So the
# collection happens here, from an address those sites accept, and the result is
# pushed. GitHub then notifies and republishes, which is the half it does well.
#
# Registered as a Task Scheduler job; see scripts/install-schedule.ps1.
# Everything it prints lands in scheduled-run.log next to the repository.

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

$log = Join-Path $repo "scheduled-run.log"
function Say($msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm"), $msg
    Write-Output $line
    Add-Content -Path $log -Value $line -Encoding utf8
}

# Task Scheduler starts with a bare environment, so the tools are named here.
$env:Path = "D:\tools\node;C:\Program Files\GitHub CLI;C:\Program Files\Git\cmd;$env:Path"

try {
    Say "start"

    # Only data is ever committed from here. Anything else left uncommitted in
    # the tree is someone's work in progress, and a rebase would refuse anyway,
    # so say so plainly instead of failing with git's wording.
    $dirty = git status --porcelain -- ':!data'
    if ($dirty) {
        Say "uncommitted changes outside data/, skipping this run:"
        $dirty | ForEach-Object { Say "    $_" }
        exit 0
    }

    # Take whatever the cloud committed since last time, so the push is a
    # fast-forward and never a conflict.
    git pull --rebase --quiet origin master
    if ($LASTEXITCODE -ne 0) { Say "pull failed, stopping"; exit 1 }

    npm run collect --silent 2>&1 | Tee-Object -Variable out | Out-Null
    $summary = ($out | Select-String -Pattern "changed |announcements |needs manual review|broken " ) -join " | "
    Say "collect: $summary"

    if ((git status --porcelain -- data) -ne $null) {
        git add data
        git commit --quiet -m ("data: local run {0}" -f (Get-Date -Format "yyyy-MM-ddTHH:mmK"))
        git push --quiet origin master
        if ($LASTEXITCODE -eq 0) { Say "pushed; GitHub will notify and republish" }
        else { Say "push failed" }
    } else {
        Say "nothing changed, nothing pushed"
    }
    Say "done"
} catch {
    Say ("error: " + $_.Exception.Message)
    exit 1
}
