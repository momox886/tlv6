<#
    Autorise les appareils du réseau local (dont le casque Meta Quest) à joindre
    le serveur vidéo qui tourne dans WSL2.

    À exécuter dans un PowerShell **en administrateur** :

        powershell -ExecutionPolicy Bypass -File scripts\allow-lan.ps1
        powershell -ExecutionPolicy Bypass -File scripts\allow-lan.ps1 -Port 8080

    Deux pare-feu entrent en jeu, et il faut les deux :

      1. le pare-feu Windows classique ;
      2. le pare-feu Hyper-V, qui filtre le trafic *entrant vers la machine
         virtuelle WSL2* quand le mode réseau « mirrored » est actif.

    C'est le second qu'on oublie systématiquement. Sans lui, tout semble correct
    (le serveur écoute, localhost fonctionne) mais le casque reste bloqué.
#>

param(
    [int]$Port = 8080
)

$ErrorActionPreference = 'Stop'

# --- Vérification des privilèges --------------------------------------------
$identity  = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "ERREUR : ce script doit etre lance dans un PowerShell en administrateur." -ForegroundColor Red
    Write-Host "  Clic droit sur PowerShell -> 'Executer en tant qu administrateur', puis relancez." -ForegroundColor Yellow
    exit 1
}

$ruleName = "Stereo VR $Port"

Write-Host ""
Write-Host "Ouverture du port TCP $Port pour le reseau local" -ForegroundColor Cyan
Write-Host ""

# --- 1. Pare-feu Windows classique ------------------------------------------
if (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue) {
    Write-Host "  [1/2] Pare-feu Windows : regle deja presente."
}
else {
    New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow `
        -Protocol TCP -LocalPort $Port -Profile Any | Out-Null
    Write-Host "  [1/2] Pare-feu Windows : regle creee." -ForegroundColor Green
}

# --- 2. Pare-feu Hyper-V (specifique a WSL2) --------------------------------
$creatorId = (Get-NetFirewallHyperVVMCreator -ErrorAction SilentlyContinue |
        Where-Object { $_.FriendlyName -eq 'WSL' } |
        Select-Object -First 1).VMCreatorId

if (-not $creatorId) {
    Write-Host "  [2/2] Pare-feu Hyper-V : createur 'WSL' introuvable, etape ignoree." -ForegroundColor Yellow
}
else {
    $hvRuleName = "StereoVR-$Port"
    if (Get-NetFirewallHyperVRule -Name $hvRuleName -ErrorAction SilentlyContinue) {
        Write-Host "  [2/2] Pare-feu Hyper-V : regle deja presente."
    }
    else {
        New-NetFirewallHyperVRule -Name $hvRuleName -DisplayName $ruleName `
            -Direction Inbound -VMCreatorId $creatorId `
            -Protocol TCP -LocalPorts $Port -Action Allow | Out-Null
        Write-Host "  [2/2] Pare-feu Hyper-V : regle creee." -ForegroundColor Green
    }
}

# --- Recapitulatif : quelle adresse saisir sur le casque --------------------
Write-Host ""
Write-Host "Adresses a ouvrir sur le casque :" -ForegroundColor Cyan

$lan = Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object {
        $_.IPAddress -notlike '127.*' -and
        $_.IPAddress -notlike '169.254.*' -and
        $_.InterfaceAlias -notlike '*WSL*' -and
        $_.InterfaceAlias -notlike '*VMware*' -and
        $_.InterfaceAlias -notlike '*NordLynx*' -and
        $_.InterfaceAlias -notlike '*OpenVPN*' -and
        $_.InterfaceAlias -notlike '*Bluetooth*'
    }

if ($lan) {
    foreach ($a in $lan) {
        Write-Host ("  http://{0}:{1}/vr.html   ({2})" -f $a.IPAddress, $Port, $a.InterfaceAlias)
    }
}
else {
    Write-Host "  (aucune interface locale detectee)" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Si NordVPN est actif, verifiez que l'acces au reseau local n'est pas bloque" -ForegroundColor Yellow
Write-Host "(option 'Allow LAN traffic' / desactivation du pare-feu NordVPN)." -ForegroundColor Yellow
Write-Host ""
