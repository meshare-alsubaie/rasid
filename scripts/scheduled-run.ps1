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

# A scheduled task inherits user-scope variables, but "usually" is not a thing
# to rely on for the one credential that decides whether anything gets
# classified at all. Read it explicitly, and say so loudly if it is missing:
# without it every changed page silently goes to manual review instead of
# being judged, and the run still looks like it worked.
if (-not $env:ANTHROPIC_API_KEY) {
    $env:ANTHROPIC_API_KEY = [Environment]::GetEnvironmentVariable("ANTHROPIC_API_KEY", "User")
}
if (-not $env:ANTHROPIC_API_KEY) {
    Say "WARNING: ANTHROPIC_API_KEY is not set. Pages will be fetched but nothing classified."
}
if (-not $env:RASID_STUDENT_PROFILE) {
    Say "WARNING: no student profile. The classifier refuses to guess one, so nothing will be scored."
}

try {
    Say "start"

    # Work in progress in the tree is a reason not to rebase. It is not a reason
    # to stop watching.
    #
    # This used to exit outright, and the consequence was worse than it looks:
    # every six-hourly run was skipped for as long as anyone had an uncommitted
    # edit: a whole day of blindness during an afternoon's work, announced
    # nowhere but a log file. Only data/ is ever committed from here, so an edit
    # elsewhere endangers nothing; it just means the rebase has to wait.
    #
    # This file is kept to plain ASCII on purpose. Windows PowerShell 5.1 reads
    # a .ps1 without a byte-order mark in the system codepage, so a single
    # typographic dash in a comment turns into bytes that break the parser --
    # which is exactly what happened: the script stopped parsing, the scheduled
    # task exited 1 twice, and nothing was written to its own log because the
    # failure came before the first line that writes to it.
    $dirty = git status --porcelain -- ':!data'
    if ($dirty) {
        Say "uncommitted changes outside data/, collecting anyway, skipping the rebase:"
        $dirty | Select-Object -First 5 | ForEach-Object { Say "    $_" }
    } else {
        # Take whatever the cloud committed since last time, so the push is a
        # fast-forward and never a conflict.
        git pull --rebase --quiet origin master
        if ($LASTEXITCODE -ne 0) {
            # A rebase that stops on a conflict leaves the working tree holding
            # files with conflict markers in them -- including the pipeline's own
            # source. Collecting "without it" then means running a collector
            # whose classifier is a syntax error: the round dies on the first
            # import, and the only trace is a stack in a log nobody reads.
            #
            # This is the failure shape this project exists to refuse: something
            # that looks like it carried on. So the rebase is put back, and the
            # tree is verified clean before a single page is fetched.
            Say "pull failed; restoring the tree before collecting"
            git rebase --abort 2>$null
            git merge --abort 2>$null
            $conflicted = git ls-files --unmerged
            if ($conflicted) {
                Say "ABORTED: the tree is still conflicted, so nothing was collected."
                $conflicted | Select-Object -First 5 | ForEach-Object { Say "    $_" }
                exit 1
            }
            Say "tree is clean; collecting from the local commit"
        }
    }

    # Look for pages nobody added by hand, before reading the ones we have.
    #
    # This is the round's only defence against an announcement published at a
    # brand-new address, which is how most of these bodies actually announce.
    # It costs one request per organisation and it replaces requests rather than
    # adding them, so it goes first: anything it finds is a candidate that
    # verify-leads can open in the same run, and a genuine announcement is then
    # read on the day it appears rather than whenever someone next looks.
    #
    # Once a day is enough. A sitemap that moved four hours ago will still have
    # moved tomorrow, and four passes a day over 116 sites is noise on their
    # logs for no gain.
    $hour = (Get-Date).Hour
    if ($hour -lt 6) {
        $maps = npm run sitemaps --silent 2>&1
        $mapLine = ($maps | Select-String -Pattern "candidate link" | ForEach-Object { $_.Line.Trim() }) -join " | "
        Say "sitemaps: $mapLine"

        # Only worth opening leads if the sitemap pass proposed any.
        if ($mapLine -notmatch "^0 new candidate") {
            $leads = npm run verify-leads --silent 2>&1
            $leadLine = ($leads | Select-String -Pattern "watchable|verified" | ForEach-Object { $_.Line.Trim() }) -join " "
            Say "verify: $leadLine"
        }
    }

    npm run collect --silent 2>&1 | Tee-Object -Variable out | Out-Null
    $summary = ($out | Select-String -Pattern "changed |announcements |needs manual review|broken |vanished " ) -join " | "
    Say "collect: $summary"

    if ((git status --porcelain -- data) -ne $null) {
        git add data
        git commit --quiet -m ("data: local run {0}" -f (Get-Date -Format "yyyy-MM-ddTHH:mmK"))
        git push --quiet origin master
        if ($LASTEXITCODE -eq 0) {
            Say "pushed; GitHub will notify and republish"
        } else {
            # Committed locally, so nothing collected is lost. The next run with
            # a clean tree rebases and carries it up.
            Say "push failed (probably behind). The data is committed locally and will go up next run."
        }
    } else {
        Say "nothing changed, nothing pushed"
    }
    Say "done"
} catch {
    Say ("error: " + $_.Exception.Message)
    exit 1
}
