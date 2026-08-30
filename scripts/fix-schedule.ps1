# Make the scheduled collection survive a normal laptop.
#
# The task was created with Task Scheduler's defaults, and three of them quietly
# stop it:
#
#   DisallowStartIfOnBatteries  - unplugged at 18:00, no run at all
#   StopIfGoingOnBatteries      - unplugged mid-run, killed halfway
#   (no StartWhenAvailable)     - asleep at 12:00, the run is never made up
#
# None of them reports anything. An audit found the 12:00 and 18:00 runs had
# both failed with LastTaskResult 1 and not one line in the script's own log,
# while the app carried on showing a cheerful "last checked" from the morning.
#
# This edits the existing task's settings in place. It does not touch what the
# task runs, when it runs, or the account it runs as.
#
#   powershell -ExecutionPolicy Bypass -File scripts\fix-schedule.ps1

$ErrorActionPreference = "Stop"
$name = "RASID collection"

$task = Get-ScheduledTask -TaskName $name -ErrorAction Stop
$s = $task.Settings

Write-Output "before:"
Write-Output ("  DisallowStartIfOnBatteries : {0}" -f $s.DisallowStartIfOnBatteries)
Write-Output ("  StopIfGoingOnBatteries     : {0}" -f $s.StopIfGoingOnBatteries)
Write-Output ("  StartWhenAvailable         : {0}" -f $s.StartWhenAvailable)
Write-Output ("  WakeToRun                  : {0}" -f $s.WakeToRun)
Write-Output ("  ExecutionTimeLimit         : {0}" -f $s.ExecutionTimeLimit)

$s.DisallowStartIfOnBatteries = $false
$s.StopIfGoingOnBatteries = $false
# A missed run is made up as soon as the machine is available again, rather
# than silently skipped until the next six-hourly trigger.
$s.StartWhenAvailable = $true
# A run that overruns must not sit there holding the next one out.
$s.ExecutionTimeLimit = "PT40M"

Set-ScheduledTask -TaskName $name -Settings $s | Out-Null

$after = (Get-ScheduledTask -TaskName $name).Settings
Write-Output "`nafter:"
Write-Output ("  DisallowStartIfOnBatteries : {0}" -f $after.DisallowStartIfOnBatteries)
Write-Output ("  StopIfGoingOnBatteries     : {0}" -f $after.StopIfGoingOnBatteries)
Write-Output ("  StartWhenAvailable         : {0}" -f $after.StartWhenAvailable)
Write-Output ("  ExecutionTimeLimit         : {0}" -f $after.ExecutionTimeLimit)

Write-Output @"

One thing this script deliberately does not change: LogonType is InteractiveToken,
which means the task only runs while you are logged in. Changing that needs your
Windows password, and no script of mine is going to ask for it. If you want
collection to continue while you are logged out, open Task Scheduler, find
"RASID collection", tick "Run whether user is logged on or not", and enter your
password yourself.
"@
