# Plan B : utiliser la caméra depuis Windows (ffmpeg.exe) au lieu de WSL.
#
# Certains noyaux WSL2 n'exposent pas /dev/video0 même après usbipd. Dans ce cas,
# faites tourner la capture côté Windows :
#
#   1. Téléchargez ffmpeg pour Windows : https://www.gyan.dev/ffmpeg/builds/
#   2. Listez les caméras DirectShow :
#        ffmpeg -list_devices true -f dshow -i dummy
#   3. Récupérez le nom exact (ex: "USB Camera") et lancez le serveur Node sous
#      Windows (node.exe) avec :
#        set SOURCE=dshow
#        set DSHOW_NAME=USB Camera
#        node server\index.js
#
# Ce script se contente d'afficher la commande de découverte.

Write-Host "Caméras DirectShow visibles par ffmpeg.exe :" -ForegroundColor Cyan
if (Get-Command ffmpeg -ErrorAction SilentlyContinue) {
  ffmpeg -hide_banner -list_devices true -f dshow -i dummy 2>&1 | Select-String "Alternative name"
} else {
  Write-Host "ffmpeg.exe introuvable dans le PATH." -ForegroundColor Yellow
}
