# Rattache la caméra USB de Windows vers WSL2 via usbipd-win.
#
# À exécuter dans un PowerShell **administrateur** sur Windows.
#   powershell -ExecutionPolicy Bypass -File scripts\attach-camera.ps1
#
# Prérequis (une seule fois) :
#   winget install usbipd

param(
  [string]$BusId = ""
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command usbipd -ErrorAction SilentlyContinue)) {
  Write-Error "usbipd est absent. Installez-le d'abord :  winget install usbipd"
}

if (-not $BusId) {
  Write-Host "Périphériques USB détectés :" -ForegroundColor Cyan
  usbipd list
  Write-Host ""
  $BusId = Read-Host "Entrez le BUSID de la caméra (ex: 2-4)"
}

Write-Host "Attachement de $BusId à WSL..." -ForegroundColor Cyan
usbipd bind --busid $BusId      # à refaire après chaque redémarrage de Windows
usbipd attach --wsl --busid $BusId

Write-Host ""
Write-Host "Vérifiez maintenant dans WSL :" -ForegroundColor Green
Write-Host "  ls -l /dev/video*"
Write-Host "  bash scripts/probe-camera.sh"
