# Barangay Kaligayahan Health Center - server PC security check (READ-ONLY: it changes nothing)
# Run: double-click "Check server PC security.bat" in the project folder.
# Some checks (disk encryption) show more detail when run as Administrator.

$ErrorActionPreference = 'SilentlyContinue'
$results = New-Object System.Collections.Generic.List[object]
function Add-Check($name, $ok, $detail, $fix) {
    $results.Add([pscustomobject]@{ Check = $name; Status = $(if ($ok -eq $true) { 'OK' } elseif ($ok -eq $false) { 'FIX' } else { 'CHECK' }); Detail = $detail; HowToFix = $fix })
}

# 1. Disk encryption (BitLocker / Device encryption)
$bl = Get-BitLockerVolume -MountPoint $env:SystemDrive 2>$null
if ($bl) {
    Add-Check 'Disk encryption (BitLocker)' ($bl.ProtectionStatus -eq 'On') "System drive protection: $($bl.ProtectionStatus)" 'Settings > Privacy & security > Device encryption (or Control Panel > BitLocker) > turn on. Save the recovery key somewhere safe (not on this PC).'
} else {
    Add-Check 'Disk encryption (BitLocker)' $null 'Could not read (run this check as Administrator to see it).' 'Settings > Privacy & security > Device encryption: make sure it is On.'
}

# 2. Windows updates
$last = Get-HotFix | Where-Object { $_.InstalledOn } | Sort-Object InstalledOn -Descending | Select-Object -First 1
if ($last) {
    $days = [int]((Get-Date) - $last.InstalledOn).TotalDays
    Add-Check 'Windows updates' ($days -le 45) "Last update installed $days days ago ($($last.HotFixID))" 'Settings > Windows Update > Check for updates. Keep automatic updates on.'
} else { Add-Check 'Windows updates' $null 'Could not read the update history.' 'Settings > Windows Update > Check for updates.' }

# 3. Firewall
$fw = Get-NetFirewallProfile
if ($fw) {
    $off = @($fw | Where-Object { -not $_.Enabled } | ForEach-Object { $_.Name })
    Add-Check 'Firewall' ($off.Count -eq 0) $(if ($off.Count) { "Off for: $($off -join ', ')" } else { 'On for all network types' }) 'Settings > Privacy & security > Windows Security > Firewall & network protection > turn on.'
}

# 4. Antivirus
$av = Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntivirusProduct
if ($av) {
    $names = ($av | ForEach-Object { $_.displayName }) -join ', '
    Add-Check 'Antivirus' $true "Installed: $names" ''
} else { Add-Check 'Antivirus' $false 'No antivirus reported.' 'Turn on Microsoft Defender (Windows Security > Virus & threat protection).' }
$mp = Get-MpComputerStatus
if ($mp -and $mp.AntivirusEnabled) {
    $sigDays = [int]((Get-Date) - $mp.AntivirusSignatureLastUpdated).TotalDays
    Add-Check 'Antivirus definitions' ($sigDays -le 7) "Defender definitions updated $sigDays days ago" 'Windows Security > Virus & threat protection > Protection updates > Check for updates.'
}

# 5. Screen lock when away
$ss = Get-ItemProperty 'HKCU:\Control Panel\Desktop'
$timeout = [int]($ss.ScreenSaveTimeOut)
$secure = $ss.ScreenSaverIsSecure -eq '1'
$lockOk = $secure -and $timeout -gt 0 -and $timeout -le 900
Add-Check 'Automatic screen lock' $(if ($lockOk) { $true } else { $null }) $(if ($lockOk) { "Locks after $([int]($timeout/60)) minutes" } else { 'No locking screen saver found (a power/sleep lock may still be set).' }) 'Settings > Accounts > Sign-in options: "If you have been away, when should Windows require you to sign in again?" = When PC wakes from sleep, and set the screen to turn off after 5-10 minutes. Press Windows+L when leaving the desk.'

# 6. The Windows account needs a password
$me = Get-LocalUser -Name $env:USERNAME
if ($me) {
    Add-Check 'Windows account password' ($me.PasswordRequired -and $me.PasswordLastSet) "Local account '$($me.Name)': password required = $($me.PasswordRequired)" 'Settings > Accounts > Sign-in options > Password: set a strong password (or use a Microsoft account with PIN).'
} else { Add-Check 'Windows account password' $true 'Signed in with a Microsoft or domain account (password-protected).' '' }

# 7. Remote Desktop
$rdp = (Get-ItemProperty 'HKLM:\System\CurrentControlSet\Control\Terminal Server').fDenyTSConnections
Add-Check 'Remote Desktop' ($rdp -eq 1) $(if ($rdp -eq 1) { 'Off' } else { 'ON: other computers can try to sign in to this PC' }) 'Turn it off unless you need it: Settings > System > Remote Desktop.'

# 8. Recovery kit copied?
$kit = Join-Path $env:LOCALAPPDATA 'KaligayahanHealthCenter\RECOVERY-KIT.txt'
Add-Check 'Recovery kit' $null $(if (Test-Path $kit) { "Make sure a copy of $kit is on a USB drive or printed and kept locked away." } else { 'The server has not been started yet.' }) 'Copy RECOVERY-KIT.txt to a USB drive (or print it) and store it offline.'

""
"  Barangay Kaligayahan Health Center - server PC security check"
"  ------------------------------------------------------------"
$results | Format-Table -AutoSize -Wrap Check, Status, Detail | Out-String -Width 160
$todo = @($results | Where-Object { $_.Status -ne 'OK' -and $_.HowToFix })
if ($todo.Count) {
    "  What to do:"
    foreach ($r in $todo) { "   - $($r.Check): $($r.HowToFix)" }
} else { "  Everything checked looks good." }
""
