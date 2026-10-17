; Installateur Windows (Inno Setup). Compilé par .github/workflows/windows.yml :
;   iscc /DVersion=1.0.0 windows\installateur.iss
#ifndef Version
  #define Version "0.0.0"
#endif

[Setup]
AppId={{6B0E2C1A-5D7E-4C55-9F3B-6A1E8D2C4F70}
AppName=Lecteur PDF libre
AppVersion={#Version}
AppPublisher=Lecteur PDF libre
AppPublisherURL=https://github.com/Damien76690/lecteur-pdf
DefaultDirName={autopf}\Lecteur PDF libre
DefaultGroupName=Lecteur PDF libre
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
OutputDir=..\dist
OutputBaseFilename=LecteurPDF-installation
SetupIconFile=icone.ico
UninstallDisplayIcon={app}\LecteurPDF.exe
LicenseFile=..\LICENSE
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesInstallIn64BitMode=x64compatible

[Languages]
Name: "french"; MessagesFile: "compiler:Languages\French.isl"

[Tasks]
Name: "bureau"; Description: "Créer une icône sur le Bureau"; Flags: checkedonce

[Files]
Source: "..\dist\LecteurPDF\*"; DestDir: "{app}"; Flags: recursesubdirs ignoreversion
; Composant Microsoft qui affiche la fenêtre (déjà présent sur Windows 10/11 à jour).
Source: "..\build\MicrosoftEdgeWebview2Setup.exe"; DestDir: "{tmp}"; Flags: deleteafterinstall; Check: WebView2Absent

[Icons]
Name: "{group}\Lecteur PDF libre"; Filename: "{app}\LecteurPDF.exe"
Name: "{group}\Désinstaller Lecteur PDF libre"; Filename: "{uninstallexe}"
Name: "{autodesktop}\Lecteur PDF libre"; Filename: "{app}\LecteurPDF.exe"; Tasks: bureau

[Run]
Filename: "{tmp}\MicrosoftEdgeWebview2Setup.exe"; Parameters: "/silent /install"; StatusMsg: "Installation du composant d'affichage Microsoft WebView2..."; Check: WebView2Absent
Filename: "{app}\LecteurPDF.exe"; Description: "Lancer Lecteur PDF libre"; Flags: nowait postinstall skipifsilent

[Code]
const WV2 = 'Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';

function WebView2Absent: Boolean;
var V: String;
begin
  Result := not (RegQueryStringValue(HKLM, 'SOFTWARE\WOW6432Node\' + WV2, 'pv', V) and (V <> '') and (V <> '0.0.0.0'))
        and not (RegQueryStringValue(HKLM, 'SOFTWARE\' + WV2, 'pv', V) and (V <> '') and (V <> '0.0.0.0'))
        and not (RegQueryStringValue(HKCU, 'Software\' + WV2, 'pv', V) and (V <> '') and (V <> '0.0.0.0'));
end;
