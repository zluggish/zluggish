import { t } from '#src/i18n/index';
import { legacyCertificateThumbprint } from '#src/services/tls.service';
import type { CertificateStatus } from '#src/services/tls.service';

export const zwiftHostNames = ['us-or-rly101.zwift.com', 'secure.zwift.com', 'cdn.zwift.com', 'launcher.zwift.com'];

// The first line identifies the old shared certificate in Zwift's PEM bundle.
const legacyCertificateBody = 'MIIEQTCCAymgAwIBAgIUVPfyk0BzcKB2eYhXZ+W9WZRY5HEwDQYJKoZIhvcNAQEL';

export interface SetupScript {
  readonly pem: string;
  readonly certificate: CertificateStatus;
  /** IP address for the hosts file, or empty to leave the hosts file alone. */
  readonly address: string;
  readonly version: string;
  readonly now: Date;
}

/** The trust store file name of the shared certificate on Linux. */
const legacyName = 'zluggish-zwift-shared';

/** The OU that names this server in the subject, which setup uses to find what it installed before. */
export function serverUnit(certificate: CertificateStatus) {
  return /OU=(Zluggish server [\da-f]+)/.exec(certificate.subject)?.[1] ?? null;
}

/** File names start with the first 8 thumbprint digits, so files from different certificates differ. */
export function setupFileName(certificate: CertificateStatus, extension: string) {
  return `zluggish-zwift-${certificate.thumbprint.slice(0, 8).toLowerCase()}.${extension}`;
}

const psQuote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
const shQuote = (value: string) => "'" + value.replaceAll("'", String.raw`'\''`) + "'";

function header(script: SetupScript) {
  const { certificate } = script;

  return [
    t('generated', { value1: script.version || 'dev', value2: script.now.toISOString().slice(0, 10) }),
    t('certificate_detail', { value1: certificate.subject }),
    `SHA-256:     ${certificate.fingerprint256}`,
    t('certificate_valid_until_detail', { value1: certificate.notAfter.slice(0, 10) }),
  ].map((line) => `# ${line}`.trimEnd());
}

const pemLines = (pem: string) => pem.trim().split(/\r?\n/);

/** A batch file that runs the PowerShell below it as administrator. Windows needs CRLF line ends. */
export function windowsSetupScript(script: SetupScript) {
  const unit = serverUnit(script.certificate) ?? '';

  return [
    '<# : Zluggish client setup for Windows',
    '@ECHO OFF',
    'TITLE ' + t('zluggish_client_setup'),
    'SET "ZLUGGISH_SETUP=%~f0"',
    'NET SESSION >nul 2>&1 || (',
    '  ECHO ' + t('client_setup_windows_elevation_required'),
    '  PowerShell -NoProfile -Command "Start-Process -FilePath $env:ZLUGGISH_SETUP -Verb RunAs"',
    '  EXIT /B',
    ')',
    'PowerShell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-Expression ([IO.File]::ReadAllText($env:ZLUGGISH_SETUP))"',
    'ECHO.',
    'PAUSE',
    'EXIT /B',
    '#>',
    '',
    '# ' + t('client_setup_windows_title'),
    ...header(script),
    '#',
    '# ' + t('client_setup_windows_run_hint'),
    '# ' + t('client_setup_windows_trust_step'),
    '# ' + t('client_setup_certificate_cleanup_hint'),
    '# ' + t('client_setup_windows_zwift_certificate_step'),
    ...(script.address ? [t('hosts_windows', { value1: script.address })] : []),
    '# ' + t('client_setup_launcher_restart_hint'),
    '',
    "$ErrorActionPreference = 'Stop'",
    `$Thumbprint = '${script.certificate.thumbprint}'`,
    `$ServerUnit = '${unit}'`,
    `$ServerAddress = '${script.address}'`,
    `$LegacyThumbprint = '${legacyCertificateThumbprint}'`,
    `$LegacyBody = '${legacyCertificateBody}'`,
    `$ZwiftHosts = ${zwiftHostNames.map((name) => `'${name}'`).join(', ')}`,
    "$CertificatePem = (@'",
    ...pemLines(script.pem),
    "'@) -replace \"`r\", ''",
    '',
    'function Find-ZwiftFolder {',
    '  $candidates = @()',
    String.raw`  foreach ($key in 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*') {`,
    "    $candidates += Get-ItemProperty $key -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'Zwift*' -and $_.InstallLocation } | ForEach-Object { $_.InstallLocation }",
    '  }',
    '  $candidates += "${env:ProgramFiles(x86)}\\Zwift", "$env:ProgramFiles\\Zwift"',
    '  foreach ($folder in $candidates) {',
    String.raw`    if ($folder -and (Test-Path -LiteralPath (Join-Path $folder 'data\cacert.pem'))) { return $folder }`,
    '  }',
    '  $shell = New-Object -ComObject Shell.Application',
    '  while ($true) {',
    '    $picked = $shell.BrowseForFolder(0, ' + psQuote(t('setup_zwift_folder_prompt')) + ', 0, 0)',
    '    if (-not $picked) { return $null }',
    '    $folder = $picked.Self.Path',
    String.raw`    if (Test-Path -LiteralPath (Join-Path $folder 'data\cacert.pem')) { return $folder }`,
    '  }',
    '}',
    '',
    'try {',
    '  Write-Host ' + psQuote(t('zluggish_client_setup')),
    "  Write-Host ''",
    '',
    '  Write-Host ' + psQuote(t('windows_certificate_store')),
    "  $body = ($CertificatePem -split \"`n\" | Where-Object { $_ -and $_ -notlike '-----*' }) -join ''",
    '  $certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new([Convert]::FromBase64String($body))',
    '  if ($certificate.Thumbprint -ne $Thumbprint) { throw ' + psQuote(t('client_setup_certificate_corrupt')) + ' }',
    "  $certificate.FriendlyName = 'Zluggish server certificate'",
    "  $store = [System.Security.Cryptography.X509Certificates.X509Store]::new('Root', 'LocalMachine')",
    "  $store.Open('ReadWrite')",
    '  try {',
    '    foreach ($old in @($store.Certificates)) {',
    '      $ours = $ServerUnit -and $old.Subject -like "*OU=$ServerUnit*"',
    '      if ($old.Thumbprint -ne $Thumbprint -and ($old.Thumbprint -eq $LegacyThumbprint -or $ours)) {',
    '        $store.Remove($old)',
    '        Write-Host (' + psQuote(t('removed_old_certificate', { value1: '{0}' })) + ' -f $($old.Thumbprint))',
    '      }',
    '    }',
    '    if (@($store.Certificates | Where-Object { $_.Thumbprint -eq $Thumbprint }).Count -eq 0) {',
    '      $store.Add($certificate)',
    '      Write-Host (' + psQuote(t('added_certificate', { value1: '{0}' })) + ' -f $Thumbprint)',
    '    } else { Write-Host ' + psQuote(t('client_setup_certificate_already_trusted')) + ' }',
    '  } finally { $store.Close() }',
    '',
    "  Write-Host ''",
    '  Write-Host ' + psQuote(t('zwift_certificate_list')),
    '  $folder = Find-ZwiftFolder',
    '  if (-not $folder) { throw ' + psQuote(t('client_setup_windows_zwift_missing')) + ' }',
    String.raw`  $bundle = Join-Path $folder 'data\cacert.pem'`,
    '  if (-not (Test-Path -LiteralPath "$bundle.zluggish-backup")) { Copy-Item -LiteralPath $bundle -Destination "$bundle.zluggish-backup" }',
    '  $text = [IO.File]::ReadAllText($bundle) -replace "`r", \'\'',
    String.raw`  $text = [regex]::Replace($text, '(?ms)^# BEGIN Zluggish.*?^# END Zluggish[^\n]*\n?', '')`,
    String.raw`  $text = [regex]::Replace($text, '(?s)-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----\n?', '')`,
    String.raw`  $text = [regex]::Replace($text, '(?s)-----BEGIN CERTIFICATE-----\n' + [regex]::Escape($LegacyBody) + '.*?-----END CERTIFICATE-----\n?', '')`,
    '  $text = $text.TrimEnd() + "`n`n# BEGIN Zluggish server certificate $Thumbprint`n$($CertificatePem.Trim())`n# END Zluggish server certificate`n"',
    '  [IO.File]::WriteAllText($bundle, $text)',
    '  Write-Host (' + psQuote(t('updated', { value1: '{0}' })) + ' -f $bundle)',
    '',
    '  if ($ServerAddress) {',
    "    Write-Host ''",
    '    Write-Host ' + psQuote(t('hosts_file')),
    String.raw`    $hostsFile = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'`,
    '    if (-not (Test-Path -LiteralPath "$hostsFile.zluggish-backup")) { Copy-Item -LiteralPath $hostsFile -Destination "$hostsFile.zluggish-backup" }',
    String.raw`    $pattern = '(?i)(^|\s)(' + (($ZwiftHosts | ForEach-Object { [regex]::Escape($_) }) -join '|') + ')(\s|$)'`,
    '    $lines = @(Get-Content -LiteralPath $hostsFile | Where-Object { $_ -notmatch $pattern })',
    '    $lines += "$ServerAddress $($ZwiftHosts -join \' \')"',
    '    Set-Content -LiteralPath $hostsFile -Value $lines -Encoding ASCII',
    '    ipconfig /flushdns | Out-Null',
    '    Write-Host (' + psQuote(t('client_setup_hosts_updated', { value1: '{0}' })) + ' -f $ServerAddress)',
    '  }',
    '',
    '  Get-Process ZwiftLauncher -ErrorAction SilentlyContinue | Stop-Process -Force',
    "  Write-Host ''",
    '  Write-Host ' + psQuote(t('client_setup_success_hint')) + ' -ForegroundColor Green',
    '} catch {',
    "  Write-Host ''",
    '  Write-Host (' +
      psQuote(t('setup_failed', { value1: '{0}' })) +
      ' -f $($_.Exception.Message)) -ForegroundColor Red',
    '}',
    '',
  ].join('\r\n');
}

/** Shell variables, the switch to root and the certificate itself, checked against its thumbprint. */
function shellPrelude(script: SetupScript, name: string) {
  return [
    'set -eu',
    '',
    `THUMBPRINT='${script.certificate.thumbprint}'`,
    `NAME='${name}'`,
    `LEGACY_NAME='${legacyName}'`,
    `LEGACY_THUMBPRINT='${legacyCertificateThumbprint}'`,
    `SERVER_UNIT='${serverUnit(script.certificate) ?? ''}'`,
    `SERVER_ADDRESS='${script.address}'`,
    `ZWIFT_HOSTS='${zwiftHostNames.join(' ')}'`,
    `LEGACY_BODY='${legacyCertificateBody}'`,
    '',
    'if [ "$(id -u)" -ne 0 ]; then',
    '  echo ' + shQuote(t('client_setup_sudo_required')),
    '  exec sudo -- sh "$0" "$@"',
    'fi',
    '',
    'certificate() {',
    "  cat <<'PEM'",
    ...pemLines(script.pem),
    'PEM',
    '}',
    '',
    'if command -v openssl >/dev/null 2>&1; then',
    "  actual=$(certificate | openssl x509 -noout -fingerprint -sha1 | sed 's/.*=//; s/://g')",
    '  if [ "$actual" != "$THUMBPRINT" ]; then',
    '    echo ' + shQuote(t('client_setup_certificate_corrupt')) + ' >&2',
    '    exit 1',
    '  fi',
    'fi',
  ];
}

function shellBundles(notFound: Array<string>) {
  return [
    '# Drop earlier Zluggish blocks, private keys and the shared certificate; then add this certificate.',
    'update_bundle() {',
    '  [ -f "$1.zluggish-backup" ] || cp -p "$1" "$1.zluggish-backup"',
    '  kept=$(mktemp)',
    `  tr -d '\\r' < "$1" | awk -v legacy="$LEGACY_BODY" '`,
    '    function out(line) { while (blank > 0) { print ""; blank-- } print line }',
    '    /^# BEGIN Zluggish/ { skip = 1; next }',
    '    skip { if (/^# END Zluggish/) skip = 0; next }',
    '    /^-----BEGIN [A-Z ]*PRIVATE KEY-----$/ { key = 1; next }',
    '    key { if (/^-----END [A-Z ]*PRIVATE KEY-----$/) key = 0; next }',
    '    held != "" { if ($0 == legacy) { old = 1; held = ""; next } out(held); held = "" }',
    '    old { if ($0 == "-----END CERTIFICATE-----") old = 0; next }',
    '    $0 == "-----BEGIN CERTIFICATE-----" { held = $0; next }',
    '    /^$/ { blank++; next }',
    '    { out($0) }',
    `  ' > "$kept"`,
    '  {',
    '    cat "$kept"',
    String.raw`    printf '\n# BEGIN Zluggish server certificate %s\n' "$THUMBPRINT"`,
    '    certificate',
    "    echo '# END Zluggish server certificate'",
    '  } > "$1"',
    '  rm -f "${kept:?}"',
    '}',
    '',
    'echo',
    'echo ' + shQuote(t('zwift_certificate_list')),
    'bundles=$(mktemp)',
    'find_bundles "${1:-}" > "$bundles"',
    'found=0',
    'while IFS= read -r bundle; do',
    '  if [ -f "$bundle" ]; then',
    '    update_bundle "$bundle"',
    '    printf ' + shQuote(t('updated', { value1: '%s' }) + String.raw`\n`) + ' "$bundle"',
    '    found=$((found + 1))',
    '  else',
    '    printf ' + shQuote(t('setup_path_missing', { value1: '%s' }) + String.raw`\n`) + ' "$bundle"',
    '  fi',
    'done < "$bundles"',
    'rm -f "${bundles:?}"',
    'if [ "$found" -eq 0 ]; then',
    ...notFound,
    'fi',
  ];
}

function shellHosts(script: SetupScript, after: Array<string>) {
  if (!script.address) {
    return [];
  }

  return [
    '',
    'echo',
    'echo ' + shQuote(t('hosts_file')),
    '[ -f /etc/hosts.zluggish-backup ] || cp -p /etc/hosts /etc/hosts.zluggish-backup',
    'hosts=$(mktemp)',
    `awk -v names="$ZWIFT_HOSTS" 'BEGIN { n = split(names, list, " "); for (i = 1; i <= n; i++) drop[list[i]] = 1 }`,
    `  { for (i = 1; i <= NF; i++) if ($i in drop) next; print }' /etc/hosts > "$hosts"`,
    `printf '%s %s\\n' "$SERVER_ADDRESS" "$ZWIFT_HOSTS" >> "$hosts"`,
    'cat "$hosts" > /etc/hosts',
    'rm -f "${hosts:?}"',
    ...after,
    'printf ' + shQuote(t('client_setup_hosts_updated', { value1: '%s' }) + String.raw`\n`) + ' "$SERVER_ADDRESS"',
  ];
}

/** A POSIX shell script for Zwift in Wine, Lutris, Bottles or Steam on Linux. */
export function linuxSetupScript(script: SetupScript) {
  const unit = serverUnit(script.certificate);
  const name = `zluggish-zwift-${unit ? unit.slice('Zluggish server '.length) : script.certificate.thumbprint.slice(0, 12).toLowerCase()}`;

  return [
    '#!/bin/sh',
    '# ' + t('client_setup_linux_title'),
    ...header(script),
    '#',
    '# ' + t('client_setup_linux_run_hint'),
    '# ' + t('client_setup_linux_permission_hint'),
    '# ' + t('client_setup_linux_trust_step'),
    '# ' + t('client_setup_linux_zwift_certificate_step'),
    '# ' + t('client_setup_legacy_certificate_named_removal_hint'),
    ...(script.address ? [t('hosts_unix', { value1: script.address })] : []),
    ...shellPrelude(script, name),
    '',
    'TARGET_HOME=$(getent passwd "${SUDO_USER:-root}" | cut -d: -f6)',
    'TARGET_HOME=${TARGET_HOME:-$HOME}',
    '',
    'echo',
    'echo ' + shQuote(t('system_trust_store')),
    'install_anchor() {',
    '  # A server certificate replaces the shared one that an earlier setup installed.',
    '  rm -f "${1:?}/${LEGACY_NAME:?}.crt"',
    '  certificate > "$1/$NAME.crt"',
    '  shift',
    '  "$@" >/dev/null',
    '  printf ' + shQuote(t('added_certificate', { value1: '%s' }) + String.raw`\n`) + ' "$THUMBPRINT"',
    '}',
    'if [ -d /etc/pki/ca-trust/source/anchors ] && command -v update-ca-trust >/dev/null 2>&1; then',
    '  install_anchor /etc/pki/ca-trust/source/anchors update-ca-trust extract',
    'elif [ -d /etc/ca-certificates/trust-source/anchors ] && command -v update-ca-trust >/dev/null 2>&1; then',
    '  install_anchor /etc/ca-certificates/trust-source/anchors update-ca-trust',
    'elif [ -d /etc/pki/trust/anchors ] && command -v update-ca-certificates >/dev/null 2>&1; then',
    '  install_anchor /etc/pki/trust/anchors update-ca-certificates',
    'elif [ -d /usr/local/share/ca-certificates ] && command -v update-ca-certificates >/dev/null 2>&1; then',
    '  install_anchor /usr/local/share/ca-certificates update-ca-certificates',
    'else',
    '  echo ' + shQuote(t('client_setup_trust_store_unavailable')),
    'fi',
    '',
    'find_bundles() {',
    '  if [ -n "${1:-}" ]; then',
    `    printf '%s\\n' "$1/data/cacert.pem"`,
    '    return',
    '  fi',
    '  for root in "$TARGET_HOME/.wine" "$TARGET_HOME/Games" "$TARGET_HOME/.local/share/lutris" \\',
    '    "$TARGET_HOME/.local/share/bottles" "$TARGET_HOME/.var/app" "$TARGET_HOME/.steam" "$TARGET_HOME/.local/share/Steam"; do',
    '    if [ -d "$root" ]; then find "$root" -maxdepth 10 -path \'*/drive_c/*/Zwift/data/cacert.pem\' -type f 2>/dev/null || true; fi',
    '  done | sort -u',
    '}',
    '',
    ...shellBundles([
      '  echo ' + shQuote(t('client_setup_linux_zwift_missing')),
      `  echo "  sh $0 \\"$TARGET_HOME/.wine/drive_c/Program Files (x86)/Zwift\\""`,
    ]),
    ...shellHosts(script, []),
    '',
    'echo',
    'echo ' + shQuote(t('client_setup_linux_success_hint')),
    '',
  ].join('\n');
}

/** A POSIX shell script for Zwift on macOS. It trusts the certificate in the System keychain, for TLS only. */
export function macosSetupScript(script: SetupScript) {
  return [
    '#!/bin/sh',
    '# ' + t('client_setup_macos_title'),
    ...header(script),
    '#',
    '# ' + t('client_setup_macos_run_hint'),
    '# ' + t('client_setup_macos_permission_hint'),
    '# ' + t('client_setup_macos_trust_step'),
    '# ' + t('client_setup_certificate_replacement_hint'),
    '# ' + t('client_setup_macos_zwift_certificate_step'),
    '# ' + t('client_setup_legacy_certificate_removal_hint'),
    ...(script.address ? [t('hosts_unix', { value1: script.address })] : []),
    ...shellPrelude(script, setupFileName(script.certificate, 'pem').slice(0, -'.pem'.length)),
    '',
    `TARGET_HOME=$(dscl . -read "/Users/\${SUDO_USER:-root}" NFSHomeDirectory 2>/dev/null | sed 's/^NFSHomeDirectory: *//')`,
    'TARGET_HOME=${TARGET_HOME:-$HOME}',
    'KEYCHAIN=/Library/Keychains/System.keychain',
    '',
    'echo',
    'echo ' + shQuote(t('system_keychain')),
    'work=$(mktemp -d)',
    '# Each *.zwift.com certificate in the keychain, in a file named after its SHA-1 hash.',
    `{ security find-certificate -a -c '*.zwift.com' -Z -p "$KEYCHAIN" 2>/dev/null || true; } | awk -v dir="$work" '`,
    '  /^SHA-1 hash:/ { file = dir "/" $3 ".old"; next }',
    '  file != "" { print > file }',
    '  /^-----END CERTIFICATE-----$/ { if (file != "") close(file); file = "" }',
    `'`,
    'for old in "$work"/*.old; do',
    '  [ -f "$old" ] || continue',
    '  hash=${old##*/}',
    '  hash=${hash%.old}',
    '  [ "$hash" != "$THUMBPRINT" ] || continue',
    '  subject=$(openssl x509 -noout -subject -in "$old" 2>/dev/null || true)',
    '  remove=0',
    '  if [ "$hash" = "$LEGACY_THUMBPRINT" ]; then remove=1; fi',
    '  if [ -n "$SERVER_UNIT" ]; then',
    '    case "$subject" in *"$SERVER_UNIT"*) remove=1 ;; esac',
    '  fi',
    '  if [ "$remove" -eq 1 ]; then',
    '    security delete-certificate -Z "$hash" "$KEYCHAIN" >/dev/null',
    '    printf ' + shQuote(t('removed_certificate', { value1: '%s' }) + String.raw`\n`) + ' "$hash"',
    '  fi',
    'done',
    'certificate > "$work/$NAME.pem"',
    'if ! security add-trusted-cert -d -r trustRoot -p ssl -k "$KEYCHAIN" "$work/$NAME.pem"; then',
    '  rm -rf "${work:?}"',
    '  echo ' + shQuote(t('client_setup_macos_trust_failed')) + ' >&2',
    '  exit 1',
    'fi',
    'rm -rf "${work:?}"',
    'printf ' + shQuote(t('trusted_certificate', { value1: '%s' }) + String.raw`\n`) + ' "$THUMBPRINT"',
    '',
    'find_bundles() {',
    '  if [ -n "${1:-}" ]; then',
    `    printf '%s\\n' "$1/data/cacert.pem"`,
    '  else',
    `    printf '%s\\n' "$TARGET_HOME/Library/Application Support/Zwift/data/cacert.pem"`,
    '  fi',
    '}',
    '',
    ...shellBundles([
      '  echo ' + shQuote(t('client_setup_macos_zwift_missing')),
      `  echo "  sh $0 \\"$TARGET_HOME/Library/Application Support/Zwift\\""`,
    ]),
    ...shellHosts(script, [
      'dscacheutil -flushcache 2>/dev/null || true',
      'killall -HUP mDNSResponder 2>/dev/null || true',
    ]),
    '',
    'echo',
    'echo ' + shQuote(t('client_setup_desktop_success_hint')),
    '',
  ].join('\n');
}
