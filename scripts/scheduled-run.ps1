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

# Spec 5.1 asks the User-Agent to carry a contact address, so a site owner who
# sees this traffic can reach a person. It was set in CI and not here, which
# meant the run that actually reads these sites was the anonymous one. The value
# is a personal email, so it is read from a gitignored file and never committed.
$contactFile = Join-Path $repo ".contact.local"
if (Test-Path $contactFile) {
    $env:RASID_CONTACT = (Get-Content $contactFile -Raw -Encoding utf8).Trim()
}

# The classifier refuses to run without the student profile rather than guess
# one, so the scheduled run reads it from the same gitignored file CI keeps in a
# secret. Without it every changed page goes to manual review instead.
$profileFile = Join-Path $repo ".profile.local"
if ((Test-Path $profileFile) -and -not $env:RASID_STUDENT_PROFILE) {
    $env:RASID_STUDENT_PROFILE = (Get-Content $profileFile -Raw -Encoding utf8)
}

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
