; Installateur Windows (Inno Setup). Compilé par .github/workflows/windows.yml :
;   iscc /DVersion=1.0.0 windows\installateur.iss
#ifndef Version
  #define Version "0.0.0"
#endif

[Setup]
AppId={{6B0E2C1A-5D7E-4C55-9F3B-6A1E8D2C4F70}
AppName=Mim PDF
AppVersion={#Version}
AppPublisher=Mim PDF
AppPublisherURL=https://github.com/Damien76690/lecteur-pdf
; Mise à jour : même AppId, donc même dossier qu'avant (« Lecteur PDF libre » pour les anciennes installations).
DefaultDirName={autopf}\Mim PDF
DefaultGroupName=Mim PDF
UsePreviousGroup=no
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
OutputDir=..\dist
OutputBaseFilename=MimPDF-installation
AppVerName=Mim PDF {#Version}
CloseApplications=yes
; Prévient l'Explorateur que Mim PDF sait ouvrir les .pdf (menu « Ouvrir avec »).
ChangesAssociations=yes
SetupIconFile=icone.ico
UninstallDisplayIcon={app}\MimPDF.exe
LicenseFile=..\LICENSE
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesInstallIn64BitMode=x64compatible

[Languages]
Name: "french"; MessagesFile: "compiler:Languages\French.isl"

[Tasks]
Name: "bureau"; Description: "Créer une icône sur le Bureau"; Flags: checkedonce

[InstallDelete]
; Nettoyage des anciennes versions (« Lecteur PDF libre », dont la première de 140 Mo avec Tesseract) :
; tout _internal est remplacé, l'ancien programme et ses raccourcis disparaissent.
Type: filesandordirs; Name: "{app}\_internal"
Type: filesandordirs; Name: "{app}\tesseract"
Type: filesandordirs; Name: "{app}\templates"
Type: files; Name: "{app}\LecteurPDF.exe"
Type: filesandordirs; Name: "{userprograms}\Lecteur PDF libre"
Type: files; Name: "{userdesktop}\Lecteur PDF libre.lnk"

[Files]
Source: "..\dist\MimPDF\*"; DestDir: "{app}"; Flags: recursesubdirs ignoreversion
; Composant Microsoft qui affiche la fenêtre (déjà présent sur Windows 10/11 à jour).
Source: "..\build\MicrosoftEdgeWebview2Setup.exe"; DestDir: "{tmp}"; Flags: deleteafterinstall; Check: WebView2Absent

[Icons]
Name: "{group}\Mim PDF"; Filename: "{app}\MimPDF.exe"
Name: "{group}\Désinstaller Mim PDF"; Filename: "{uninstallexe}"
Name: "{autodesktop}\Mim PDF"; Filename: "{app}\MimPDF.exe"; Tasks: bureau

[Registry]
; Mim PDF apparaît dans « Ouvrir avec » et dans Paramètres > Applications par défaut, avec son icône,
; SANS devenir le lecteur par défaut : c'est la personne qui le choisit elle-même dans Windows.
; HKA = l'utilisateur courant (installation sans droits administrateur) ou tout l'ordinateur.
Root: HKA; Subkey: "Software\Classes\MimPDF.pdf"; ValueType: string; ValueName: ""; ValueData: "Document PDF"; Flags: uninsdeletekey
Root: HKA; Subkey: "Software\Classes\MimPDF.pdf"; ValueType: string; ValueName: "FriendlyTypeName"; ValueData: "Document PDF"
Root: HKA; Subkey: "Software\Classes\MimPDF.pdf\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: "{app}\MimPDF.exe,0"
Root: HKA; Subkey: "Software\Classes\MimPDF.pdf\shell\open"; ValueType: string; ValueName: "FriendlyAppName"; ValueData: "Mim PDF"
Root: HKA; Subkey: "Software\Classes\MimPDF.pdf\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\MimPDF.exe"" ""%1"""
Root: HKA; Subkey: "Software\Classes\.pdf\OpenWithProgids"; ValueType: string; ValueName: "MimPDF.pdf"; ValueData: ""; Flags: uninsdeletevalue
; Entrée créée par Windows si on a déjà choisi MimPDF.exe à la main dans « Ouvrir avec » : on la corrige.
Root: HKA; Subkey: "Software\Classes\Applications\MimPDF.exe"; ValueType: string; ValueName: "FriendlyAppName"; ValueData: "Mim PDF"; Flags: uninsdeletekey
Root: HKA; Subkey: "Software\Classes\Applications\MimPDF.exe\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: "{app}\MimPDF.exe,0"
Root: HKA; Subkey: "Software\Classes\Applications\MimPDF.exe\SupportedTypes"; ValueType: string; ValueName: ".pdf"; ValueData: ""
Root: HKA; Subkey: "Software\Classes\Applications\MimPDF.exe\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\MimPDF.exe"" ""%1"""
Root: HKA; Subkey: "Software\MimPDF\Capabilities"; ValueType: string; ValueName: "ApplicationName"; ValueData: "Mim PDF"; Flags: uninsdeletekey
Root: HKA; Subkey: "Software\MimPDF\Capabilities"; ValueType: string; ValueName: "ApplicationDescription"; ValueData: "Lire, modifier, signer et convertir des PDF"
Root: HKA; Subkey: "Software\MimPDF\Capabilities\FileAssociations"; ValueType: string; ValueName: ".pdf"; ValueData: "MimPDF.pdf"
Root: HKA; Subkey: "Software\RegisteredApplications"; ValueType: string; ValueName: "Mim PDF"; ValueData: "Software\MimPDF\Capabilities"; Flags: uninsdeletevalue

[Run]
Filename: "{tmp}\MicrosoftEdgeWebview2Setup.exe"; Parameters: "/silent /install"; StatusMsg: "Installation du composant d'affichage Microsoft WebView2..."; Check: WebView2Absent
Filename: "{app}\MimPDF.exe"; Description: "Lancer Mim PDF"; Flags: nowait postinstall skipifsilent
; Mise à jour automatique lancée depuis l'application (« Redémarrer et mettre à jour ») : on la rouvre.
Filename: "{app}\MimPDF.exe"; Flags: nowait; Check: Relancer

[Code]
const WV2 = 'Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';

// L'application garde ce verrou ouvert : on attend (30 s au plus) qu'elle soit fermée.
function InitializeSetup: Boolean;
var I: Integer;
begin
  I := 0;
  while CheckForMutexes('MimPDF') and (I < 60) do
  begin
    Sleep(500);
    I := I + 1;
  end;
  Result := True;
end;

function Relancer: Boolean;
begin
  Result := ExpandConstant('{param:relancer|0}') = '1';
end;

function WebView2Absent: Boolean;
var V: String;
begin
  Result := not (RegQueryStringValue(HKLM, 'SOFTWARE\WOW6432Node\' + WV2, 'pv', V) and (V <> '') and (V <> '0.0.0.0'))
        and not (RegQueryStringValue(HKLM, 'SOFTWARE\' + WV2, 'pv', V) and (V <> '') and (V <> '0.0.0.0'))
        and not (RegQueryStringValue(HKCU, 'Software\' + WV2, 'pv', V) and (V <> '') and (V <> '0.0.0.0'));
end;
